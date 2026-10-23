begin;

-- No current-read edit history existed before this limit. Existing profiles get
-- one initial change; thereafter the server records every addition or removal.
alter table public.matchmaking_profiles
  add column current_book_updated_at timestamptz;
revoke insert (current_book_updated_at), update (current_book_updated_at)
  on public.matchmaking_profiles from authenticated;

create or replace function public.normalize_matchmaking_current_reading()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.current_book := '';
  new.current_author := '';
  if new.current_book_id is not null then
    select b.title, b.author into new.current_book, new.current_author
      from public.matchmaking_books b where b.work_id = new.current_book_id;
    if not found then
      raise exception using errcode = '22023', message = 'Choose your current read from the suggestions';
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.current_book_updated_at := case when new.current_book_id is not null then now() else null end;
  elsif new.current_book_id is distinct from old.current_book_id then
    if old.current_book_updated_at > now() - interval '24 hours' then
      raise exception using errcode = 'P0001', message = 'CURRENT_READING_LOCKED';
    end if;
    -- Clearing the field also starts the interval; clearing and re-adding cannot
    -- bypass the limit. Favorite changes have a separate, unchanged edit clock.
    new.current_book_updated_at := now();
  else
    new.current_book_updated_at := old.current_book_updated_at;
  end if;
  return new;
end;
$$;
revoke all on function public.normalize_matchmaking_current_reading() from public, anon, authenticated;

-- Preserve the server-owned clock on all profile writes, including older clients.
drop trigger matchmaking_current_reading on public.matchmaking_profiles;
create trigger matchmaking_current_reading
before insert or update on public.matchmaking_profiles
for each row execute function public.normalize_matchmaking_current_reading();

comment on column public.matchmaking_profiles.current_book_id is
  'Optional current read. Changes, including clearing, are limited to once per rolling 24 hours. Excluded from favorite rankings; its edit clock is independent of favorites. Owner-only profile RLS applies.';
comment on column public.matchmaking_profiles.current_book_updated_at is
  'Server-owned time of the last current-read change. Null until the first recorded selection or change. Other profile edits do not reset it.';

notify pgrst, 'reload schema';
commit;
