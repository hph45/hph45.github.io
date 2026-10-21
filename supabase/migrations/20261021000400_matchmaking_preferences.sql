begin;

-- Consolidate the two retired choices without losing private self-descriptions.
alter table public.matchmaking_profiles
  drop constraint matchmaking_profiles_gender_check,
  drop constraint matchmaking_profiles_interested_in_check,
  drop constraint romance_preferences_complete;

update public.matchmaking_profiles p
set gender = case when gender in ('nonbinary', 'self_described') then 'other' else gender end,
    interested_in = array(
      select distinct case when choice in ('nonbinary', 'self_described') then 'other' else choice end
      from unnest(p.interested_in) as choices(choice)
      order by 1
    )
where gender in ('nonbinary', 'self_described')
   or interested_in && array['nonbinary', 'self_described']::text[];

alter table public.matchmaking_profiles
  add constraint matchmaking_profiles_gender_check check (gender in ('woman', 'man', 'other')),
  add constraint matchmaking_profiles_interested_in_check check (interested_in <@ array['woman', 'man', 'other']::text[]),
  add constraint romance_preferences_complete check (
    intent <> 'romance' or (
      gender is not null
      and cardinality(interested_in) > 0 and array_position(interested_in, null) is null
      and age_min is not null and age_max is not null and age_min <= age_max
    )
  ),
  add column romance_ideal_match text not null default '' check (
    char_length(romance_ideal_match) <= 600 and (romance_ideal_match = '' or intent = 'romance')
  ),
  add column business_linkedin_url text not null default '' check (
    business_linkedin_url = '' or (
      intent = 'business_partners' and char_length(business_linkedin_url) <= 300
      and business_linkedin_url ~ '^https://www[.]linkedin[.]com/(in|company)/([A-Za-z0-9_-]|%[A-Fa-f0-9]{2})+$'
    )
  );

revoke insert (gender_description), update (gender_description)
  on public.matchmaking_profiles from authenticated;
comment on column public.matchmaking_profiles.gender_description is
  'Retired question. Existing self-descriptions remain owner-only; clients cannot add or edit them.';
comment on column public.matchmaking_profiles.romance_ideal_match is
  'Optional private preference; never returned by the released-match RPC.';
comment on column public.matchmaking_profiles.business_linkedin_url is
  'Optional canonical LinkedIn profile or company URL, shared only in business introductions.';
grant insert (romance_ideal_match, business_linkedin_url), update (romance_ideal_match, business_linkedin_url)
  on public.matchmaking_profiles to authenticated;

-- Adding an output column requires recreating this function. Preserve its
-- participant/release checks and explicitly restore authenticated-only access.
drop function public.get_my_matchmaking_matches();
create function public.get_my_matchmaking_matches()
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
    case when m.intent = 'friends' then p.friendship_interests else '' end,
    case when m.intent = 'business_partners' then p.business_about else '' end,
    case when m.intent = 'business_partners' then p.business_skills else '' end,
    case when m.intent = 'business_partners' then p.business_seeking else '' end,
    case when m.intent = 'business_partners' and p.intent = 'business_partners' then p.business_linkedin_url else '' end
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
