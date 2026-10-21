begin;
create table public.matchmaking_books (
  work_id text primary key check (work_id ~ '^OL[0-9]+W$'),
  title text not null check (char_length(title) between 1 and 300),
  author text not null check (char_length(author) between 1 and 300),
  created_at timestamptz not null default now()
);
alter table public.matchmaking_books enable row level security;
revoke all on public.matchmaking_books from public, anon, authenticated;
grant select on public.matchmaking_books to authenticated;
grant all on public.matchmaking_books to service_role;
create policy "Members read the book catalog" on public.matchmaking_books for select to authenticated using (true);

create table public.matchmaking_book_search_cache (
  query text primary key, results jsonb not null, expires_at timestamptz not null
);
create table public.matchmaking_book_search_budget (
  id boolean primary key default true check (id), next_request_at timestamptz not null default now()
);
insert into public.matchmaking_book_search_budget (id) values (true);
alter table public.matchmaking_book_search_cache enable row level security;
alter table public.matchmaking_book_search_budget enable row level security;
revoke all on public.matchmaking_book_search_cache, public.matchmaking_book_search_budget from public, anon, authenticated;
grant all on public.matchmaking_book_search_cache, public.matchmaking_book_search_budget to service_role;

-- A shared limit across all Edge Function instances, below Open Library's
-- identified-client allowance of three upstream requests per second.
create function public.reserve_matchmaking_book_search()
returns boolean language plpgsql set search_path = '' as $$
declare reserved boolean;
begin
  update public.matchmaking_book_search_budget set next_request_at = clock_timestamp() + interval '400 milliseconds'
  where id and next_request_at <= clock_timestamp() returning true into reserved;
  return coalesce(reserved, false);
end;
$$;
revoke all on function public.reserve_matchmaking_book_search() from public, anon, authenticated;
grant execute on function public.reserve_matchmaking_book_search() to service_role;
commit;
