begin;

-- A private reading library. These rows do not vote in the community ranking
-- and do not change the three favorites or either profile book-edit clock.
create table public.matchmaking_library_books (
  user_id uuid not null references public.matchmaking_profiles(user_id) on delete cascade,
  work_id text not null references public.matchmaking_books(work_id),
  rating numeric check (rating between 0.25 and 5 and mod(rating, 0.25) = 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, work_id)
);
create index matchmaking_library_recent on public.matchmaking_library_books (user_id, updated_at desc, work_id);
alter table public.matchmaking_library_books enable row level security;
revoke all on public.matchmaking_library_books from public, anon, authenticated;
grant select on public.matchmaking_library_books to authenticated;
grant all on public.matchmaking_library_books to service_role;
create policy "Members read their own book library"
  on public.matchmaking_library_books for select to authenticated
  using ((select auth.uid()) = user_id);

create function public.get_my_matchmaking_library(p_offset integer default 0, p_limit integer default 50)
returns table(work_id text, title text, author text, rating numeric, updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select l.work_id, b.title, b.author, l.rating, l.updated_at
  from public.matchmaking_library_books l
  join public.matchmaking_books b on b.work_id = l.work_id
  where l.user_id = (select auth.uid())
  order by l.updated_at desc, l.work_id
  limit greatest(1, least(coalesce(p_limit, 50), 100)) offset greatest(0, coalesce(p_offset, 0));
$$;

create function public.save_my_matchmaking_library_book(p_work_id text, p_title text default '', p_author text default '', p_rating numeric default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  member_id uuid := auth.uid();
  resolved_id text := p_work_id;
  result jsonb;
begin
  if member_id is null then raise exception using errcode = '42501', message = 'Sign in to save books'; end if;
  if not exists (select 1 from public.matchmaking_profiles p where p.user_id = member_id) then
    raise exception using errcode = '23503', message = 'PROFILE_REQUIRED';
  end if;
  if p_rating is not null and (p_rating not between 0.25 and 5 or mod(p_rating, 0.25) <> 0) then
    raise exception using errcode = '22023', message = 'Choose a rating from 0.25 to 5 in quarter-star steps';
  end if;
  if p_work_id = 'manual' then
    resolved_id := public.resolve_matchmaking_book_entry(p_title, p_author);
  end if;
  if resolved_id is null or not exists (select 1 from public.matchmaking_books b where b.work_id = resolved_id) then
    raise exception using errcode = '22023', message = 'Choose a valid book';
  end if;
  insert into public.matchmaking_library_books(user_id, work_id, rating)
    values(member_id, resolved_id, p_rating)
    on conflict (user_id, work_id) do update set rating = excluded.rating, updated_at = now();
  select jsonb_build_object('work_id', l.work_id, 'title', b.title, 'author', b.author,
    'rating', l.rating, 'updated_at', l.updated_at) into result
    from public.matchmaking_library_books l join public.matchmaking_books b on b.work_id = l.work_id
    where l.user_id = member_id and l.work_id = resolved_id;
  return result;
end;
$$;

create function public.remove_my_matchmaking_library_book(p_work_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'Sign in to remove books'; end if;
  delete from public.matchmaking_library_books where user_id = (select auth.uid()) and work_id = p_work_id;
end;
$$;

revoke all on function public.get_my_matchmaking_library(integer, integer) from public, anon, authenticated;
revoke all on function public.save_my_matchmaking_library_book(text, text, text, numeric) from public, anon, authenticated;
revoke all on function public.remove_my_matchmaking_library_book(text) from public, anon, authenticated;
grant execute on function public.get_my_matchmaking_library(integer, integer) to authenticated;
grant execute on function public.save_my_matchmaking_library_book(text, text, text, numeric) to authenticated;
grant execute on function public.remove_my_matchmaking_library_book(text) to authenticated;

comment on table public.matchmaking_library_books is
  'Private member book library and optional 0.25–5 star ratings in quarter-star steps. Separate from matchmaking favorites, rankings and edit clocks. Writes derive the owner from auth.uid(), never a caller-supplied user ID.';

notify pgrst, 'reload schema';
commit;
