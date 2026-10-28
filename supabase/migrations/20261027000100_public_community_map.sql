begin;

-- The public home page receives only city-center counts. Keep this separate
-- from the authenticated dashboard RPC, which also returns book statistics.
create table public.matchmaking_public_map_cache (
  id boolean primary key default true check (id),
  payload jsonb not null default '{"total_members":0,"cities":[]}'::jsonb,
  refreshed_at timestamptz not null default '-infinity'::timestamptz
);
alter table public.matchmaking_public_map_cache enable row level security;
revoke all on public.matchmaking_public_map_cache from public, anon, authenticated;
grant all on public.matchmaking_public_map_cache to service_role;
insert into public.matchmaking_public_map_cache (id) values (true);

create function public.get_public_matchmaking_map()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_payload jsonb;
  v_refreshed_at timestamptz;
begin
  select payload, refreshed_at into v_payload, v_refreshed_at
    from public.matchmaking_public_map_cache where id;
  if v_refreshed_at > now() - interval '1 hour' then return v_payload; end if;

  -- Only one visitor rebuilds an expired snapshot. Concurrent visitors recheck
  -- the timestamp after acquiring the row lock and reuse the refreshed result.
  select payload, refreshed_at into v_payload, v_refreshed_at
    from public.matchmaking_public_map_cache where id for update;
  if v_refreshed_at > now() - interval '1 hour' then return v_payload; end if;

  v_refreshed_at := clock_timestamp();
  with city_counts as (
    select c.id, c.name, c.region, c.country, c.latitude, c.longitude,
      count(*) as member_count
    from public.matchmaking_profiles p
    join public.matchmaking_cities c on c.id = p.city_id
    group by c.id
  )
  select jsonb_build_object(
    'generated_at', v_refreshed_at,
    'total_members', coalesce(sum(member_count), 0),
    'cities', coalesce(jsonb_agg(to_jsonb(city_counts) order by id), '[]'::jsonb)
  ) into v_payload from city_counts;

  update public.matchmaking_public_map_cache
    set payload = v_payload, refreshed_at = v_refreshed_at where id;
  return v_payload;
end;
$$;
revoke all on function public.get_public_matchmaking_map() from public, anon, authenticated;
grant execute on function public.get_public_matchmaking_map() to anon, authenticated, service_role;
comment on function public.get_public_matchmaking_map() is
  'Public city-center counts and completed-profile total, cached for one hour. Includes paused profiles, like the member dashboard. No names, account IDs, contact details, books, preferences, or individual profile links.';

commit;
