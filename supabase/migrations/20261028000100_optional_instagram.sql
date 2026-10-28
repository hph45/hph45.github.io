begin;

-- Instagram is optional at signup and can be removed later. Keep validating
-- handles that are supplied; leave profile access and match privacy unchanged.
create or replace function public.normalize_matchmaking_instagram()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.instagram_handle := nullif(lower(regexp_replace(btrim(new.instagram_handle), '^@', '')), '');
  if new.instagram_handle is null then
    return new;
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

comment on column public.matchmaking_profiles.instagram_handle is
  'Optional canonical Instagram handle. Owners can add, change, or remove it. Shared only with the owner, protected admin directory, and participants of released introductions. Never included in community totals. A missing handle does not prevent matching; contact without Instagram will use email when introductions launch.';

-- A missing Instagram handle no longer excludes an otherwise eligible reader.
-- Preserve the two-member, active-profile, and shared-category release checks.
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
  end if;
  return new;
end;
$$;
revoke all on function public.validate_matchmaking_release() from public, anon, authenticated;

commit;
