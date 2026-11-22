-- Shared by the website and native app. Apply before publishing either client.
begin;

alter table public.matchmaking_profiles
  add column match_radius_miles integer,
  drop constraint matchmaking_profiles_location_preference_check,
  add constraint matchmaking_profiles_location_preference_check
    check (location_preference in ('same_city', 'radius', 'anywhere')),
  add constraint matchmaking_profiles_radius_check check (
    (location_preference = 'radius' and match_radius_miles is not null and match_radius_miles between 1 and 12500)
    or (location_preference <> 'radius' and match_radius_miles is null)
  );
grant insert (match_radius_miles), update (match_radius_miles)
  on public.matchmaking_profiles to authenticated;
comment on column public.matchmaking_profiles.match_radius_miles is
  'Private maximum straight-line distance in miles between selected city centers. Required only for radius mode. Both members limits apply to new introductions; existing introductions are retained.';

-- Older clients can still switch to anywhere or same_city without knowing the
-- new column. Clear a previous radius instead of rejecting that update.
create function public.normalize_matchmaking_radius()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.location_preference <> 'radius' then new.match_radius_miles := null; end if;
  return new;
end;
$$;
revoke all on function public.normalize_matchmaking_radius() from public, anon, authenticated;
create trigger matchmaking_normalize_radius
before insert or update of location_preference, match_radius_miles on public.matchmaking_profiles
for each row execute function public.normalize_matchmaking_radius();

-- Refresh the explicit view projection to include the new private field.
create or replace view public.matchmaking_nonreview_profiles with (security_invoker = true) as
  select p.* from public.matchmaking_profiles p
  where not exists (select 1 from public.matchmaking_review_accounts r where r.user_id = p.user_id);

-- Use the same 6,371 km Earth radius as the offline matcher. Haversine handles
-- the date line and coincident cities; no precise member location is collected.
create function public.matchmaking_pair_within_radius(p_a uuid, p_b uuid)
returns boolean language sql stable set search_path = '' as $$
  select coalesce((
    select (a.location_preference <> 'radius' or distance.miles <= a.match_radius_miles)
       and (b.location_preference <> 'radius' or distance.miles <= b.match_radius_miles)
    from public.matchmaking_profiles a
    join public.matchmaking_profiles b on b.user_id = p_b
    join public.matchmaking_cities ca on ca.id = a.city_id
    join public.matchmaking_cities cb on cb.id = b.city_id
    cross join lateral (
      select (12742.0 / 1.609344) * asin(sqrt(least(1.0, greatest(0.0,
        power(sin(radians(cb.latitude - ca.latitude) / 2), 2)
        + cos(radians(ca.latitude)) * cos(radians(cb.latitude))
        * power(sin(radians(cb.longitude - ca.longitude) / 2), 2)
      )))) as miles
    ) distance
    where a.user_id = p_a
  ), false);
$$;
revoke all on function public.matchmaking_pair_within_radius(uuid, uuid) from public, anon, authenticated;

-- Defense in depth for manual releases as well as generated batches. Keep the
-- existing active/category/block/review-account guards in place. Edits to an
-- already released introduction do not retroactively apply changed preferences.
create function public.guard_matchmaking_radius()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'matchmaking_matches' then
    if new.released_at is null then return new; end if;
    if tg_op = 'UPDATE' and old.released_at is not distinct from new.released_at then return new; end if;
    if exists (
      select 1 from public.matchmaking_match_members a
      join public.matchmaking_match_members b on b.match_id = a.match_id and a.user_id < b.user_id
      where a.match_id = new.id and not public.matchmaking_pair_within_radius(a.user_id, b.user_id)
    ) then
      raise exception 'MATCH_OUTSIDE_DISTANCE_RADIUS';
    end if;
  elsif exists (select 1 from public.matchmaking_matches m where m.id = new.match_id and m.released_at is not null) then
    if exists (
      select 1 from public.matchmaking_match_members other
      where other.match_id = new.match_id and other.user_id <> new.user_id
        and (tg_op <> 'UPDATE' or other.user_id <> old.user_id)
        and not public.matchmaking_pair_within_radius(new.user_id, other.user_id)
    ) then
      raise exception 'MATCH_OUTSIDE_DISTANCE_RADIUS';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_matchmaking_radius() from public, anon, authenticated;
create trigger matchmaking_radius_release before insert or update of released_at on public.matchmaking_matches
for each row execute function public.guard_matchmaking_radius();
create trigger matchmaking_radius_members before insert or update of match_id, user_id on public.matchmaking_match_members
for each row execute function public.guard_matchmaking_radius();

-- Keep the protected admin directory aware of the saved radius.
create or replace function public.get_matchmaking_admin_profiles(
  p_search text default '',
  p_intent text default null,
  p_page integer default 1,
  p_page_size integer default 20,
  p_min_age integer default null,
  p_max_age integer default null,
  p_gender text default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_search text := lower(left(btrim(coalesce(p_search, '')), 200));
  v_intent text := nullif(p_intent, '');
  v_gender text := nullif(p_gender, '');
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

  if p_min_age not between 18 and 120 or p_max_age not between 18 and 120 or p_min_age > p_max_age then
    raise exception using errcode = '22023', message = 'INVALID_AGE_RANGE';
  end if;
  if v_gender is not null and v_gender not in ('woman', 'man', 'other', 'not_provided') then
    raise exception using errcode = '22023', message = 'INVALID_GENDER';
  end if;

  return (
    with demographics as (
      select p.*,
        extract(year from age(current_date, p.birth_date))::integer as current_age,
        case when 'romance' = any(p.intents) then p.gender else null end as current_gender
      from public.matchmaking_profiles p
    ), filtered as materialized (
      select p.* from demographics p
      join auth.users u on u.id = p.user_id
      where (v_intent is null or v_intent = any(p.intents))
        and (p_min_age is null or p.current_age >= p_min_age)
        and (p_max_age is null or p.current_age <= p_max_age)
        and (v_gender is null or coalesce(p.current_gender, 'not_provided') = v_gender)
        and (v_search = '' or strpos(lower(concat_ws(' ', p.display_name, u.email, p.instagram_handle, p.city, p.region, p.country,
          p.favorite_book, p.favorite_author, p.favorite_book_2, p.favorite_author_2,
          p.favorite_book_3, p.favorite_author_3, p.current_book, p.current_author)), v_search) > 0)
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
        'instagram_handle', p.instagram_handle,
        'age', p.current_age,
        'city', p.city, 'region', p.region, 'country', p.country,
        'intents', p.intents,
        'is_active', p.is_active, 'email_matches', p.email_matches,
        'location_preference', p.location_preference,
        'match_radius_miles', p.match_radius_miles,
        'favorite_books', (
          select jsonb_agg(jsonb_build_object('title', title, 'author', author) order by position)
          from (values (1, p.favorite_book_id, p.favorite_book, p.favorite_author),
            (2, p.favorite_book_2_id, p.favorite_book_2, p.favorite_author_2),
            (3, p.favorite_book_3_id, p.favorite_book_3, p.favorite_author_3)) books(position, work_id, title, author)
          where work_id is not null
        ),
        'current_book', p.current_book, 'current_author', p.current_author,
        'gender', p.current_gender,
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
revoke all on function public.get_matchmaking_admin_profiles(text, text, integer, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.get_matchmaking_admin_profiles(text, text, integer, integer, integer, integer, text) to authenticated;
comment on function public.get_matchmaking_admin_profiles(text, text, integer, integer, integer, integer, text) is
  'Owner-only review of current profiles, favorite books, optional current reads, and selected connection answers. Searches names, current account emails, Instagram handles, locations, and books; filters current ages, genders, and connection types before pagination. Checks the admin Auth ID on every page request. Does not return birthdays, emails, Auth IDs, or retired answers.';

notify pgrst, 'reload schema';
commit;
