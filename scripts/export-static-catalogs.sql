-- Public reference metadata only. Never export profiles, searches, contact
-- details, or manually entered member text into this public website.
select jsonb_build_object(
  'books', (select jsonb_agg(jsonb_build_array(work_id, title, author) order by work_id)
    from public.matchmaking_books where work_id ~ '^OL[0-9]+W$'),
  'cities', (select jsonb_agg(jsonb_build_array(id, name, search_name, region, country, population) order by id)
    from public.matchmaking_cities),
  'featured', (select jsonb_agg(book order by votes desc, title, work_id) from (
    select b.work_id, b.title, b.author, count(distinct p.user_id) as votes
    from public.matchmaking_profiles p
    cross join lateral (values (p.favorite_book_id), (p.favorite_book_2_id), (p.favorite_book_3_id)) picks(work_id)
    join public.matchmaking_books b on b.work_id = picks.work_id
    group by b.work_id order by votes desc, b.title, b.work_id limit 20
  ) book)
) as catalogs;
