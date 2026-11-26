begin;

alter table public.matchmaking_profiles
  drop constraint valid_matchmaking_book_sources,
  add column reader_pick_id text references public.matchmaking_books(work_id),
  add column reader_pick text not null default '',
  add column reader_pick_author text not null default '',
  add column share_email_alongside_instagram boolean not null default false,
  add constraint valid_matchmaking_book_sources check (
    cardinality(book_sources) = 0 or (
      array_ndims(book_sources) = 1 and array_lower(book_sources, 1) = 1
      -- Count each allowed choice once. Extra, repeated, or null entries cannot fit.
      and cardinality(book_sources) = num_nonnulls(
        array_position(book_sources, 'library'), array_position(book_sources, 'bookstore'),
        array_position(book_sources, 'pre_loved'), array_position(book_sources, 'new'),
        array_position(book_sources, 'ebook'), array_position(book_sources, 'audiobook')
      )
    )
  );

grant insert (reader_pick_id, reader_pick, reader_pick_author, share_email_alongside_instagram),
      update (reader_pick_id, reader_pick, reader_pick_author, share_email_alongside_instagram)
  on public.matchmaking_profiles to authenticated;
comment on column public.matchmaking_profiles.share_email_alongside_instagram is
  'Explicit permission to show email alongside Instagram to released matches. Earlier consent allowed fallback only.';

-- Older clients can still switch off email contact using their original checkbox.
create function public.clear_matchmaking_email_permission()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.share_email_alongside_instagram := false;
  return new;
end;
$$;
revoke all on function public.clear_matchmaking_email_permission() from public, anon, authenticated;
create trigger matchmaking_clear_email_permission
before insert or update of share_email_with_matches, share_email_alongside_instagram on public.matchmaking_profiles
for each row when (not new.share_email_with_matches and new.share_email_alongside_instagram)
execute function public.clear_matchmaking_email_permission();

comment on column public.matchmaking_profiles.reader_pick_id is
  'Optional personal book recommendation shared with released matches.';

create function public.set_matchmaking_reader_pick()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.reader_pick_id = 'manual' then
    new.reader_pick_id := public.resolve_matchmaking_book_entry(new.reader_pick, new.reader_pick_author);
  end if;
  if new.reader_pick_id is null then
    new.reader_pick := '';
    new.reader_pick_author := '';
  else
    select b.title, b.author into strict new.reader_pick, new.reader_pick_author
      from public.matchmaking_books b where b.work_id = new.reader_pick_id;
  end if;
  return new;
end;
$$;
revoke all on function public.set_matchmaking_reader_pick() from public, anon, authenticated;
create trigger matchmaking_reader_pick
before insert or update of reader_pick_id, reader_pick, reader_pick_author on public.matchmaking_profiles
for each row execute function public.set_matchmaking_reader_pick();

-- Share the member's pick through the existing released, unblocked introduction.
create or replace function public.get_my_matchmaking_introductions(
  p_before_released_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 24
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := least(48, greatest(1, coalesce(p_limit, 24)));
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'SIGN_IN_REQUIRED';
  end if;
  if (p_before_released_at is null) <> (p_before_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_MATCH_CURSOR';
  end if;
  return (
    with available as materialized (
      select m.*, mine.revealed_at, mine.member_notice,
        theirs.user_id as other_user_id, theirs.contact_via_email as other_contact_via_email
      from public.matchmaking_matches m
      join public.matchmaking_match_members mine on mine.match_id = m.id and mine.user_id = (select auth.uid())
      join public.matchmaking_match_members theirs on theirs.match_id = m.id and theirs.user_id <> mine.user_id
      where m.released_at <= now()
        and not public.matchmaking_pair_blocked(mine.user_id, theirs.user_id)
        and (select count(*) from public.matchmaking_match_members mm where mm.match_id = m.id) = 2
    ), page as materialized (
      select * from available
      where p_before_released_at is null or (released_at, id) < (p_before_released_at, p_before_id)
      order by released_at desc, id desc limit v_limit
    ), last_item as (
      select released_at, id from page order by released_at, id limit 1
    ), items as (
      select m.released_at, m.id, jsonb_build_object(
        'id', m.id, 'week_start', m.week_start, 'released_at', m.released_at,
        'intent', m.intent, 'reason', concat_ws(E'\n\n', m.reason, nullif(btrim(m.member_notice), '')),
        'revealed_at', m.revealed_at,
        'display_name', p.display_name, 'age', extract(year from age(current_date, p.birth_date))::integer,
        'city', p.city, 'region', p.region, 'country', p.country,
        'favorite_book_id', p.favorite_book_id, 'favorite_book', p.favorite_book, 'favorite_author', p.favorite_author,
        'favorite_book_2_id', p.favorite_book_2_id, 'favorite_book_2', p.favorite_book_2, 'favorite_author_2', p.favorite_author_2,
        'favorite_book_3_id', p.favorite_book_3_id, 'favorite_book_3', p.favorite_book_3, 'favorite_author_3', p.favorite_author_3,
        'current_book_id', p.current_book_id, 'current_book', p.current_book, 'current_author', p.current_author,
        'reader_pick_id', p.reader_pick_id, 'reader_pick', p.reader_pick, 'reader_pick_author', p.reader_pick_author,
        'friendship_interests', case when m.intent = 'friends' and 'friends' = any(p.intents) then p.friendship_interests else '' end,
        'business_about', case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_about else '' end,
        'business_skills', case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_skills else '' end,
        'business_seeking', case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_seeking else '' end,
        'business_linkedin_url', case when m.intent = 'business_partners' and 'business_partners' = any(p.intents) then p.business_linkedin_url else '' end,
        'instagram_handle', case when m.other_contact_via_email then null else p.instagram_handle end,
        'contact_email', case when (p.share_email_alongside_instagram or m.other_contact_via_email or p.instagram_handle is null)
          and p.share_email_with_matches then nullif(btrim(u.email), '') else null end,
        'recommended_book', case when b.work_id is not null then jsonb_build_object(
          'work_id', b.work_id, 'title', b.title, 'author', b.author, 'reason', m.recommendation_reason) else null end
      ) as item
      from page m join public.matchmaking_profiles p on p.user_id = m.other_user_id
      join auth.users u on u.id = p.user_id
      left join public.matchmaking_books b on b.work_id = m.recommended_book_id
    )
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(item order by released_at desc, id desc) from items), '[]'::jsonb),
      'total_count', (select count(*) from available),
      'next_cursor', (select jsonb_build_object('released_at', l.released_at, 'id', l.id) from last_item l
        where exists (select 1 from available a where (a.released_at, a.id) < (l.released_at, l.id)))
    )
  );
end;
$$;
revoke all on function public.get_my_matchmaking_introductions(timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.get_my_matchmaking_introductions(timestamptz, uuid, integer) to authenticated;

notify pgrst, 'reload schema';
commit;
