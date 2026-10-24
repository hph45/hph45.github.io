begin;

-- Open Library works keep their existing IDs. Books entered by members receive
-- a stable local ID, shared across case, spacing, and punctuation variations.
alter table public.matchmaking_books drop constraint matchmaking_books_work_id_check;
alter table public.matchmaking_books add constraint matchmaking_books_work_id_check
  check (work_id ~ '^(OL[0-9]+W|ZB[0-9a-f]{32})$');

create function public.matchmaking_book_key(value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select regexp_replace(lower(normalize(coalesce(value, ''), NFKC)), '[[:space:][:punct:]]', '', 'g');
$$;
revoke all on function public.matchmaking_book_key(text) from public, anon, authenticated;
grant execute on function public.matchmaking_book_key(text) to authenticated, service_role;

create index matchmaking_books_title_author_key on public.matchmaking_books
  (public.matchmaking_book_key(title), public.matchmaking_book_key(author));

-- Private helper: only the profile trigger can create local catalog entries.
-- A failed profile save rolls back the book insert in the same transaction.
create function public.resolve_matchmaking_book_entry(book_title text, book_author text)
returns text language plpgsql set search_path = '' as $$
declare
  clean_title text := btrim(regexp_replace(coalesce(book_title, ''), '[[:space:]]+', ' ', 'g'));
  clean_author text := coalesce(nullif(btrim(regexp_replace(coalesce(book_author, ''), '[[:space:]]+', ' ', 'g')), ''), 'Unknown author');
  title_key text;
  author_key text;
  resolved_id text;
  author_count integer;
begin
  if char_length(clean_title) not between 1 and 300 or char_length(clean_author) not between 1 and 300 then
    raise exception using errcode = '22023', message = 'Enter a book title and an author of no more than 300 characters';
  end if;
  title_key := public.matchmaking_book_key(clean_title);
  author_key := public.matchmaking_book_key(clean_author);
  if title_key = '' then
    raise exception using errcode = '22023', message = 'Enter a book title';
  end if;

  -- Without an author, use a known work only when the title is unambiguous.
  if author_key = 'unknownauthor' then
    select count(distinct public.matchmaking_book_key(b.author)) into author_count
      from public.matchmaking_books b
      where public.matchmaking_book_key(b.title) = title_key
        and public.matchmaking_book_key(b.author) <> 'unknownauthor';
    if author_count = 1 then
      select b.work_id into resolved_id from public.matchmaking_books b
        where public.matchmaking_book_key(b.title) = title_key
          and public.matchmaking_book_key(b.author) <> 'unknownauthor'
        order by (b.work_id like 'OL%') desc, b.work_id limit 1;
      return resolved_id;
    end if;
  end if;
  select b.work_id into resolved_id from public.matchmaking_books b
    where public.matchmaking_book_key(b.title) = title_key
      and public.matchmaking_book_key(b.author) = author_key
    order by (b.work_id like 'OL%') desc, b.work_id limit 1;
  if found then return resolved_id; end if;

  resolved_id := 'ZB' || md5(jsonb_build_array(title_key, author_key)::text);
  insert into public.matchmaking_books(work_id, title, author)
    values (resolved_id, clean_title, clean_author)
    on conflict (work_id) do nothing;
  return resolved_id;
end;
$$;
revoke all on function public.resolve_matchmaking_book_entry(text, text) from public, anon, authenticated;

create function public.resolve_matchmaking_profile_books()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- The explicit sentinel leaves older clients' null/clear behavior unchanged.
  if new.favorite_book_id = 'manual' then
    new.favorite_book_id := public.resolve_matchmaking_book_entry(new.favorite_book, new.favorite_author);
  end if;
  if new.favorite_book_2_id = 'manual' then
    new.favorite_book_2_id := public.resolve_matchmaking_book_entry(new.favorite_book_2, new.favorite_author_2);
  end if;
  if new.favorite_book_3_id = 'manual' then
    new.favorite_book_3_id := public.resolve_matchmaking_book_entry(new.favorite_book_3, new.favorite_author_3);
  end if;
  if new.current_book_id = 'manual' then
    new.current_book_id := public.resolve_matchmaking_book_entry(new.current_book, new.current_author);
  end if;
  return new;
end;
$$;
revoke all on function public.resolve_matchmaking_profile_books() from public, anon, authenticated;

-- Runs before the existing canonical-label, duplicate, and 24-hour checks.
-- Ownership policies, grants, and both edit clocks remain unchanged.
create trigger matchmaking_book_entries
before insert or update on public.matchmaking_profiles
for each row execute function public.resolve_matchmaking_profile_books();

-- Search only the book catalog, never member profiles. This works without
-- Open Library or an Edge Function and supports typed-in titles as well.
create function public.search_matchmaking_books(query text)
returns table(work_id text, title text, author text, cover_id bigint)
language sql stable security invoker set search_path = '' as $$
  select b.work_id, b.title, b.author, null::bigint
  from public.matchmaking_books b
  where char_length(btrim(query)) between 2 and 120
    and public.matchmaking_book_key(query) <> ''
    and strpos(public.matchmaking_book_key(b.title || ' ' || b.author), public.matchmaking_book_key(query)) > 0
  order by
    case when public.matchmaking_book_key(b.title) = public.matchmaking_book_key(query) then 0
      when strpos(public.matchmaking_book_key(b.title), public.matchmaking_book_key(query)) = 1 then 1
      else 2 end,
    (b.work_id like 'OL%') desc, b.title, b.work_id
  limit 8;
$$;
revoke all on function public.search_matchmaking_books(text) from public, anon, authenticated;
grant execute on function public.search_matchmaking_books(text) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
