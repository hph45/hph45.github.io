-- Aggregate-only public evidence. Run with an authorized database connection.
-- No identities, contact details, preferences, or activity histories are exported.
begin transaction isolation level repeatable read read only;
with profiles as (
  select p.city_id, p.is_active
  from public.matchmaking_profiles p join auth.users u on u.id = p.user_id
  where u.deleted_at is null
    and not coalesce(u.is_anonymous, false)
    and (u.banned_until is null or u.banned_until <= transaction_timestamp())
    and not exists (
      select 1 from public.matchmaking_review_accounts r where r.user_id = u.id
    )
), reader_countries as (
  select distinct c.country
  from profiles p join public.matchmaking_cities c on c.id = p.city_id
), map_locations as (
  -- For tiny regions missing from the world outline, use a public catalog
  -- location. The largest catalog city is independent of any member's city.
  select distinct on (c.country) c.country, c.longitude, c.latitude
  from public.matchmaking_cities c join reader_countries r using (country)
  order by c.country, c.population desc, c.id
), released_pairs as (
  -- A release requires two participants. Count the release once even if a
  -- participant has since deleted their profile and its membership row.
  select m.id from public.matchmaking_matches m
  where m.released_at <= transaction_timestamp() and not exists (
    select 1 from public.matchmaking_match_members mm
    join public.matchmaking_review_accounts r on r.user_id = mm.user_id
    where mm.match_id = m.id
  )
)
select
  2 as methodology_version,
  to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as measured_at,
  (select count(*) from profiles where is_active) as active_accounts,
  (select count(*) from reader_countries) as reader_country_count,
  (select coalesce(jsonb_agg(to_jsonb(l) order by country), '[]'::jsonb) from map_locations l) as reader_countries,
  (select count(*) from released_pairs) as matches_made;
commit;
