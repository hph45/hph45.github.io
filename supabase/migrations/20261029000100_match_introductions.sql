begin;

-- A member can receive several introductions in a drop, across any shared type.
alter table public.matchmaking_match_members
  drop constraint matchmaking_match_members_user_id_week_start_key,
  add column revealed_at timestamptz;
create index matchmaking_members_user_history on public.matchmaking_match_members(user_id, match_id);
create index matchmaking_released_history on public.matchmaking_matches(released_at desc, id desc)
  where released_at is not null;

-- Recommendations belong to the pair, so both readers see the same next book.
-- Existing introductions are preserved; every new release must include a pick.
alter table public.matchmaking_matches
  add column recommended_book_id text references public.matchmaking_books(work_id),
  add column recommendation_reason text not null default ''
    check (char_length(recommendation_reason) <= 600);

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
    if tg_op = 'INSERT' or old.released_at is null then
      if new.recommended_book_id is null or btrim(new.recommendation_reason) = '' then
        raise exception using errcode = '23514', message = 'MATCH_RECOMMENDATION_REQUIRED';
      end if;
      if exists (select 1 from public.matchmaking_match_members mm
        join public.matchmaking_profiles p on p.user_id = mm.user_id
        where mm.match_id = new.id and new.recommended_book_id = any(array[
          p.favorite_book_id, p.favorite_book_2_id, p.favorite_book_3_id, p.current_book_id])) then
        raise exception using errcode = '23514', message = 'MATCH_RECOMMENDATION_ALREADY_SELECTED';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.validate_matchmaking_release() from public, anon, authenticated;

-- Email is the default contact fallback when Instagram is absent. Members can
-- opt out independently of match notification emails. This pending migration
-- initializes existing profiles; subsequent saves preserve an explicit false.
alter table public.matchmaking_profiles add column share_email_with_matches boolean not null default true;
grant insert (share_email_with_matches), update (share_email_with_matches)
  on public.matchmaking_profiles to authenticated;

create function public.get_my_matchmaking_introductions(
  p_before_released_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 24
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := least(48, greatest(1, coalesce(p_limit, 24)));
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'SIGN_IN_REQUIRED';
  end if;
  if (p_before_released_at is null) <> (p_before_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_MATCH_CURSOR';
  end if;
  return (
    with available as materialized (
      select m.*, mine.revealed_at, theirs.user_id as other_user_id
      from public.matchmaking_matches m
      join public.matchmaking_match_members mine on mine.match_id = m.id and mine.user_id = (select auth.uid())
      join public.matchmaking_match_members theirs on theirs.match_id = m.id and theirs.user_id <> mine.user_id
      where m.released_at <= now()
        and (select count(*) from public.matchmaking_match_members mm where mm.match_id = m.id) = 2
    ), page as materialized (
      select * from available
      where p_before_released_at is null or (released_at, id) < (p_before_released_at, p_before_id)
      order by released_at desc, id desc limit v_limit
    ), last_item as (
      select released_at, id from page order by released_at, id limit 1
    ), items as (
      select m.released_at, m.id, jsonb_build_object(
        'id', m.id, 'week_start', m.week_start, 'released_at', m.released_at,
        'intent', m.intent, 'reason', m.reason, 'revealed_at', m.revealed_at,
        'display_name', p.display_name, 'age', extract(year from age(current_date, p.birth_date))::integer,
        'city', p.city, 'region', p.region, 'country', p.country,
        'favorite_book_id', p.favorite_book_id, 'favorite_book', p.favorite_book, 'favorite_author', p.favorite_author,
        'favorite_book_2_id', p.favorite_book_2_id, 'favorite_book_2', p.favorite_book_2, 'favorite_author_2', p.favorite_author_2,
        'favorite_book_3_id', p.favorite_book_3_id, 'favorite_book_3', p.favorite_book_3, 'favorite_author_3', p.favorite_author_3,
        'current_book_id', p.current_book_id, 'current_book', p.current_book, 'current_author', p.current_author,
        'friendship_interests', case when m.intent = 'friends' and 'friends' = any(p.intents) then p.friendship_interests else '' end,
        'business_about', case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_about else '' end,
        'business_skills', case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_skills else '' end,
        'business_seeking', case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_seeking else '' end,
        'business_linkedin_url', case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_linkedin_url else '' end,
        'instagram_handle', p.instagram_handle,
        'contact_email', case when p.instagram_handle is null and p.share_email_with_matches then u.email else null end,
        'recommended_book', case when b.work_id is not null then jsonb_build_object(
          'work_id', b.work_id, 'title', b.title, 'author', b.author, 'reason', m.recommendation_reason) else null end
      ) as item
      from page m join public.matchmaking_profiles p on p.user_id = m.other_user_id
      join auth.users u on u.id = p.user_id
      left join public.matchmaking_books b on b.work_id = m.recommended_book_id
    )
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(item order by released_at desc, id desc) from items), '[]'::jsonb),
      'total_count', (select count(*) from available),
      'next_cursor', (select jsonb_build_object('released_at', l.released_at, 'id', l.id) from last_item l
        where exists (select 1 from available a where (a.released_at, a.id) < (l.released_at, l.id)))
    )
  );
end;
$$;
revoke all on function public.get_my_matchmaking_introductions(timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.get_my_matchmaking_introductions(timestamptz, uuid, integer) to authenticated;

create function public.reveal_matchmaking_match(p_match_id uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_revealed_at timestamptz;
begin
  -- Caller identity always comes from Auth, never a browser-supplied user ID.
  update public.matchmaking_match_members mine
  set revealed_at = coalesce(mine.revealed_at, now())
  from public.matchmaking_matches m
  where mine.match_id = p_match_id and mine.user_id = (select auth.uid())
    and m.id = mine.match_id and m.released_at <= now()
    and (select count(*) from public.matchmaking_match_members mm where mm.match_id = m.id) = 2
  returning mine.revealed_at into v_revealed_at;
  if v_revealed_at is null then
    raise exception using errcode = '42501', message = 'INTRODUCTION_UNAVAILABLE';
  end if;
  return v_revealed_at;
end;
$$;
revoke all on function public.reveal_matchmaking_match(uuid) from public, anon, authenticated;
grant execute on function public.reveal_matchmaking_match(uuid) to authenticated;

comment on column public.matchmaking_match_members.revealed_at is
  'First reveal by this participant. Server-owned, idempotent, and private to this member; no read receipts for their match.';
comment on column public.matchmaking_profiles.share_email_with_matches is
  'Email contact is on by default, including on existing profiles when this column is introduced. Shared only with released matches when Instagram is absent and the member has not opted out. Independent of email_matches notifications.';

commit;
