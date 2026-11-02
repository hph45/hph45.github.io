begin;

create table public.matchmaking_match_reviews (
  match_id uuid not null,
  user_id uuid not null,
  compatibility_rating smallint not null check (compatibility_rating between 1 and 5),
  book_rating smallint check (book_rating between 1 and 5),
  recommended_book_id text references public.matchmaking_books(work_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (match_id, user_id),
  foreign key (match_id, user_id) references public.matchmaking_match_members(match_id, user_id) on delete cascade,
  check ((recommended_book_id is null) = (book_rating is null))
);
alter table public.matchmaking_match_reviews enable row level security;
revoke all on public.matchmaking_match_reviews from public, anon, authenticated;
grant all on public.matchmaking_match_reviews to service_role;
comment on table public.matchmaking_match_reviews is
  'Private participant feedback. Each member can read/update only their own review through authenticated RPCs. Never included in counterpart introductions or community responses.';

create function public.get_my_matchmaking_match_review(p_match_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'SIGN_IN_REQUIRED';
  end if;
  if not exists (
    select 1 from public.matchmaking_matches m
    join public.matchmaking_match_members mm on mm.match_id = m.id and mm.user_id = v_user
    where m.id = p_match_id and m.released_at <= now()
      and (select count(*) from public.matchmaking_match_members members where members.match_id = m.id) = 2
  ) then
    raise exception using errcode = '42501', message = 'MATCH_REVIEW_NOT_AVAILABLE';
  end if;
  return (select jsonb_build_object('compatibility_rating', r.compatibility_rating,
    'book_rating', r.book_rating, 'recommended_book_id', r.recommended_book_id,
    'updated_at', r.updated_at)
    from public.matchmaking_match_reviews r where r.match_id = p_match_id and r.user_id = v_user);
end;
$$;
revoke all on function public.get_my_matchmaking_match_review(uuid) from public, anon, authenticated;
grant execute on function public.get_my_matchmaking_match_review(uuid) to authenticated;

create function public.save_matchmaking_match_review(
  p_match_id uuid, p_compatibility_rating integer, p_book_rating integer, p_recommended_book_id text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_book text;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'SIGN_IN_REQUIRED';
  end if;
  select m.recommended_book_id into v_book from public.matchmaking_matches m
    join public.matchmaking_match_members mm on mm.match_id = m.id and mm.user_id = v_user
    where m.id = p_match_id and m.released_at <= now()
      and (select count(*) from public.matchmaking_match_members members where members.match_id = m.id) = 2
    for share of m;
  if not found then
    raise exception using errcode = '42501', message = 'MATCH_REVIEW_NOT_AVAILABLE';
  end if;
  if p_compatibility_rating is null or p_compatibility_rating not between 1 and 5
    or (v_book is not null and (p_book_rating is null or p_book_rating not between 1 and 5))
    or (v_book is null and p_book_rating is not null) then
    raise exception using errcode = '22023', message = 'INVALID_MATCH_REVIEW_RATING';
  end if;
  if p_recommended_book_id is distinct from v_book then
    raise exception using errcode = '22023', message = 'MATCH_RECOMMENDATION_CHANGED';
  end if;
  insert into public.matchmaking_match_reviews as existing
    (match_id, user_id, compatibility_rating, book_rating, recommended_book_id)
  values (p_match_id, v_user, p_compatibility_rating, p_book_rating, v_book)
  on conflict (match_id, user_id) do update set
    compatibility_rating = excluded.compatibility_rating,
    book_rating = excluded.book_rating,
    recommended_book_id = excluded.recommended_book_id,
    updated_at = now()
  where (existing.compatibility_rating, existing.book_rating, existing.recommended_book_id)
    is distinct from (excluded.compatibility_rating, excluded.book_rating, excluded.recommended_book_id);
  return public.get_my_matchmaking_match_review(p_match_id);
end;
$$;
revoke all on function public.save_matchmaking_match_review(uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.save_matchmaking_match_review(uuid, integer, integer, text) to authenticated;

notify pgrst, 'reload schema';
commit;
