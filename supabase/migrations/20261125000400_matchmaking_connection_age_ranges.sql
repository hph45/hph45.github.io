begin;

alter table public.matchmaking_profiles
  add column friendship_age_min smallint not null default 18,
  add column friendship_age_max smallint not null default 120,
  add column business_age_min smallint not null default 18,
  add column business_age_max smallint not null default 120,
  add constraint matchmaking_friendship_age_range check (
    18 <= friendship_age_min and friendship_age_min <= friendship_age_max and friendship_age_max <= 120
  ),
  add constraint matchmaking_business_age_range check (
    18 <= business_age_min and business_age_min <= business_age_max and business_age_max <= 120
  );

grant insert (friendship_age_min, friendship_age_max, business_age_min, business_age_max),
      update (friendship_age_min, friendship_age_max, business_age_min, business_age_max)
  on public.matchmaking_profiles to authenticated;

-- Check both directions after the new pair or category is in place. Later
-- profile edits do not revisit introductions that have already been released.
create function public.guard_matchmaking_connection_ages()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  target_match uuid;
begin
  if tg_table_name = 'matchmaking_matches' then
    if new.released_at is null or new.intent = 'romance' then return null; end if;
    if tg_op = 'UPDATE' and old.released_at is not distinct from new.released_at and old.intent = new.intent then return null; end if;
    target_match := new.id;
  else
    if tg_op = 'UPDATE' and old.match_id = new.match_id and old.user_id = new.user_id then return null; end if;
    target_match := new.match_id;
  end if;

  if exists (
    select 1 from public.matchmaking_matches m
    join public.matchmaking_match_members mine on mine.match_id = m.id
    join public.matchmaking_match_members theirs on theirs.match_id = m.id and theirs.user_id <> mine.user_id
    join public.matchmaking_profiles p on p.user_id = mine.user_id
    join public.matchmaking_profiles other on other.user_id = theirs.user_id
    where m.id = target_match and m.released_at is not null and m.intent in ('friends', 'business_partners')
      and extract(year from age((now() at time zone 'America/Los_Angeles')::date, other.birth_date)) not between
        case m.intent when 'friends' then p.friendship_age_min else p.business_age_min end and
        case m.intent when 'friends' then p.friendship_age_max else p.business_age_max end
  ) then
    raise exception using errcode = '23514', message = 'MATCH_OUTSIDE_CONNECTION_AGE_RANGE';
  end if;
  return null;
end;
$$;
revoke all on function public.guard_matchmaking_connection_ages() from public, anon, authenticated;
create trigger matchmaking_connection_ages_release after insert or update of released_at, intent on public.matchmaking_matches
for each row execute function public.guard_matchmaking_connection_ages();
create trigger matchmaking_connection_ages_members after insert or update of match_id, user_id on public.matchmaking_match_members
for each row execute function public.guard_matchmaking_connection_ages();

-- Only the protected admin directory receives these private preferences.
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
        'friendship_age_min', case when 'friends' = any(p.intents) then p.friendship_age_min end,
        'friendship_age_max', case when 'friends' = any(p.intents) then p.friendship_age_max end,
        'business_age_min', case when 'business_partners' = any(p.intents) then p.business_age_min end,
        'business_age_max', case when 'business_partners' = any(p.intents) then p.business_age_max end,
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

notify pgrst, 'reload schema';
commit;
