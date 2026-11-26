begin;

alter table public.matchmaking_profiles
  add column book_sources text[] not null default '{}',
  add constraint valid_matchmaking_book_sources check (
    cardinality(book_sources) = 0 or (
      array_ndims(book_sources) = 1 and array_lower(book_sources, 1) = 1
      -- Count each allowed choice once. Extra, repeated, or null entries cannot fit.
      and cardinality(book_sources) = num_nonnulls(
        array_position(book_sources, 'library'), array_position(book_sources, 'bookstore'),
        array_position(book_sources, 'pre_loved'), array_position(book_sources, 'new'),
        array_position(book_sources, 'ebook')
      )
    )
  );

grant insert (book_sources), update (book_sources) on public.matchmaking_profiles to authenticated;
comment on column public.matchmaking_profiles.book_sources is
  'Ways the member likes to get books. An empty array means the question is unanswered.';

commit;
