begin;

-- Search the current Auth email only after the existing admin check succeeds.
-- Emails remain server-side search fields and are not added to profile results.
create or replace function public.get_matchmaking_admin_profiles(
  p_search text default '',
  p_intent text default null,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_search text := lower(left(btrim(coalesce(p_search, '')), 200));
  v_intent text := nullif(p_intent, '');
  v_limit integer := least(50, greatest(1, coalesce(p_page_size, 20)));
begin
  if not exists (
    select 1 from public.matchmaking_admin_access a where a.user_id = (select auth.uid())
  ) then
    raise exception using errcode = '42501', message = 'ADMIN_ONLY';
  end if;
  if v_intent is not null and v_intent not in ('romance', 'friends', 'business_partners') then
    raise exception using errcode = '22023', message = 'INVALID_CONNECTION_TYPE';
  end if;

  return (
    with filtered as materialized (
      select p.* from public.matchmaking_profiles p
      join auth.users u on u.id = p.user_id
      where (v_intent is null or v_intent = any(p.intents))
        and (v_search = '' or strpos(lower(concat_ws(' ', p.display_name, u.email, p.city, p.region, p.country,
          p.favorite_book, p.favorite_author, p.favorite_book_2, p.favorite_author_2,
          p.favorite_book_3, p.favorite_author_3)), v_search) > 0)
    ), totals as (
      select count(*) as total_count from filtered
    ), pagination as (
      select total_count,
        least(greatest(1, coalesce(p_page, 1)), greatest(1, ceil(total_count::numeric / v_limit)::integer)) as page
      from totals
    ), page_profiles as (
      select p.* from filtered p
      order by p.created_at desc, p.user_id
      limit v_limit offset (select (page::bigint - 1) * v_limit from pagination)
    ), profiles as (
      select p.created_at, p.user_id, jsonb_build_object(
        'display_name', p.display_name,
        'age', extract(year from age(current_date, p.birth_date))::integer,
        'city', p.city, 'region', p.region, 'country', p.country,
        'intents', p.intents,
        'is_active', p.is_active, 'email_matches', p.email_matches,
        'location_preference', p.location_preference,
        'favorite_books', (
          select jsonb_agg(jsonb_build_object('title', title, 'author', author) order by position)
          from (values (1, p.favorite_book_id, p.favorite_book, p.favorite_author),
            (2, p.favorite_book_2_id, p.favorite_book_2, p.favorite_author_2),
            (3, p.favorite_book_3_id, p.favorite_book_3, p.favorite_author_3)) books(position, work_id, title, author)
          where work_id is not null
        ),
        'gender', case when 'romance' = any(p.intents) then p.gender else null end,
        'interested_in', case when 'romance' = any(p.intents) then p.interested_in else array[]::text[] end,
        'age_min', case when 'romance' = any(p.intents) then p.age_min else null end,
        'age_max', case when 'romance' = any(p.intents) then p.age_max else null end,
        'romance_ideal_match', case when 'romance' = any(p.intents) then p.romance_ideal_match else '' end,
        'friendship_interests', case when 'friends' = any(p.intents) then p.friendship_interests else '' end,
        'business_about', case when 'business_partners' = any(p.intents) then p.business_about else '' end,
        'business_skills', case when 'business_partners' = any(p.intents) then p.business_skills else '' end,
        'business_seeking', case when 'business_partners' = any(p.intents) then p.business_seeking else '' end,
        'business_linkedin_url', case when 'business_partners' = any(p.intents) then p.business_linkedin_url else '' end
      ) as profile
      from page_profiles p
    )
    select jsonb_build_object(
      'total_count', total_count, 'page', page, 'page_size', v_limit,
      'profiles', coalesce((select jsonb_agg(profile order by created_at desc, user_id) from profiles), '[]'::jsonb)
    ) from pagination
  );
end;
$$;
revoke all on function public.get_matchmaking_admin_profiles(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.get_matchmaking_admin_profiles(text, text, integer, integer) to authenticated;
comment on function public.get_matchmaking_admin_profiles(text, text, integer, integer) is
  'Owner-only review of current profiles, books, and selected connection answers. Searches names, current account emails, locations, and books. Checks the admin Auth ID on every page request. Does not return birthdays, emails, Auth IDs, or retired answers.';


commit;
