begin;

-- Keep the arrival time of each currently selected book, independently of slot
-- order and the profile's 24-hour bookshelf-editing clock. No client access.
create table public.matchmaking_favorite_selections (
  user_id uuid not null references public.matchmaking_profiles(user_id) on delete cascade,
  work_id text not null references public.matchmaking_books(work_id),
  added_at timestamptz not null default now(),
  primary key (user_id, work_id)
);
create index matchmaking_favorites_recent on public.matchmaking_favorite_selections (added_at, work_id);
create index matchmaking_favorites_work on public.matchmaking_favorite_selections (work_id);
alter table public.matchmaking_favorite_selections enable row level security;
revoke all on public.matchmaking_favorite_selections from public, anon, authenticated;
grant all on public.matchmaking_favorite_selections to service_role;

-- Historical per-book dates were not recorded. Use profile creation as a
-- conservative starting point, rather than make unchanged books look new.
insert into public.matchmaking_favorite_selections (user_id, work_id, added_at)
select p.user_id, picks.work_id, p.created_at
from public.matchmaking_profiles p
cross join lateral (values (p.favorite_book_id), (p.favorite_book_2_id), (p.favorite_book_3_id)) picks(work_id)
where picks.work_id is not null;

create function public.sync_matchmaking_favorite_selections()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.matchmaking_favorite_selections f
  where f.user_id = new.user_id and not exists (
    select 1 from unnest(array[new.favorite_book_id, new.favorite_book_2_id, new.favorite_book_3_id]) picks(work_id)
    where picks.work_id = f.work_id
  );
  insert into public.matchmaking_favorite_selections (user_id, work_id)
  select new.user_id, picks.work_id
  from unnest(array[new.favorite_book_id, new.favorite_book_2_id, new.favorite_book_3_id]) picks(work_id)
  where picks.work_id is not null
  on conflict (user_id, work_id) do nothing;
  return new;
end;
$$;
revoke all on function public.sync_matchmaking_favorite_selections() from public, anon, authenticated;
create trigger matchmaking_sync_favorites
after insert or update of favorite_book_id, favorite_book_2_id, favorite_book_3_id
on public.matchmaking_profiles for each row execute function public.sync_matchmaking_favorite_selections();

-- One shared snapshot, refreshed on the first dashboard request after 48 hours.
-- Store all ranked candidates so a book entering the live Top Ten can be
-- skipped immediately without recalculating the recent-favorites ranking.
create table public.matchmaking_rising_snapshot (
  singleton boolean primary key default true check (singleton),
  refreshed_at timestamptz,
  rankings jsonb not null default '[]'::jsonb check (jsonb_typeof(rankings) = 'array')
);
insert into public.matchmaking_rising_snapshot (singleton) values (true);
alter table public.matchmaking_rising_snapshot enable row level security;
revoke all on public.matchmaking_rising_snapshot from public, anon, authenticated;
grant all on public.matchmaking_rising_snapshot to service_role;

create or replace function public.get_matchmaking_community()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  snapshot_time timestamptz;
  snapshot_rankings jsonb;
  top_books jsonb;
begin
  select s.refreshed_at, s.rankings into snapshot_time, snapshot_rankings
  from public.matchmaking_rising_snapshot s where s.singleton;

  if snapshot_time is null or snapshot_time <= now() - interval '48 hours' then
    -- Recheck under a row lock so simultaneous requests share one refresh.
    select s.refreshed_at, s.rankings into snapshot_time, snapshot_rankings
    from public.matchmaking_rising_snapshot s where s.singleton for update;
    if snapshot_time is null or snapshot_time <= now() - interval '48 hours' then
      snapshot_time := now();
      select coalesce(jsonb_agg(to_jsonb(ranked) order by ranked.votes desc, ranked.title, ranked.work_id), '[]'::jsonb)
      into snapshot_rankings from (
        select b.work_id, b.title, count(*) as votes
        from public.matchmaking_favorite_selections f
        join public.matchmaking_books b on b.work_id = f.work_id
        where f.added_at >= snapshot_time - interval '7 days' and f.added_at <= snapshot_time
        group by b.work_id
      ) ranked;
      update public.matchmaking_rising_snapshot
      set refreshed_at = snapshot_time, rankings = snapshot_rankings where singleton;
    end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(ranked) order by ranked.votes desc, ranked.title, ranked.work_id), '[]'::jsonb)
  into top_books from (
    select b.work_id, b.title, b.author, count(distinct p.user_id) as votes
    from public.matchmaking_profiles p
    cross join lateral (values (p.favorite_book_id), (p.favorite_book_2_id), (p.favorite_book_3_id)) picks(work_id)
    join public.matchmaking_books b on b.work_id = picks.work_id
    group by b.work_id order by votes desc, b.title, b.work_id limit 10
  ) ranked;

  return jsonb_build_object(
    'total_members', (select count(*) from public.matchmaking_profiles),
    'cities', coalesce((
      select jsonb_agg(to_jsonb(city_counts)) from (
        select c.id, c.name, c.region, c.country, c.latitude, c.longitude, count(*) as member_count
        from public.matchmaking_profiles p join public.matchmaking_cities c on c.id = p.city_id
        group by c.id order by c.id
      ) city_counts
    ), '[]'::jsonb),
    'top_books', top_books,
    'rising_books', coalesce((
      select jsonb_agg(ranked.book order by ranked.rank) from (
        select jsonb_build_object('work_id', b.work_id, 'title', b.title, 'author', b.author) as book, candidate.rank
        from jsonb_array_elements(snapshot_rankings) with ordinality candidate(book, rank)
        join public.matchmaking_books b on b.work_id = candidate.book->>'work_id'
        where not exists (select 1 from jsonb_array_elements(top_books) top_book where top_book->>'work_id' = b.work_id)
          and exists (select 1 from public.matchmaking_favorite_selections f where f.work_id = b.work_id)
        order by candidate.rank limit 2
      ) ranked
    ), '[]'::jsonb),
    'rising_refreshed_at', snapshot_time
  );
end;
$$;
revoke all on function public.get_matchmaking_community() from public, anon, authenticated;
grant execute on function public.get_matchmaking_community() to authenticated;

comment on table public.matchmaking_favorite_selections is
  'Private current favorites and server-recorded addition dates. Initial dates conservatively use profile creation; deleted profiles cascade.';
comment on table public.matchmaking_rising_snapshot is
  'Anonymous ranking of current favorites added in the last 7 days, cached for 48 hours. No member identifiers.';

commit;
