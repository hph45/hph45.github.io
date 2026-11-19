begin;

-- Extend the existing admin-only snapshot without adding public endpoints.
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
        p.city_id, p.is_active, p.intents, p.created_at
      from public.matchmaking_nonreview_profiles p
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
    ), released_matches as materialized (
      select m.id, m.week_start, m.released_at
      from public.matchmaking_matches m
      where m.released_at <= now()
        and (select count(*) from public.matchmaking_match_members mm where mm.match_id = m.id) = 2
        and not exists (
          select 1 from public.matchmaking_match_members mm
          join public.matchmaking_review_accounts a using (user_id) where mm.match_id = m.id
        )
    ), rounds as (
      -- Supplemental introductions stay in the original round. Only a new
      -- released week creates a new bar/tab; drafts and fixture pairs do not.
      select week_start, min(released_at) as first_released_at,
        row_number() over (order by week_start) as round_number
      from released_matches group by week_start
    ), reviews as materialized (
      select r.match_id, r.user_id, r.compatibility_rating, r.book_rating, m.week_start
      from public.matchmaking_nonreview_reviews r
      join released_matches m on m.id = r.match_id
    ), review_scopes as (
      select null::date as week_start union all select week_start from rounds
    ), review_totals as (
      select s.week_start, count(r.match_id) as total_reviews,
        count(distinct r.user_id) as reviewers, count(distinct r.match_id) as reviewed_matches,
        round(avg(r.compatibility_rating), 1) as compatibility_average,
        count(r.book_rating) as book_total, round(avg(r.book_rating), 1) as book_average
      from review_scopes s left join reviews r on s.week_start is null or r.week_start = s.week_start
      group by s.week_start
    ), rating_counts as (
      select s.week_start, ratings.rating,
        count(*) filter (where r.compatibility_rating = ratings.rating) as compatibility_count,
        count(*) filter (where r.book_rating = ratings.rating) as book_count
      from review_scopes s cross join generate_series(1, 5) as ratings(rating)
      left join reviews r on s.week_start is null or r.week_start = s.week_start
      group by s.week_start, ratings.rating
    ), review_summaries as (
      select t.week_start, jsonb_build_object(
        'total_reviews', t.total_reviews, 'reviewers', t.reviewers, 'reviewed_matches', t.reviewed_matches,
        'compatibility', jsonb_build_object(
          'total', t.total_reviews, 'average', t.compatibility_average,
          'distribution', (select jsonb_agg(jsonb_build_object('rating', c.rating,
            'review_count', c.compatibility_count) order by c.rating) from rating_counts c
            where c.week_start is not distinct from t.week_start)
        ),
        'book', jsonb_build_object(
          'total', t.book_total, 'average', t.book_average,
          'distribution', (select jsonb_agg(jsonb_build_object('rating', c.rating,
            'review_count', c.book_count) order by c.rating) from rating_counts c
            where c.week_start is not distinct from t.week_start)
        )
      ) as summary from review_totals t
    )
    select jsonb_build_object(
      'generated_at', statement_timestamp(),
      'reviews', (select summary from review_summaries where week_start is null),
      'rounds', coalesce((
        select jsonb_agg(jsonb_build_object(
          'round_number', r.round_number, 'week_start', r.week_start,
          'first_released_at', r.first_released_at,
          -- Reconstructed from retained completed profiles, including paused
          -- accounts. Deleted accounts cannot be recovered from this source.
          'account_count', (select count(*) from members p where p.created_at <= r.first_released_at),
          'reviews', s.summary
        ) order by r.week_start)
        from rounds r join review_summaries s using (week_start)
      ), '[]'::jsonb),
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
      'countries', public.matchmaking_country_stats()
    )
  );
end;
$$;
revoke all on function public.get_matchmaking_admin_stats() from public, anon, authenticated;
grant execute on function public.get_matchmaking_admin_stats() to authenticated;
comment on function public.get_matchmaking_admin_stats() is
  'Admin-only profile demographics, completed-account counts by released round, and all-time/per-round review distributions. Checks the server-managed Auth user ID before returning aggregates; never returns personal records.';

notify pgrst, 'reload schema';
commit;
