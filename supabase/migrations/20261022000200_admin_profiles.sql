begin;

-- Connection counts overlap when a member selects multiple types.
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
    )
    select jsonb_build_object(
      'generated_at', statement_timestamp(),
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
  'Admin-only profile demographics. Checks the server-managed Auth user ID before returning aggregates; never returns personal records.';


-- A separate, paginated endpoint for the owner to review current profile
-- answers. Its authorization is independent of the statistics endpoint.
create function public.get_matchmaking_admin_profiles(
  p_search text default '',
  p_intent text default null,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_search text := lower(left(btrim(coalesce(p_search, '')), 200));
  v_intent text := nullif(p_intent, '');
  v_limit integer := least(50, greatest(1, coalesce(p_page_size, 20)));
begin
  if not exists (
    select 1 from public.matchmaking_admin_access a where a.user_id = (select auth.uid())
  ) then
    raise exception using errcode = '42501', message = 'ADMIN_ONLY';
  end if;
  if v_intent is not null and v_intent not in ('romance', 'friends', 'business_partners') then
    raise exception using errcode = '22023', message = 'INVALID_CONNECTION_TYPE';
  end if;

  return (
    with filtered as materialized (
      select p.* from public.matchmaking_profiles p
      where (v_intent is null or v_intent = any(p.intents))
        and (v_search = '' or strpos(lower(concat_ws(' ', p.display_name, p.city, p.region, p.country,
          p.favorite_book, p.favorite_author, p.favorite_book_2, p.favorite_author_2,
          p.favorite_book_3, p.favorite_author_3)), v_search) > 0)
    ), totals as (
      select count(*) as total_count from filtered
    ), pagination as (
      select total_count,
        least(greatest(1, coalesce(p_page, 1)), greatest(1, ceil(total_count::numeric / v_limit)::integer)) as page
      from totals
    ), page_profiles as (
      select p.* from filtered p
      order by p.created_at desc, p.user_id
      limit v_limit offset (select (page::bigint - 1) * v_limit from pagination)
    ), profiles as (
      select p.created_at, p.user_id, jsonb_build_object(
        'display_name', p.display_name,
        'age', extract(year from age(current_date, p.birth_date))::integer,
        'city', p.city, 'region', p.region, 'country', p.country,
        'intents', p.intents,
        'is_active', p.is_active, 'email_matches', p.email_matches,
        'location_preference', p.location_preference,
        'favorite_books', (
          select jsonb_agg(jsonb_build_object('title', title, 'author', author) order by position)
          from (values (1, p.favorite_book_id, p.favorite_book, p.favorite_author),
            (2, p.favorite_book_2_id, p.favorite_book_2, p.favorite_author_2),
            (3, p.favorite_book_3_id, p.favorite_book_3, p.favorite_author_3)) books(position, work_id, title, author)
          where work_id is not null
        ),
        'gender', case when 'romance' = any(p.intents) then p.gender else null end,
        'interested_in', case when 'romance' = any(p.intents) then p.interested_in else array[]::text[] end,
        'age_min', case when 'romance' = any(p.intents) then p.age_min else null end,
        'age_max', case when 'romance' = any(p.intents) then p.age_max else null end,
        'romance_ideal_match', case when 'romance' = any(p.intents) then p.romance_ideal_match else '' end,
        'friendship_interests', case when 'friends' = any(p.intents) then p.friendship_interests else '' end,
        'business_about', case when 'business_partners' = any(p.intents) then p.business_about else '' end,
        'business_skills', case when 'business_partners' = any(p.intents) then p.business_skills else '' end,
        'business_seeking', case when 'business_partners' = any(p.intents) then p.business_seeking else '' end,
        'business_linkedin_url', case when 'business_partners' = any(p.intents) then p.business_linkedin_url else '' end
      ) as profile
      from page_profiles p
    )
    select jsonb_build_object(
      'total_count', total_count, 'page', page, 'page_size', v_limit,
      'profiles', coalesce((select jsonb_agg(profile order by created_at desc, user_id) from profiles), '[]'::jsonb)
    ) from pagination
  );
end;
$$;
revoke all on function public.get_matchmaking_admin_profiles(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.get_matchmaking_admin_profiles(text, text, integer, integer) to authenticated;
comment on function public.get_matchmaking_admin_profiles(text, text, integer, integer) is
  'Owner-only review of current profiles, books, and selected connection answers. Checks the admin Auth ID on every page request. Does not return birthdays, emails, Auth IDs, or retired answers.';

commit;
