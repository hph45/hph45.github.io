begin;

-- Adding a book without a review preserves any rating already saved on another device.
create function public.add_my_unrated_matchmaking_library_book(p_work_id text, p_title text, p_author text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  book_id text := p_work_id;
begin
  if owner_id is null then raise exception using errcode = '42501', message = 'SIGN_IN_REQUIRED'; end if;
  if not exists (select 1 from public.matchmaking_profiles where user_id=owner_id) then
    raise exception using errcode = '23503', message = 'PROFILE_REQUIRED';
  end if;
  if book_id = 'manual' then book_id := public.resolve_matchmaking_book_entry(p_title, p_author); end if;
  insert into public.matchmaking_library_books(user_id, work_id) values (owner_id, book_id)
    on conflict (user_id, work_id) do nothing;
end;
$$;
revoke all on function public.add_my_unrated_matchmaking_library_book(text,text,text) from public, anon, authenticated;
grant execute on function public.add_my_unrated_matchmaking_library_book(text,text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
