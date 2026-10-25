begin;

-- Null means contact details are still outstanding. Preserve existing members
-- and older clients during rollout; nobody can receive a new match without it.
alter table public.matchmaking_profiles
  add column instagram_handle text,
  add constraint matchmaking_instagram_handle_valid check (
    instagram_handle is null or (
      instagram_handle ~ '^[a-z0-9_][a-z0-9_.]{0,29}$'
      and instagram_handle !~ '\.\.|\.$'
      and instagram_handle not in ('accounts', 'explore', 'direct', 'stories', 'reel', 'reels', 'p', 'about', 'developer', 'legal', 'privacy', 'terms')
    )
  );
grant insert (instagram_handle), update (instagram_handle)
  on public.matchmaking_profiles to authenticated;

create function public.normalize_matchmaking_instagram()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.instagram_handle is null then
    if tg_op = 'UPDATE' and old.instagram_handle is not null then
      raise exception using errcode = '22023', message = 'INSTAGRAM_REQUIRED';
    end if;
    return new;
  end if;
  new.instagram_handle := lower(regexp_replace(btrim(new.instagram_handle), '^@', ''));
  if new.instagram_handle = '' then
    raise exception using errcode = '22023', message = 'INSTAGRAM_REQUIRED';
  end if;
  if new.instagram_handle !~ '^[a-z0-9_][a-z0-9_.]{0,29}$'
    or new.instagram_handle ~ '\.\.|\.$'
    or new.instagram_handle in ('accounts', 'explore', 'direct', 'stories', 'reel', 'reels', 'p', 'about', 'developer', 'legal', 'privacy', 'terms') then
    raise exception using errcode = '22023', message = 'INVALID_INSTAGRAM';
  end if;
  return new;
end;
$$;
revoke all on function public.normalize_matchmaking_instagram() from public, anon, authenticated;
create trigger matchmaking_instagram
before insert or update on public.matchmaking_profiles
for each row execute function public.normalize_matchmaking_instagram();

comment on column public.matchmaking_profiles.instagram_handle is
  'Canonical Instagram handle. Required by new signup forms. Null keeps older profiles pending contact details and ineligible for new matches. Editable by the owner; returned only to that owner, the protected admin directory, and participants of released introductions. Never included in community totals.';

create or replace function public.validate_matchmaking_release()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.released_at is not null then
    if (select count(*) from public.matchmaking_match_members mm where mm.match_id = new.id) <> 2
      or (select count(*) from public.matchmaking_match_members mm
        join public.matchmaking_profiles p on p.user_id = mm.user_id
        where mm.match_id = new.id and new.intent = any(p.intents) and p.is_active) <> 2 then
      raise exception 'A match needs two active members in the same category';
    end if;
    if exists (select 1 from public.matchmaking_match_members mm
      join public.matchmaking_profiles p on p.user_id = mm.user_id
      where mm.match_id = new.id and p.instagram_handle is null) then
      raise exception using errcode = '23514', message = 'INSTAGRAM_REQUIRED_FOR_MATCH';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.validate_matchmaking_release() from public, anon, authenticated;

-- Contact handles share the existing participant and admin access boundaries.
drop function public.get_my_matchmaking_matches();
create function public.get_my_matchmaking_matches()
returns table (
  id uuid, week_start date, intent text, reason text,
  display_name text, age integer, city text, region text, country text,
  favorite_book text, favorite_author text, favorite_book_2 text, favorite_author_2 text,
  favorite_book_3 text, favorite_author_3 text, book_reason text,
  friendship_interests text, business_about text, business_skills text, business_seeking text,
  business_linkedin_url text, current_book text, current_author text, instagram_handle text
)
language sql stable security definer set search_path = '' as $$
  select m.id, m.week_start, m.intent, m.reason,
    p.display_name, extract(year from age(current_date, p.birth_date))::integer,
    p.city, p.region, p.country, p.favorite_book, p.favorite_author,
    p.favorite_book_2, p.favorite_author_2, p.favorite_book_3, p.favorite_author_3, ''::text,
    case when m.intent = 'friends' and 'friends' = any(p.intents) then p.friendship_interests else '' end,
    case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_about else '' end,
    case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_skills else '' end,
    case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_seeking else '' end,
    case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_linkedin_url else '' end,
    p.current_book, p.current_author, p.instagram_handle
  from public.matchmaking_matches m
  join public.matchmaking_match_members mine on mine.match_id = m.id
  join public.matchmaking_match_members theirs on theirs.match_id = m.id and theirs.user_id <> mine.user_id
  join public.matchmaking_profiles p on p.user_id = theirs.user_id
  where mine.user_id = (select auth.uid())
    and m.released_at is not null and m.released_at <= now()
    and (select count(*) from public.matchmaking_match_members mm where mm.match_id = m.id) = 2
  order by m.week_start desc
  limit 52;
$$;
revoke all on function public.get_my_matchmaking_matches() from public, anon, authenticated;
grant execute on function public.get_my_matchmaking_matches() to authenticated;

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
