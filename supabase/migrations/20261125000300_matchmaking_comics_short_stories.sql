begin;

alter table public.matchmaking_profiles
  drop constraint valid_matchmaking_book_sources,
  add constraint valid_matchmaking_book_sources check (
    cardinality(book_sources) = 0 or (
      array_ndims(book_sources) = 1 and array_lower(book_sources, 1) = 1
      -- Count each allowed choice once. Extra, repeated, or null entries cannot fit.
      and cardinality(book_sources) = num_nonnulls(
        array_position(book_sources, 'library'), array_position(book_sources, 'bookstore'),
        array_position(book_sources, 'pre_loved'), array_position(book_sources, 'new'),
        array_position(book_sources, 'ebook'), array_position(book_sources, 'audiobook'),
        array_position(book_sources, 'comics'), array_position(book_sources, 'short_stories')
      )
    )
  );

comment on column public.matchmaking_profiles.book_sources is
  'Member-selected reading preferences. An empty array means the question is unanswered.';

commit;
