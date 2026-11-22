-- Read-only input to the offline matcher. Keep its output in .matchmaking-private.
begin isolation level repeatable read read only;
select jsonb_build_object(
  'schema_version', 1,
  'snapshot_at', now(),
  'as_of_date', (now() at time zone 'America/Los_Angeles')::date,
  'profiles', coalesce((select jsonb_agg(jsonb_build_object(
    'user_id', p.user_id, 'name', p.display_name,
    'age', extract(year from age((now() at time zone 'America/Los_Angeles')::date,p.birth_date))::integer,
    'city_id', p.city_id, 'city', p.city, 'region', p.region, 'country', p.country,
    'latitude', c.latitude, 'longitude', c.longitude,
    'intents', p.intents, 'is_active', p.is_active,
    'location_preference', p.location_preference,
    'match_radius_miles', p.match_radius_miles,
    'gender', p.gender, 'interested_in', p.interested_in,
    'age_min', p.age_min, 'age_max', p.age_max,
    'instagram_handle', p.instagram_handle,
    'has_contact', (nullif(btrim(p.instagram_handle),'') is not null or
      (p.share_email_with_matches and nullif(u.email,'') is not null)),
    'has_signup_email', nullif(u.email,'') is not null,
    'share_email_with_matches', p.share_email_with_matches, 'email_matches', p.email_matches,
    'favorites', (select jsonb_agg(b) from (values
      (jsonb_build_object('id',p.favorite_book_id,'title',p.favorite_book,'author',p.favorite_author)),
      (case when p.favorite_book_2_id is not null then jsonb_build_object('id',p.favorite_book_2_id,'title',p.favorite_book_2,'author',p.favorite_author_2) end),
      (case when p.favorite_book_3_id is not null then jsonb_build_object('id',p.favorite_book_3_id,'title',p.favorite_book_3,'author',p.favorite_author_3) end)
    ) books(b) where b is not null),
    'currently_reading', case when p.current_book_id is not null then jsonb_build_object(
      'id',p.current_book_id,'title',p.current_book,'author',p.current_author) end,
    'romance_ideal_match', case when 'romance'=any(p.intents) then p.romance_ideal_match else '' end,
    'friendship_interests', case when 'friends'=any(p.intents) then p.friendship_interests else '' end,
    'business_about', case when 'business_partners'=any(p.intents) then p.business_about else '' end,
    'business_skills', case when 'business_partners'=any(p.intents) then p.business_skills else '' end,
    'business_seeking', case when 'business_partners'=any(p.intents) then p.business_seeking else '' end,
    'created_at',p.created_at,'updated_at',p.updated_at
  ) order by p.user_id) from public.matchmaking_profiles p
    join public.matchmaking_cities c on c.id=p.city_id
    join auth.users u on u.id=p.user_id),'[]'::jsonb),
  'books', coalesce((select jsonb_agg(to_jsonb(b) order by b.work_id) from public.matchmaking_books b),'[]'::jsonb),
  'library', coalesce((select jsonb_agg(to_jsonb(l) order by l.user_id,l.work_id) from public.matchmaking_library_books l),'[]'::jsonb),
  'matches', coalesce((select jsonb_agg(jsonb_build_object(
    'id',m.id,'intent',m.intent,'released_at',m.released_at,'week_start',m.week_start,
    'recommended_book_id',m.recommended_book_id,
    'members',(select jsonb_agg(jsonb_build_object('user_id',mm.user_id,
      'optional_friendship',mm.optional_friendship,'contact_via_email',mm.contact_via_email,
      'member_notice',mm.member_notice,'revealed_at',mm.revealed_at) order by mm.user_id)
      from public.matchmaking_match_members mm where mm.match_id=m.id)
  ) order by m.id) from public.matchmaking_matches m),'[]'::jsonb),
  'reviews', coalesce((select jsonb_agg(to_jsonb(r) order by r.match_id,r.user_id) from public.matchmaking_match_reviews r),'[]'::jsonb),
  'blocks', coalesce((select jsonb_agg(to_jsonb(b) order by b.blocker_id,b.blocked_id) from public.matchmaking_member_blocks b),'[]'::jsonb),
  'pending_reports', coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'reported_id',r.reported_id,
    'reporter_id',r.reporter_id,'reason',r.reason,'status',r.status) order by r.id)
    from public.matchmaking_member_reports r where r.status='pending'),'[]'::jsonb),
  'review_accounts', coalesce((select jsonb_agg(to_jsonb(r) order by r.user_id) from public.matchmaking_review_accounts r),'[]'::jsonb)
) as planning_snapshot;
rollback;
