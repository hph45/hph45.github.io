begin;
create index matchmaking_profile_city on public.matchmaking_profiles(city_id);

-- Anonymous city totals and book totals only. No account IDs, names, dates of
-- birth, emails, or links from a map dot to a person's profile are returned.
create function public.get_matchmaking_community()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'total_members', (select count(*) from public.matchmaking_profiles),
    'cities', coalesce((
      select jsonb_agg(to_jsonb(city_counts)) from (
        select c.id, c.name, c.region, c.country, c.latitude, c.longitude, count(*) as member_count
        from public.matchmaking_profiles p join public.matchmaking_cities c on c.id = p.city_id
        group by c.id order by c.id
      ) city_counts
    ), '[]'::jsonb),
    'top_books', coalesce((
      select jsonb_agg(to_jsonb(ranked)) from (
        select b.work_id, b.title, b.author, count(distinct p.user_id) as votes
        from public.matchmaking_profiles p
        cross join lateral (values (p.favorite_book_id), (p.favorite_book_2_id), (p.favorite_book_3_id)) picks(work_id)
        join public.matchmaking_books b on b.work_id = picks.work_id
        group by b.work_id order by votes desc, b.title, b.work_id limit 10
      ) ranked
    ), '[]'::jsonb)
  );
$$;
revoke all on function public.get_matchmaking_community() from public, anon, authenticated;
grant execute on function public.get_matchmaking_community() to authenticated;
commit;
