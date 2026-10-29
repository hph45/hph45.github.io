begin;

-- Private suggestions for the operator's review. Handles need not correspond
-- to members. Neither this table nor the submission response reveals accounts.
create table public.matchmaking_friend_suggestions (
  id uuid primary key default gen_random_uuid(),
  submitted_by uuid not null references public.matchmaking_profiles(user_id) on delete cascade,
  intent text not null default 'romance' check (intent = 'romance'),
  first_instagram text not null,
  second_instagram text not null,
  created_at timestamptz not null default now(),
  check (first_instagram < second_instagram),
  unique (submitted_by, first_instagram, second_instagram)
);
create index matchmaking_friend_suggestions_recent on public.matchmaking_friend_suggestions(submitted_by, created_at desc);
alter table public.matchmaking_friend_suggestions enable row level security;
revoke all on public.matchmaking_friend_suggestions from public, anon, authenticated;
grant all on public.matchmaking_friend_suggestions to service_role;

create function public.suggest_matchmaking_friends(p_first_instagram text, p_second_instagram text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_first text := lower(regexp_replace(btrim(coalesce(p_first_instagram, '')), '^@', ''));
  v_second text := lower(regexp_replace(btrim(coalesce(p_second_instagram, '')), '^@', ''));
  v_handle text;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'SIGN_IN_REQUIRED';
  end if;
  foreach v_handle in array array[v_first, v_second] loop
    if v_handle !~ '^[a-z0-9_][a-z0-9_.]{0,29}$' or v_handle ~ '\.\.|\.$'
      or v_handle in ('accounts', 'explore', 'direct', 'stories', 'reel', 'reels', 'p', 'about', 'developer', 'legal', 'privacy', 'terms') then
      raise exception using errcode = '22023', message = 'INVALID_INSTAGRAM';
    end if;
  end loop;
  if v_first = v_second then
    raise exception using errcode = '22023', message = 'DIFFERENT_FRIENDS_REQUIRED';
  end if;

  -- Serialize this member's requests so concurrent calls cannot bypass the
  -- quota. This does not edit the profile or reset either book-edit clock.
  perform 1 from public.matchmaking_profiles where user_id = v_user for update;
  if not found then
    raise exception using errcode = '42501', message = 'PROFILE_REQUIRED';
  end if;
  if exists (select 1 from public.matchmaking_friend_suggestions
    where submitted_by = v_user and first_instagram = least(v_first, v_second) and second_instagram = greatest(v_first, v_second)) then
    return true;
  end if;
  if (select count(*) from public.matchmaking_friend_suggestions
    where submitted_by = v_user and created_at > now() - interval '24 hours') >= 5 then
    raise exception using errcode = '54000', message = 'FRIEND_SUGGESTION_LIMIT';
  end if;
  insert into public.matchmaking_friend_suggestions(submitted_by, first_instagram, second_instagram)
    values (v_user, least(v_first, v_second), greatest(v_first, v_second));
  return true;
end;
$$;
revoke all on function public.suggest_matchmaking_friends(text, text) from public, anon, authenticated;
grant execute on function public.suggest_matchmaking_friends(text, text) to authenticated;

comment on table public.matchmaking_friend_suggestions is
  'Romance-only suggestions submitted by members. Review through a privileged operator connection. Suggestions never create or release a match: both readers must independently be eligible for romance and satisfy mutual preferences. The submitter is not told whether either handle has an account.';

commit;
