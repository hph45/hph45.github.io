begin;

alter table public.matchmaking_match_reviews
  add column response_status text check (response_status in ('yes', 'no', 'not_contacted'));
comment on column public.matchmaking_match_reviews.response_status is
  'The reviewer’s answer about whether the other member responded. NULL means no answer was given.';

create or replace function public.get_my_matchmaking_match_review(p_match_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  reviewer uuid := auth.uid();
begin
  if reviewer is null then
    raise exception using errcode = '42501', message = 'SIGN_IN_REQUIRED';
  end if;
  if not exists (
    select 1 from public.matchmaking_matches m
    join public.matchmaking_match_members mine on mine.match_id = m.id and mine.user_id = reviewer
    join public.matchmaking_match_members other on other.match_id = m.id and other.user_id <> reviewer
    where m.id = p_match_id and m.released_at <= now()
      and (select count(*) from public.matchmaking_match_members mm where mm.match_id = m.id) = 2
      and not public.matchmaking_pair_blocked(reviewer, other.user_id)
  ) then
    raise exception using errcode = '42501', message = 'MATCH_REVIEW_NOT_AVAILABLE';
  end if;
  return (select jsonb_build_object(
    'response_status', r.response_status, 'compatibility_rating', r.compatibility_rating,
    'book_rating', r.book_rating, 'recommended_book_id', r.recommended_book_id, 'updated_at', r.updated_at)
    from public.matchmaking_match_reviews r where r.match_id = p_match_id and r.user_id = reviewer);
end;
$$;

-- Omitting the fifth argument keeps the saved answer, even when another client
-- edited it after the reviewer opened the form. Both edits commit together.
create function public.save_matchmaking_match_review(
  p_match_id uuid, p_compatibility_rating integer, p_book_rating integer,
  p_recommended_book_id text, p_response_status text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  saved jsonb;
begin
  saved := public.save_matchmaking_match_review(
    p_match_id, p_compatibility_rating, p_book_rating, p_recommended_book_id);
  if (saved->>'response_status') is distinct from p_response_status then
    update public.matchmaking_match_reviews
      set response_status = p_response_status, updated_at = now()
      where match_id = p_match_id and user_id = (select auth.uid());
    return public.get_my_matchmaking_match_review(p_match_id);
  end if;
  return saved;
end;
$$;
revoke all on function public.save_matchmaking_match_review(uuid, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.save_matchmaking_match_review(uuid, integer, integer, text, text) to authenticated;

create or replace view public.matchmaking_nonreview_reviews with (security_invoker = true) as
  select f.* from public.matchmaking_match_reviews f
  where not exists (select 1 from public.matchmaking_review_accounts r where r.user_id = f.user_id);

notify pgrst, 'reload schema';
commit;
