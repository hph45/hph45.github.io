begin;

-- One member, one bookshelf, and one or more connection types. Preserve the
-- existing scalar column while older versions of the website are still open.
alter table public.matchmaking_profiles add column intents text[];

-- The ALTER TABLE lock covers this backfill. Keep both edit clocks unchanged;
-- favorite IDs are not updated, so selection dates and rankings also stay put.
alter table public.matchmaking_profiles disable trigger matchmaking_profile_updated_at;
update public.matchmaking_profiles set intents = array[intent];
alter table public.matchmaking_profiles enable trigger matchmaking_profile_updated_at;

alter table public.matchmaking_profiles
  alter column intents set not null,
  drop constraint romance_preferences_complete,
  drop constraint friendship_preferences_complete,
  drop constraint business_preferences_complete,
  -- PostgreSQL gave these cross-column checks table-level names in migration 004.
  drop constraint matchmaking_profiles_check,
  drop constraint matchmaking_profiles_check1,
  add constraint valid_matchmaking_intents check (
    array_ndims(intents) = 1 and array_lower(intents, 1) = 1
    and cardinality(intents) between 1 and 3
    and intents <@ array['romance', 'friends', 'business_partners']::text[]
    and array_position(intents, null) is null
    and cardinality(intents) = (
      ('romance' = any(intents))::integer + ('friends' = any(intents))::integer
      + ('business_partners' = any(intents))::integer
    )
    and intent = any(intents)
  ),
  add constraint romance_preferences_complete check (
    not ('romance' = any(intents)) or (
      gender is not null
      and cardinality(interested_in) > 0 and array_position(interested_in, null) is null
      and age_min is not null and age_max is not null and age_min <= age_max
    )
  ),
  add constraint friendship_preferences_complete check (
    not ('friends' = any(intents)) or char_length(btrim(friendship_interests)) between 5 and 600
  ),
  add constraint business_preferences_complete check (
    not ('business_partners' = any(intents)) or (
      char_length(btrim(business_about)) between 5 and 600
      and char_length(btrim(business_skills)) between 5 and 600
      and char_length(btrim(business_seeking)) between 5 and 600
    )
  ),
  add constraint matchmaking_profiles_romance_ideal_match_check check (
    char_length(romance_ideal_match) <= 600 and (romance_ideal_match = '' or 'romance' = any(intents))
  ),
  add constraint matchmaking_profiles_business_linkedin_url_check check (
    business_linkedin_url = '' or (
      'business_partners' = any(intents) and char_length(business_linkedin_url) <= 300
      and business_linkedin_url ~ '^https://www[.]linkedin[.]com/(in|company)/([A-Za-z0-9_-]|%[A-Fa-f0-9]{2})+$'
    )
  );

create function public.sync_matchmaking_intents()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.intents is null then new.intents := array[new.intent]; end if;
    new.intent := new.intents[1];
  elsif new.intents is distinct from old.intents then
    new.intent := new.intents[1];
  elsif new.intent is distinct from old.intent then
    -- Explicit type changes from the old form still work. Routine updates that
    -- resubmit an unchanged scalar must not collapse a member's selections.
    new.intents := array[new.intent];
  end if;
  return new;
end;
$$;
revoke all on function public.sync_matchmaking_intents() from public, anon, authenticated;
create trigger matchmaking_intents_sync
before insert or update on public.matchmaking_profiles
for each row execute function public.sync_matchmaking_intents();

grant insert (intents), update (intents) on public.matchmaking_profiles to authenticated;
comment on column public.matchmaking_profiles.intents is
  'Selected connection types. Every selected type requires complete preferences. Owner-only; not returned in introductions.';
comment on column public.matchmaking_profiles.intent is
  'Compatibility field for older clients. Use intents for eligibility; each introduction still has one specific intent.';

-- Each introduction has one category shared by both participants. The existing
-- one-introduction-per-member-per-week limit continues to apply across types.
create or replace function public.validate_matchmaking_release()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.released_at is not null and ((
    select count(*) from public.matchmaking_match_members mm where mm.match_id = new.id
  ) <> 2 or (
    select count(*) from public.matchmaking_match_members mm
    join public.matchmaking_profiles p on p.user_id = mm.user_id
    where mm.match_id = new.id and new.intent = any(p.intents) and p.is_active
  ) <> 2) then
    raise exception 'A match needs two active members in the same category';
  end if;
  return new;
end;
$$;

create or replace function public.get_my_matchmaking_matches()
returns table (
  id uuid, week_start date, intent text, reason text,
  display_name text, age integer, city text, region text, country text,
  favorite_book text, favorite_author text, favorite_book_2 text, favorite_author_2 text,
  favorite_book_3 text, favorite_author_3 text, book_reason text,
  friendship_interests text, business_about text, business_skills text, business_seeking text,
  business_linkedin_url text
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
    case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_linkedin_url else '' end
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

commit;
