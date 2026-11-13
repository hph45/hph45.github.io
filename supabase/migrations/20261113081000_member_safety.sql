begin;

-- Safety actions operate on an introduction the caller actually received.
-- Neither the other member's UUID nor report contents are exposed to members.
create table public.matchmaking_member_blocks (
  blocker_id uuid not null references public.matchmaking_profiles(user_id) on delete cascade,
  blocked_id uuid not null references public.matchmaking_profiles(user_id) on delete cascade,
  -- Historical reference, deliberately not a cascading match FK: replacing an
  -- introduction must never undo a member's block.
  match_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index matchmaking_blocks_reverse on public.matchmaking_member_blocks(blocked_id, blocker_id);
create table public.matchmaking_member_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.matchmaking_profiles(user_id) on delete cascade,
  reported_id uuid not null references public.matchmaking_profiles(user_id) on delete cascade,
  -- Keep the moderation record if an operator removes an introduction.
  match_id uuid not null,
  reason text not null check (reason in ('harassment','inappropriate_content','spam','impersonation','safety','other')),
  details text not null default '' check (char_length(details) <= 2000),
  status text not null default 'pending' check (status in ('pending','resolved','dismissed')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reporter_id, match_id),
  check (reporter_id <> reported_id)
);
create index matchmaking_reports_pending on public.matchmaking_member_reports(created_at) where status = 'pending';
alter table public.matchmaking_member_blocks enable row level security;
alter table public.matchmaking_member_reports enable row level security;
revoke all on public.matchmaking_member_blocks, public.matchmaking_member_reports from public, anon, authenticated;
grant all on public.matchmaking_member_blocks, public.matchmaking_member_reports to service_role;

create function public.matchmaking_pair_blocked(first_id uuid, second_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.matchmaking_member_blocks b
    where (b.blocker_id = first_id and b.blocked_id = second_id)
       or (b.blocker_id = second_id and b.blocked_id = first_id));
$$;
revoke all on function public.matchmaking_pair_blocked(uuid, uuid) from public, anon, authenticated;

create function public.matchmaking_safety_counterpart(p_match_id uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare counterpart uuid;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'SIGN_IN_REQUIRED'; end if;
  select theirs.user_id into counterpart
  from public.matchmaking_matches m
  join public.matchmaking_match_members mine on mine.match_id = m.id and mine.user_id = (select auth.uid())
  join public.matchmaking_match_members theirs on theirs.match_id = m.id and theirs.user_id <> mine.user_id
  where m.id = p_match_id and m.released_at <= now()
    and (select count(*) from public.matchmaking_match_members mm where mm.match_id = m.id) = 2;
  if counterpart is null then raise exception using errcode = '42501', message = 'INTRODUCTION_UNAVAILABLE'; end if;
  return counterpart;
end;
$$;
revoke all on function public.matchmaking_safety_counterpart(uuid) from public, anon, authenticated;

create function public.block_matchmaking_member(p_match_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare counterpart uuid := public.matchmaking_safety_counterpart(p_match_id);
begin
  insert into public.matchmaking_member_blocks(blocker_id, blocked_id, match_id)
    values(auth.uid(), counterpart, p_match_id) on conflict (blocker_id, blocked_id) do nothing;
  return true;
end;
$$;

create function public.unblock_matchmaking_member(p_match_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'SIGN_IN_REQUIRED'; end if;
  -- Authorize against the saved block, so unblocking remains possible after its
  -- original introduction is removed. An unknown/other member's ID is a no-op.
  delete from public.matchmaking_member_blocks where blocker_id = auth.uid() and match_id = p_match_id;
  return true;
end;
$$;

create function public.get_my_matchmaking_blocks()
returns table(match_id uuid, display_name text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select b.match_id, p.display_name, b.created_at
  from public.matchmaking_member_blocks b
  join public.matchmaking_profiles p on p.user_id = b.blocked_id
  where b.blocker_id = (select auth.uid())
  order by b.created_at desc, b.match_id;
$$;

create function public.report_matchmaking_member(p_match_id uuid, p_reason text, p_details text default '', p_block boolean default true)
returns boolean language plpgsql security definer set search_path = '' as $$
declare counterpart uuid := public.matchmaking_safety_counterpart(p_match_id);
begin
  if p_reason is null or p_reason not in ('harassment','inappropriate_content','spam','impersonation','safety','other')
    or char_length(coalesce(p_details, '')) > 2000 then
    raise exception using errcode = '22023', message = 'INVALID_REPORT';
  end if;
  insert into public.matchmaking_member_reports(reporter_id, reported_id, match_id, reason, details)
    values(auth.uid(), counterpart, p_match_id, p_reason, btrim(coalesce(p_details, '')))
    on conflict (reporter_id, match_id) do update
      set reason = excluded.reason, details = excluded.details, status = 'pending',
        resolved_by = null, resolved_at = null, updated_at = now();
  if coalesce(p_block, true) then perform public.block_matchmaking_member(p_match_id); end if;
  return true;
end;
$$;
revoke all on function public.block_matchmaking_member(uuid) from public, anon, authenticated;
revoke all on function public.unblock_matchmaking_member(uuid) from public, anon, authenticated;
revoke all on function public.get_my_matchmaking_blocks() from public, anon, authenticated;
revoke all on function public.report_matchmaking_member(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.block_matchmaking_member(uuid) to authenticated;
grant execute on function public.unblock_matchmaking_member(uuid) to authenticated;
grant execute on function public.get_my_matchmaking_blocks() to authenticated;
grant execute on function public.report_matchmaking_member(uuid, text, text, boolean) to authenticated;

-- A privileged matching worker cannot accidentally publish a blocked pairing.
-- Existing rows stay intact for review; member-facing reads suppress both sides.
create function public.reject_blocked_matchmaking_pair()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'matchmaking_matches' then
    if new.released_at is not null and exists (
      select 1 from public.matchmaking_match_members a
      join public.matchmaking_match_members b on b.match_id = a.match_id and b.user_id <> a.user_id
      where a.match_id = new.id and public.matchmaking_pair_blocked(a.user_id, b.user_id)
    ) then raise exception using errcode = '23514', message = 'MATCH_MEMBERS_BLOCKED'; end if;
  else
    if exists (select 1 from public.matchmaking_match_members other
      where other.match_id = new.match_id and other.user_id <> new.user_id
        and public.matchmaking_pair_blocked(new.user_id, other.user_id)) then
      raise exception using errcode = '23514', message = 'MATCH_MEMBERS_BLOCKED';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.reject_blocked_matchmaking_pair() from public, anon, authenticated;
create trigger matchmaking_blocked_release before insert or update on public.matchmaking_matches
  for each row execute function public.reject_blocked_matchmaking_pair();
create trigger matchmaking_blocked_members before insert or update of match_id, user_id on public.matchmaking_match_members
  for each row execute function public.reject_blocked_matchmaking_pair();

create function public.get_matchmaking_safety_reports(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.matchmaking_admin_access where user_id = (select auth.uid())) then
    raise exception using errcode = '42501', message = 'ADMIN_ONLY';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(r)) from (
    select id, reporter_id, reported_id, match_id, reason, details, status, created_at, updated_at
    from public.matchmaking_member_reports where status = 'pending'
    order by created_at limit least(100, greatest(1, coalesce(p_limit, 50)))
  ) r), '[]'::jsonb);
end;
$$;
revoke all on function public.get_matchmaking_safety_reports(integer) from public, anon, authenticated;
grant execute on function public.get_matchmaking_safety_reports(integer) to authenticated;

create function public.resolve_matchmaking_safety_report(p_report_id uuid, p_resolution text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.matchmaking_admin_access where user_id = (select auth.uid())) then
    raise exception using errcode = '42501', message = 'ADMIN_ONLY';
  end if;
  if p_resolution is null or p_resolution not in ('resolved', 'dismissed') then
    raise exception using errcode = '22023', message = 'INVALID_REPORT_RESOLUTION';
  end if;
  update public.matchmaking_member_reports set status = p_resolution,
    resolved_by = auth.uid(), resolved_at = now(), updated_at = now()
    where id = p_report_id;
  if not found then raise exception using errcode = '22023', message = 'REPORT_UNAVAILABLE'; end if;
  return true;
end;
$$;
revoke all on function public.resolve_matchmaking_safety_report(uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_matchmaking_safety_report(uuid, text) to authenticated;

-- Preserve existing projections and pagination, filtering before pagination.
create or replace function public.get_my_matchmaking_introductions(
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
      select m.*, mine.revealed_at, mine.member_notice,
        theirs.user_id as other_user_id, theirs.contact_via_email as other_contact_via_email
      from public.matchmaking_matches m
      join public.matchmaking_match_members mine on mine.match_id = m.id and mine.user_id = (select auth.uid())
      join public.matchmaking_match_members theirs on theirs.match_id = m.id and theirs.user_id <> mine.user_id
      where m.released_at <= now()
        and not public.matchmaking_pair_blocked(mine.user_id, theirs.user_id)
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
        'intent', m.intent, 'reason', concat_ws(E'\n\n', m.reason, nullif(btrim(m.member_notice), '')),
        'revealed_at', m.revealed_at,
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
        'instagram_handle', case when m.other_contact_via_email then null else p.instagram_handle end,
        'contact_email', case when (m.other_contact_via_email or p.instagram_handle is null)
          and p.share_email_with_matches then nullif(btrim(u.email), '') else null end,
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


create or replace function public.get_my_matchmaking_matches()
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
    and not public.matchmaking_pair_blocked(mine.user_id, theirs.user_id)
    and (select count(*) from public.matchmaking_match_members mm where mm.match_id = m.id) = 2
  order by m.week_start desc
  limit 52;
$$;
revoke all on function public.get_my_matchmaking_matches() from public, anon, authenticated;
grant execute on function public.get_my_matchmaking_matches() to authenticated;


create or replace function public.reveal_matchmaking_match(p_match_id uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_revealed_at timestamptz;
begin
  -- Caller identity always comes from Auth, never a browser-supplied user ID.
  update public.matchmaking_match_members mine
  set revealed_at = coalesce(mine.revealed_at, now())
  from public.matchmaking_matches m
  where mine.match_id = p_match_id and mine.user_id = (select auth.uid())
    and m.id = mine.match_id and m.released_at <= now()
    and not exists (select 1 from public.matchmaking_match_members other
      where other.match_id = m.id and other.user_id <> mine.user_id
        and public.matchmaking_pair_blocked(mine.user_id, other.user_id))
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


notify pgrst, 'reload schema';
commit;
