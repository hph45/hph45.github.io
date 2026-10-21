begin;

-- The explanation question has been retired. Keep previously submitted answers
-- private without deleting existing data; new profiles do not need an answer.
alter table public.matchmaking_profiles
  drop constraint matchmaking_profiles_book_reason_check,
  alter column book_reason set default '';
alter table public.matchmaking_profiles
  add constraint matchmaking_profiles_book_reason_check
  check (char_length(book_reason) <= 1000);
revoke insert (book_reason), update (book_reason)
  on public.matchmaking_profiles from authenticated;
comment on column public.matchmaking_profiles.book_reason is
  'Retired question. Legacy answers are owner-only; clients cannot add or edit them.';

-- Keep the RPC signature compatible while ensuring legacy answers never appear
-- in introductions. Only the three favorite-book slots remain user-editable.
create or replace function public.get_my_matchmaking_matches()
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
    p.favorite_book_2, p.favorite_author_2, p.favorite_book_3, p.favorite_author_3, ''::text,
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

commit;
