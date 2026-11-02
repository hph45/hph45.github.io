begin;

-- Add review summaries to the existing admin request; no public endpoint or polling.
-- The existing server-owned allowlist remains the only source of authorization.
create or replace function public.get_matchmaking_admin_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.matchmaking_admin_access a where a.user_id = (select auth.uid())
  ) then
    raise exception using errcode = '42501', message = 'ADMIN_ONLY';
  end if;

  -- Keep the entire response in one database snapshot. These are aggregates of
  -- completed profiles, including paused members, never individual records.
  return (
    with members as (
      select extract(year from age(current_date, p.birth_date))::integer as age,
        case when 'romance' = any(p.intents) then p.gender else null end as gender,
        p.city_id, p.is_active, p.intents
      from public.matchmaking_profiles p
    ), age_bands (position, label, minimum, maximum) as (
      values (1, '18–24', 18, 24), (2, '25–34', 25, 34), (3, '35–44', 35, 44),
        (4, '45–54', 45, 54), (5, '55–64', 55, 64), (6, '65–79', 65, 79),
        (7, '80+', 80, null::integer)
    ), gender_choices (position, key, label) as (
      values (1, 'woman', 'Woman'), (2, 'man', 'Man'), (3, 'other', 'Other'),
        (4, 'not_provided', 'Not provided')
    ), connection_choices (position, key, label) as (
      values (1, 'romance', 'Romance'), (2, 'friends', 'Friends'),
        (3, 'business_partners', 'Business partners')
    ), city_counts as (
      select c.id, c.name, c.region, c.country, c.latitude, c.longitude, count(*) as member_count
      from members m join public.matchmaking_cities c on c.id = m.city_id
      group by c.id
    ), country_counts as (
      select country, sum(member_count)::bigint as member_count
      from city_counts group by country
    ), reviews as materialized (
      select r.match_id, r.user_id, r.compatibility_rating, r.book_rating
      from public.matchmaking_match_reviews r
      join public.matchmaking_matches m on m.id = r.match_id
      where m.released_at <= now()
        and (select count(*) from public.matchmaking_match_members mm where mm.match_id = m.id) = 2
    ), compatibility_counts as (
      select compatibility_rating as rating, count(*) as review_count from reviews group by compatibility_rating
    ), book_counts as (
      select book_rating as rating, count(*) as review_count from reviews where book_rating is not null group by book_rating
    )
    select jsonb_build_object(
      'generated_at', statement_timestamp(),
      'reviews', (
        select jsonb_build_object(
          'total_reviews', count(*),
          'reviewers', count(distinct user_id),
          'reviewed_matches', count(distinct match_id),
          'compatibility', jsonb_build_object(
            'total', count(compatibility_rating),
            'average', round(avg(compatibility_rating), 2),
            'distribution', (select jsonb_agg(jsonb_build_object('rating', ratings.rating,
              'review_count', coalesce(c.review_count, 0)) order by ratings.rating)
              from generate_series(1, 5) as ratings(rating)
              left join compatibility_counts c using (rating))
          ),
          'book', jsonb_build_object(
            'total', count(book_rating),
            'average', round(avg(book_rating), 2),
            'distribution', (select jsonb_agg(jsonb_build_object('rating', ratings.rating,
              'review_count', coalesce(c.review_count, 0)) order by ratings.rating)
              from generate_series(1, 5) as ratings(rating)
              left join book_counts c using (rating))
          )
        ) from reviews
      ),
      'total_members', (select count(*) from members),
      'active_members', (select count(*) from members where is_active),
      'median_age', (select percentile_cont(0.5) within group (order by age) from members),
      'city_count', (select count(*) from city_counts),
      'country_count', (select count(*) from country_counts),
      'age_groups', (
        select jsonb_agg(jsonb_build_object('label', label, 'member_count', member_count) order by position)
        from (
          select b.position, b.label, count(m.age) as member_count
          from age_bands b left join members m on m.age >= b.minimum and (b.maximum is null or m.age <= b.maximum)
          group by b.position, b.label
        ) counts
      ),
      'genders', (
        select jsonb_agg(jsonb_build_object('key', key, 'label', label, 'member_count', member_count) order by position)
        from (
          select g.position, g.key, g.label, count(m.age) as member_count
          from gender_choices g left join members m on coalesce(m.gender, 'not_provided') = g.key
          group by g.position, g.key, g.label
        ) counts
      ),
      'connection_types', (
        select jsonb_agg(jsonb_build_object('key', key, 'label', label, 'member_count', member_count) order by position)
        from (
          select c.position, c.key, c.label, count(m.age) as member_count
          from connection_choices c left join members m on c.key = any(m.intents)
          group by c.position, c.key, c.label
        ) counts
      ),
      'cities', coalesce((
        select jsonb_agg(to_jsonb(c) order by c.member_count desc, c.name, c.country, c.id) from city_counts c
      ), '[]'::jsonb),
      'countries', coalesce((
        select jsonb_agg(to_jsonb(c) order by c.member_count desc, c.country) from country_counts c
      ), '[]'::jsonb)
    )
  );
end;
$$;
revoke all on function public.get_matchmaking_admin_stats() from public, anon, authenticated;
grant execute on function public.get_matchmaking_admin_stats() to authenticated;
comment on function public.get_matchmaking_admin_stats() is
  'Admin-only profile demographics and all-time review distributions. Checks the server-managed Auth user ID before returning aggregates; never returns personal records.';


notify pgrst, 'reload schema';
commit;
