begin;

-- Completing a read is one transaction: the existing profile trigger enforces
-- the same 24-hour clock as switching, and any failure rolls back both writes.
create function public.finish_my_matchmaking_current_read(p_work_id text, p_rating numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  member_id uuid := auth.uid();
  member public.matchmaking_profiles;
  saved_book jsonb;
begin
  if member_id is null then
    raise exception using errcode = '42501', message = 'Sign in to finish a book';
  end if;
  if p_rating is null or p_rating not between 0.25 and 5 or mod(p_rating, 0.25) <> 0 then
    raise exception using errcode = '22023', message = 'Choose a rating from 0.25 to 5 in quarter-star steps';
  end if;
  select * into member from public.matchmaking_profiles where user_id = member_id for update;
  if not found then raise exception using errcode = '23503', message = 'PROFILE_REQUIRED'; end if;
  -- A stale sheet or concurrent finish must never clear a different book.
  if member.current_book_id is null or p_work_id is distinct from member.current_book_id then
    raise exception using errcode = 'P0001', message = 'CURRENT_READING_CHANGED';
  end if;
  update public.matchmaking_profiles set current_book_id = null
    where user_id = member_id returning * into member;
  saved_book := public.save_my_matchmaking_library_book(p_work_id, '', '', p_rating);
  return jsonb_build_object('book', saved_book, 'current_book_updated_at', member.current_book_updated_at);
end;
$$;

revoke all on function public.finish_my_matchmaking_current_read(text, numeric) from public, anon, authenticated;
grant execute on function public.finish_my_matchmaking_current_read(text, numeric) to authenticated;
comment on function public.finish_my_matchmaking_current_read(text, numeric) is
  'Rate and move the signed-in member''s current read to their private library atomically. Preserves the existing 24-hour current-read limit and never changes favorites.';
notify pgrst, 'reload schema';
commit;
