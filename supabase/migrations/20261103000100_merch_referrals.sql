begin;

-- Signup credit is insert-only. Prize preferences travel with the existing
-- owner-only profile read; opening the invite dialog needs no extra request.
alter table public.matchmaking_profiles
  add column referred_by_instagram text,
  add column merch_raffle_prize text check (merch_raffle_prize in ('hoodie', 't_shirt', 'cap'));
grant insert (referred_by_instagram, merch_raffle_prize), update (merch_raffle_prize)
  on public.matchmaking_profiles to authenticated;
create index matchmaking_profiles_instagram_referral on public.matchmaking_profiles(instagram_handle)
  where instagram_handle is not null;

-- This also retains unresolved/ambiguous credits for the operator to review.
-- No public read endpoint and no client writes: only the signup trigger awards
-- entries. The referred Auth account can be credited at most once.
create table public.matchmaking_merch_referrals (
  referred_user_id uuid primary key references auth.users(id) on delete cascade,
  referrer_user_id uuid references auth.users(id) on delete cascade,
  instagram_credit text not null,
  campaign text not null default 'founding-collection-2026' check (campaign = 'founding-collection-2026'),
  status text not null check (status in ('credited', 'unresolved', 'ambiguous', 'self_referral')),
  created_at timestamptz not null default now(),
  check ((status = 'credited') = (referrer_user_id is not null)),
  check (referrer_user_id is distinct from referred_user_id)
);
create index matchmaking_merch_referrals_referrer on public.matchmaking_merch_referrals(referrer_user_id)
  where status = 'credited';
alter table public.matchmaking_merch_referrals enable row level security;
revoke all on public.matchmaking_merch_referrals from public, anon, authenticated;
grant all on public.matchmaking_merch_referrals to service_role;

create function public.normalize_matchmaking_referral()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.referred_by_instagram := nullif(lower(regexp_replace(btrim(new.referred_by_instagram), '^@', '')), '');
  if new.referred_by_instagram is not null and (
    new.referred_by_instagram !~ '^[a-z0-9_][a-z0-9_.]{0,29}$'
    or new.referred_by_instagram ~ '\.\.|\.$'
    or new.referred_by_instagram in ('accounts', 'explore', 'direct', 'stories', 'reel', 'reels', 'p', 'about', 'developer', 'legal', 'privacy', 'terms')
  ) then
    raise exception using errcode = '22023', message = 'INVALID_REFERRAL_INSTAGRAM';
  end if;
  return new;
end;
$$;
revoke all on function public.normalize_matchmaking_referral() from public, anon, authenticated;
create trigger matchmaking_referral_normalize before insert on public.matchmaking_profiles
  for each row execute function public.normalize_matchmaking_referral();

create function public.record_matchmaking_referral()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_candidates uuid[];
  v_referrer uuid;
  v_status text;
begin
  if new.referred_by_instagram is null then return new; end if;
  select array_agg(p.user_id) into v_candidates from public.matchmaking_profiles p
    where p.instagram_handle = new.referred_by_instagram;
  if new.instagram_handle = new.referred_by_instagram or new.user_id = any(v_candidates) then
    v_status := 'self_referral';
  elsif coalesce(cardinality(v_candidates), 0) = 0 then
    v_status := 'unresolved';
  elsif cardinality(v_candidates) > 1 then
    v_status := 'ambiguous';
  else
    v_status := 'credited'; v_referrer := v_candidates[1];
  end if;
  insert into public.matchmaking_merch_referrals(referred_user_id, referrer_user_id, instagram_credit, status)
    values (new.user_id, v_referrer, new.referred_by_instagram, v_status)
    on conflict (referred_user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.record_matchmaking_referral() from public, anon, authenticated;
create trigger matchmaking_referral_record after insert on public.matchmaking_profiles
  for each row execute function public.record_matchmaking_referral();

comment on table public.matchmaking_merch_referrals is
  'Private referral raffle ledger. One entry per newly completed profile crediting a unique existing Instagram handle. Authenticated users cannot read or write the ledger. Unresolved, ambiguous, and self referrals are recorded but not entries. Use the referrer current merch_raffle_prize at draw time; null means awaiting choice. No drawing or notifications happen automatically. Account deletion cascades to its credits.';
comment on column public.matchmaking_profiles.referred_by_instagram is
  'Optional inviter handle supplied only on first profile creation. Not editable by browser roles, not returned in community data or match introductions.';
comment on column public.matchmaking_profiles.merch_raffle_prize is
  'Owner-editable raffle preference. All current campaign credits use this choice when a draw is prepared. Not included in community data or match introductions.';

commit;
