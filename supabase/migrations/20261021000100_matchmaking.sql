begin;

create table public.matchmaking_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  birth_date date not null check (
    birth_date <= (current_date - interval '18 years')::date
    and birth_date > (current_date - interval '121 years')::date
  ),
  city_id integer not null references public.matchmaking_cities(id),
  city text not null check (char_length(btrim(city)) between 1 and 200),
  region text not null default '' check (char_length(region) <= 200),
  country text not null check (char_length(btrim(country)) between 2 and 200),
  intent text not null check (intent in ('romance', 'friends', 'business_partners')),
  favorite_book_id text not null references public.matchmaking_books(work_id),
  favorite_book text not null check (char_length(btrim(favorite_book)) between 1 and 300),
  favorite_author text not null check (char_length(btrim(favorite_author)) between 1 and 300),
  favorite_book_2_id text references public.matchmaking_books(work_id),
  favorite_book_2 text not null default '',
  favorite_author_2 text not null default '',
  favorite_book_3_id text references public.matchmaking_books(work_id),
  favorite_book_3 text not null default '',
  favorite_author_3 text not null default '',
  book_reason text not null check (char_length(btrim(book_reason)) between 10 and 1000),
  books_updated_at timestamptz not null default now(),
  location_preference text not null check (location_preference in ('same_city', 'anywhere')),
  gender text check (gender in ('woman', 'man', 'nonbinary', 'self_described')),
  gender_description text not null default '' check (char_length(gender_description) <= 80),
  interested_in text[] not null default '{}' check (
    interested_in <@ array['woman', 'man', 'nonbinary', 'self_described']::text[]
  ),
  age_min smallint check (age_min between 18 and 120),
  age_max smallint check (age_max between 18 and 120),
  friendship_interests text not null default '' check (char_length(friendship_interests) <= 600),
  business_about text not null default '' check (char_length(business_about) <= 600),
  business_skills text not null default '' check (char_length(business_skills) <= 600),
  business_seeking text not null default '' check (char_length(business_seeking) <= 600),
  is_active boolean not null default true,
  email_matches boolean not null default false,
  profile_consent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint distinct_favorite_books check (
    (favorite_book_2_id is null or favorite_book_2_id <> favorite_book_id)
    and (favorite_book_3_id is null or (favorite_book_2_id is not null
      and favorite_book_3_id <> favorite_book_id and favorite_book_3_id <> favorite_book_2_id))
  ),
  constraint romance_preferences_complete check (
    intent <> 'romance' or (
      gender is not null
      and (gender <> 'self_described' or char_length(btrim(gender_description)) > 0)
      and cardinality(interested_in) > 0
      and array_position(interested_in, null) is null
      and age_min is not null and age_max is not null and age_min <= age_max
    )
  ),
  constraint friendship_preferences_complete check (
    intent <> 'friends' or char_length(btrim(friendship_interests)) between 5 and 600
  ),
  constraint business_preferences_complete check (
    intent <> 'business_partners' or (
      char_length(btrim(business_about)) between 5 and 600
      and char_length(btrim(business_skills)) between 5 and 600
      and char_length(btrim(business_seeking)) between 5 and 600
    )
  )
);

create function public.set_matchmaking_profile_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Only catalog IDs are accepted; submitted labels never determine grouping.
  select c.name, c.region, c.country into new.city, new.region, new.country
    from public.matchmaking_cities c where c.id = new.city_id;
  if not found then raise exception 'Choose a city from the suggestions'; end if;
  select b.title, b.author into new.favorite_book, new.favorite_author
    from public.matchmaking_books b where b.work_id = new.favorite_book_id;
  if not found then raise exception 'Choose a book from the suggestions'; end if;
  new.favorite_book_2 := ''; new.favorite_author_2 := '';
  if new.favorite_book_2_id is not null then
    select b.title, b.author into new.favorite_book_2, new.favorite_author_2
      from public.matchmaking_books b where b.work_id = new.favorite_book_2_id;
    if not found then raise exception 'Choose a second book from the suggestions'; end if;
  end if;
  new.favorite_book_3 := ''; new.favorite_author_3 := '';
  if new.favorite_book_3_id is not null then
    select b.title, b.author into new.favorite_book_3, new.favorite_author_3
      from public.matchmaking_books b where b.work_id = new.favorite_book_3_id;
    if not found then raise exception 'Choose a third book from the suggestions'; end if;
  end if;
  if tg_op = 'UPDATE' then
    if row(new.favorite_book_id, new.favorite_book_2_id, new.favorite_book_3_id, new.book_reason)
       is distinct from row(old.favorite_book_id, old.favorite_book_2_id, old.favorite_book_3_id, old.book_reason) then
      if old.books_updated_at > now() - interval '24 hours' then
        raise exception using errcode = 'P0001', message = 'BOOKS_LOCKED';
      end if;
      new.books_updated_at := now();
    else
      new.books_updated_at := old.books_updated_at;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.set_matchmaking_profile_updated_at() from public, anon, authenticated;

create trigger matchmaking_profile_updated_at
before insert or update on public.matchmaking_profiles
for each row execute function public.set_matchmaking_profile_updated_at();

alter table public.matchmaking_profiles enable row level security;
revoke all on public.matchmaking_profiles from public, anon, authenticated;
grant select on public.matchmaking_profiles to authenticated;
grant insert (
  user_id, display_name, birth_date, city_id, city, region, country, intent,
  favorite_book_id, favorite_book, favorite_author, favorite_book_2_id, favorite_book_2, favorite_author_2,
  favorite_book_3_id, favorite_book_3, favorite_author_3, book_reason, location_preference,
  gender, gender_description, interested_in, age_min, age_max,
  friendship_interests, business_about, business_skills, business_seeking,
  is_active, email_matches
) on public.matchmaking_profiles to authenticated;
grant update (
  display_name, birth_date, city_id, city, region, country, intent,
  favorite_book_id, favorite_book, favorite_author, favorite_book_2_id, favorite_book_2, favorite_author_2,
  favorite_book_3_id, favorite_book_3, favorite_author_3, book_reason, location_preference,
  gender, gender_description, interested_in, age_min, age_max,
  friendship_interests, business_about, business_skills, business_seeking,
  is_active, email_matches
) on public.matchmaking_profiles to authenticated;
grant all on public.matchmaking_profiles to service_role;

create policy "Members read their own private profile"
on public.matchmaking_profiles for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Members create their own profile"
on public.matchmaking_profiles for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Members update their own profile"
on public.matchmaking_profiles for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Reserved for the weekly matching worker. Members cannot create or release matches.
create table public.matchmaking_matches (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  intent text not null check (intent in ('romance', 'friends', 'business_partners')),
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, week_start)
);

create table public.matchmaking_match_members (
  match_id uuid not null,
  week_start date not null,
  user_id uuid not null references public.matchmaking_profiles(user_id) on delete cascade,
  primary key (match_id, user_id),
  foreign key (match_id, week_start) references public.matchmaking_matches(id, week_start) on delete cascade,
  unique (user_id, week_start)
);

alter table public.matchmaking_matches enable row level security;
alter table public.matchmaking_match_members enable row level security;
revoke all on public.matchmaking_matches, public.matchmaking_match_members from public, anon, authenticated;
grant all on public.matchmaking_matches, public.matchmaking_match_members to service_role;

-- A release must contain exactly two people, both in the selected category.
create function public.validate_matchmaking_release()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.released_at is not null and ((
    select count(*) from public.matchmaking_match_members mm where mm.match_id = new.id
  ) <> 2 or (
    select count(*) from public.matchmaking_match_members mm
    join public.matchmaking_profiles p on p.user_id = mm.user_id
    where mm.match_id = new.id and p.intent = new.intent and p.is_active
  ) <> 2) then
    raise exception 'A match needs two active members in the same category';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_matchmaking_release() from public, anon, authenticated;
create trigger matchmaking_validate_release
before insert or update on public.matchmaking_matches
for each row execute function public.validate_matchmaking_release();

-- No profile directory: only a released match exposes this small projection.
-- Exact birth dates, email addresses, gender preferences, and account settings stay private.
create function public.get_my_matchmaking_matches()
returns table (
  id uuid, week_start date, intent text, reason text,
  display_name text, age integer, city text, region text, country text,
  favorite_book text, favorite_author text, favorite_book_2 text, favorite_author_2 text,
  favorite_book_3 text, favorite_author_3 text, book_reason text,
  friendship_interests text, business_about text, business_skills text, business_seeking text
)
language sql stable security definer set search_path = '' as $$
  select m.id, m.week_start, m.intent, m.reason,
    p.display_name, extract(year from age(current_date, p.birth_date))::integer,
    p.city, p.region, p.country, p.favorite_book, p.favorite_author,
    p.favorite_book_2, p.favorite_author_2, p.favorite_book_3, p.favorite_author_3, p.book_reason,
    case when m.intent = 'friends' then p.friendship_interests else '' end,
    case when m.intent = 'business_partners' then p.business_about else '' end,
    case when m.intent = 'business_partners' then p.business_skills else '' end,
    case when m.intent = 'business_partners' then p.business_seeking else '' end
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

comment on table public.matchmaking_profiles is 'Owner-only profile data. Expose match details only through get_my_matchmaking_matches.';
comment on table public.matchmaking_matches is 'Weekly introductions. Scheduling and email delivery are configured in a later release.';

commit;
