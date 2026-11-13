begin;

-- Explicit operator provisioning only. Email addresses, user metadata, client
-- flags, and the app build configuration never grant review-account status.
create table public.matchmaking_review_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  cohort_id uuid not null,
  created_at timestamptz not null default now()
);
create index matchmaking_review_cohort on public.matchmaking_review_accounts(cohort_id, user_id);
alter table public.matchmaking_review_accounts enable row level security;
revoke all on public.matchmaking_review_accounts from public, anon, authenticated, service_role;
grant select, insert on public.matchmaking_review_accounts to service_role;

create function public.matchmaking_review_pair_separated(first_id uuid, second_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select cohort_id from public.matchmaking_review_accounts where user_id = first_id)
    is distinct from
    (select cohort_id from public.matchmaking_review_accounts where user_id = second_id);
$$;
revoke all on function public.matchmaking_review_pair_separated(uuid, uuid) from public, anon, authenticated;

-- All existing introduction reads, reveal calls, and block/release guards use
-- this private predicate. Preserve actual member blocks and additionally deny
-- cross-cohort visibility, without changing any contact/consent projection.
create or replace function public.matchmaking_pair_blocked(first_id uuid, second_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.matchmaking_review_pair_separated(first_id, second_id)
    or exists (select 1 from public.matchmaking_member_blocks b
      where (b.blocker_id = first_id and b.blocked_id = second_id)
         or (b.blocker_id = second_id and b.blocked_id = first_id));
$$;
revoke all on function public.matchmaking_pair_blocked(uuid, uuid) from public, anon, authenticated;

create function public.guard_matchmaking_review_registry()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception using errcode = '42501', message = 'REVIEW_REGISTRY_IMMUTABLE';
  elsif tg_op = 'DELETE' then
    -- Auth deletion may cascade. Removing only this registry row must not turn a
    -- live fixture into a normal matchmaking participant.
    if exists (select 1 from auth.users where id = old.user_id) then
      raise exception using errcode = '42501', message = 'REVIEW_REGISTRY_IMMUTABLE';
    end if;
    return old;
  elsif tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id or new.cohort_id is distinct from old.cohort_id then
      raise exception using errcode = '42501', message = 'REVIEW_REGISTRY_IMMUTABLE';
    end if;
    return new;
  end if;
  if exists (select 1 from public.matchmaking_admin_access where user_id = new.user_id) then
    raise exception using errcode = '42501', message = 'REVIEW_ACCOUNT_IS_ADMIN';
  end if;
  if exists (
    select 1 from public.matchmaking_match_members mine
    join public.matchmaking_match_members theirs on theirs.match_id = mine.match_id and theirs.user_id <> mine.user_id
    left join public.matchmaking_review_accounts other on other.user_id = theirs.user_id
    where mine.user_id = new.user_id and other.cohort_id is distinct from new.cohort_id
  ) then
    raise exception using errcode = '23514', message = 'REVIEW_ACCOUNT_HAS_OUTSIDE_MATCHES';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_matchmaking_review_registry() from public, anon, authenticated;
create trigger matchmaking_review_registry_guard before insert or update or delete on public.matchmaking_review_accounts
  for each row execute function public.guard_matchmaking_review_registry();
create trigger matchmaking_review_registry_no_truncate before truncate on public.matchmaking_review_accounts
  for each statement execute function public.guard_matchmaking_review_registry();

create function public.guard_matchmaking_review_pair()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Registry INSERT/UPDATE/DELETE obtains a conflicting ROW EXCLUSIVE lock.
  -- Rechecking after this lock serializes registration with matching writes;
  -- concurrent ordinary pairing transactions can still share this lock.
  lock table public.matchmaking_review_accounts in share mode;
  if tg_table_name = 'matchmaking_matches' then
    if new.released_at is not null and exists (
      select 1 from public.matchmaking_match_members a
      join public.matchmaking_match_members b on b.match_id = a.match_id and b.user_id <> a.user_id
      where a.match_id = new.id and public.matchmaking_review_pair_separated(a.user_id, b.user_id)
    ) then raise exception using errcode = '23514', message = 'REVIEW_ACCOUNT_ISOLATION'; end if;
  else
    if exists (select 1 from public.matchmaking_match_members other
      where other.match_id = new.match_id and other.user_id <> new.user_id
        and public.matchmaking_review_pair_separated(new.user_id, other.user_id)) then
      raise exception using errcode = '23514', message = 'REVIEW_ACCOUNT_ISOLATION';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_matchmaking_review_pair() from public, anon, authenticated;
-- Run before the existing safety and release validators; those still apply.
create trigger matchmaking_00_review_release before insert or update on public.matchmaking_matches
  for each row execute function public.guard_matchmaking_review_pair();
create trigger matchmaking_00_review_members before insert or update of match_id, user_id on public.matchmaking_match_members
  for each row execute function public.guard_matchmaking_review_pair();

-- Private sources keep fixture accounts out of the public map, member counts,
-- country favorites, top ten, recent favorites, and admin aggregate statistics.
-- The privileged matching worker can use nonreview_profiles for its candidates.
create view public.matchmaking_nonreview_profiles with (security_invoker = true) as
  select p.* from public.matchmaking_profiles p
  where not exists (select 1 from public.matchmaking_review_accounts r where r.user_id = p.user_id);
create view public.matchmaking_nonreview_favorites with (security_invoker = true) as
  select f.* from public.matchmaking_favorite_selections f
  where not exists (select 1 from public.matchmaking_review_accounts r where r.user_id = f.user_id);
create view public.matchmaking_nonreview_reviews with (security_invoker = true) as
  select f.* from public.matchmaking_match_reviews f
  where not exists (select 1 from public.matchmaking_review_accounts r where r.user_id = f.user_id);
revoke all on public.matchmaking_nonreview_profiles, public.matchmaking_nonreview_favorites, public.matchmaking_nonreview_reviews
  from public, anon, authenticated, service_role;
grant select on public.matchmaking_nonreview_profiles, public.matchmaking_nonreview_favorites, public.matchmaking_nonreview_reviews to service_role;

create function public.invalidate_matchmaking_review_aggregates()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.matchmaking_rising_snapshot set refreshed_at = null where singleton;
  update public.matchmaking_public_map_cache set refreshed_at = '-infinity'::timestamptz where id;
  return null;
end;
$$;
revoke all on function public.invalidate_matchmaking_review_aggregates() from public, anon, authenticated;
create trigger matchmaking_review_aggregate_invalidation after insert or delete on public.matchmaking_review_accounts
  for each statement execute function public.invalidate_matchmaking_review_aggregates();

-- Original aggregate algorithms and cache lifetimes, using the filtered sources.
create or replace function public.matchmaking_country_stats()
returns jsonb language sql stable security invoker set search_path = '' as $$
  with members as materialized (
    select p.user_id, c.country, p.favorite_book_id, p.favorite_book_2_id, p.favorite_book_3_id
    from public.matchmaking_nonreview_profiles p join public.matchmaking_cities c on c.id = p.city_id
  ), totals as (
    select country, count(*) as member_count from members group by country
  ), votes as (
    select p.country, b.work_id, b.title, b.author, count(distinct p.user_id) as votes
    from members p
    cross join lateral (values (p.favorite_book_id), (p.favorite_book_2_id), (p.favorite_book_3_id)) picks(work_id)
    join public.matchmaking_books b on b.work_id = picks.work_id
    group by p.country, b.work_id
  ), ranked as (
    select votes.*, row_number() over (partition by country order by votes desc, title, work_id) as position
    from votes
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'country', t.country, 'member_count', t.member_count,
    'top_book', case when b.work_id is null then null else jsonb_build_object(
      'work_id', b.work_id, 'title', b.title, 'author', b.author, 'votes', b.votes
    ) end
  ) order by t.member_count desc, t.country), '[]'::jsonb)
  from totals t left join ranked b on b.country = t.country and b.position = 1;
$$;
revoke all on function public.matchmaking_country_stats() from public, anon, authenticated;
grant execute on function public.matchmaking_country_stats() to service_role;
comment on function public.matchmaking_country_stats() is
  'Internal country totals and top favorites, including paused profiles. One vote per member per book across all three favorites. Ties use title then work ID. No personal identifiers; browser roles cannot call directly.';

create or replace function public.get_matchmaking_community()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  snapshot_time timestamptz;
  snapshot_rankings jsonb;
  top_books jsonb;
begin
  select s.refreshed_at, s.rankings into snapshot_time, snapshot_rankings
  from public.matchmaking_rising_snapshot s where s.singleton;

  if snapshot_time is null or snapshot_time <= now() - interval '48 hours' then
    -- Recheck under a row lock so simultaneous requests share one refresh.
    select s.refreshed_at, s.rankings into snapshot_time, snapshot_rankings
    from public.matchmaking_rising_snapshot s where s.singleton for update;
    if snapshot_time is null or snapshot_time <= now() - interval '48 hours' then
      snapshot_time := now();
      select coalesce(jsonb_agg(to_jsonb(ranked) order by ranked.votes desc, ranked.title, ranked.work_id), '[]'::jsonb)
      into snapshot_rankings from (
        select b.work_id, b.title, count(*) as votes
        from public.matchmaking_nonreview_favorites f
        join public.matchmaking_books b on b.work_id = f.work_id
        where f.added_at >= snapshot_time - interval '7 days' and f.added_at <= snapshot_time
        group by b.work_id
      ) ranked;
      update public.matchmaking_rising_snapshot
      set refreshed_at = snapshot_time, rankings = snapshot_rankings where singleton;
    end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(ranked) order by ranked.votes desc, ranked.title, ranked.work_id), '[]'::jsonb)
  into top_books from (
    select b.work_id, b.title, b.author, count(distinct p.user_id) as votes
    from public.matchmaking_nonreview_profiles p
    cross join lateral (values (p.favorite_book_id), (p.favorite_book_2_id), (p.favorite_book_3_id)) picks(work_id)
    join public.matchmaking_books b on b.work_id = picks.work_id
    group by b.work_id order by votes desc, b.title, b.work_id limit 10
  ) ranked;

  return jsonb_build_object(
    'total_members', (select count(*) from public.matchmaking_nonreview_profiles),
    'countries', public.matchmaking_country_stats(),
    'cities', coalesce((
      select jsonb_agg(to_jsonb(city_counts)) from (
        select c.id, c.name, c.region, c.country, c.latitude, c.longitude, count(*) as member_count
        from public.matchmaking_nonreview_profiles p join public.matchmaking_cities c on c.id = p.city_id
        group by c.id order by c.id
      ) city_counts
    ), '[]'::jsonb),
    'top_books', top_books,
    'rising_books', coalesce((
      select jsonb_agg(ranked.book order by ranked.rank) from (
        select jsonb_build_object('work_id', b.work_id, 'title', b.title, 'author', b.author) as book, candidate.rank
        from jsonb_array_elements(snapshot_rankings) with ordinality candidate(book, rank)
        join public.matchmaking_books b on b.work_id = candidate.book->>'work_id'
        where not exists (select 1 from jsonb_array_elements(top_books) top_book where top_book->>'work_id' = b.work_id)
          and exists (select 1 from public.matchmaking_nonreview_favorites f where f.work_id = b.work_id)
        order by candidate.rank limit 2
      ) ranked
    ), '[]'::jsonb),
    'rising_refreshed_at', snapshot_time
  );
end;
$$;
revoke all on function public.get_matchmaking_community() from public, anon, authenticated;
grant execute on function public.get_matchmaking_community() to authenticated;


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
    ), reviews as materialized (
      select r.match_id, r.user_id, r.compatibility_rating, r.book_rating
      from public.matchmaking_nonreview_reviews r
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
            'average', round(avg(compatibility_rating), 1),
            'distribution', (select jsonb_agg(jsonb_build_object('rating', ratings.rating,
              'review_count', coalesce(c.review_count, 0)) order by ratings.rating)
              from generate_series(1, 5) as ratings(rating)
              left join compatibility_counts c using (rating))
          ),
          'book', jsonb_build_object(
            'total', count(book_rating),
            'average', round(avg(book_rating), 1),
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
      'countries', public.matchmaking_country_stats()
    )
  );
end;
$$;
revoke all on function public.get_matchmaking_admin_stats() from public, anon, authenticated;
grant execute on function public.get_matchmaking_admin_stats() to authenticated;
comment on function public.get_matchmaking_admin_stats() is
  'Admin-only profile demographics and all-time review distributions. Checks the server-managed Auth user ID before returning aggregates; never returns personal records.';



create or replace function public.get_public_matchmaking_map()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_payload jsonb;
  v_refreshed_at timestamptz;
begin
  select payload, refreshed_at into v_payload, v_refreshed_at
    from public.matchmaking_public_map_cache where id;
  if v_refreshed_at > now() - interval '1 hour' then return v_payload; end if;

  -- Only one visitor rebuilds an expired snapshot. Concurrent visitors recheck
  -- the timestamp after acquiring the row lock and reuse the refreshed result.
  select payload, refreshed_at into v_payload, v_refreshed_at
    from public.matchmaking_public_map_cache where id for update;
  if v_refreshed_at > now() - interval '1 hour' then return v_payload; end if;

  v_refreshed_at := clock_timestamp();
  with city_counts as (
    select c.id, c.name, c.region, c.country, c.latitude, c.longitude,
      count(*) as member_count
    from public.matchmaking_nonreview_profiles p
    join public.matchmaking_cities c on c.id = p.city_id
    group by c.id
  )
  select jsonb_build_object(
    'generated_at', v_refreshed_at,
    'total_members', coalesce(sum(member_count), 0),
    'cities', coalesce(jsonb_agg(to_jsonb(city_counts) order by id), '[]'::jsonb)
  ) into v_payload from city_counts;

  update public.matchmaking_public_map_cache
    set payload = v_payload, refreshed_at = v_refreshed_at where id;
  return v_payload;
end;
$$;
revoke all on function public.get_public_matchmaking_map() from public, anon, authenticated;
grant execute on function public.get_public_matchmaking_map() to anon, authenticated, service_role;
comment on function public.get_public_matchmaking_map() is
  'Public city-center counts and completed-profile total, cached for one hour. Includes paused profiles, like the member dashboard. No names, account IDs, contact details, books, preferences, or individual profile links.';


comment on table public.matchmaking_review_accounts is 'Operator-provisioned Auth account cohorts for App Review. No client access or email/metadata-based privileges. Cohort membership remains until the Auth account is deleted; fixture accounts are excluded from ordinary matching and public aggregates.';
notify pgrst, 'reload schema';
commit;
