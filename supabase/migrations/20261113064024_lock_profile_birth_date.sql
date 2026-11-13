begin;

-- Keep profile creation unchanged. Older clients may still submit the saved
-- birthday along with other edits; accept that value but reject any change.
create function public.lock_matchmaking_birth_date()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.birth_date is distinct from old.birth_date then
    raise exception using errcode = '42501', message = 'BIRTH_DATE_LOCKED';
  end if;
  return new;
end;
$$;
revoke all on function public.lock_matchmaking_birth_date() from public, anon, authenticated;

create trigger matchmaking_birth_date_immutable
before update of birth_date on public.matchmaking_profiles
for each row execute function public.lock_matchmaking_birth_date();

comment on function public.lock_matchmaking_birth_date() is
  'Birthdays are fixed at profile creation. Unchanged values remain compatible with older clients; edits and clearing are rejected without changing other profile fields.';

commit;
