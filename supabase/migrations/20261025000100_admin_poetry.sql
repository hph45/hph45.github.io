begin;

-- Private collection: content is seeded through a privileged connection, not
-- committed to this public repository or bundled into the static website.
create table public.admin_poems (
  slug text primary key check (slug ~ '^[a-z0-9-]+$'),
  title text not null check (char_length(title) between 1 and 200),
  author text not null check (char_length(author) between 1 and 200),
  context text not null default '',
  body text not null check (char_length(body) between 1 and 50000),
  language text not null default 'en' check (language in ('en', 'es')),
  translation text not null default '',
  translation_note text not null default '',
  source_url text check (source_url is null or source_url ~ '^https://'),
  source_label text not null default '',
  sort_order integer not null check (sort_order >= 0)
);
alter table public.admin_poems enable row level security;
revoke all on public.admin_poems from public, anon, authenticated;
grant all on public.admin_poems to service_role;

create function public.get_admin_poetry()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.matchmaking_admin_access a where a.user_id = (select auth.uid())
  ) then
    raise exception using errcode = '42501', message = 'ADMIN_ONLY';
  end if;
  return (select coalesce(jsonb_agg(to_jsonb(p) order by p.sort_order, p.slug), '[]'::jsonb) from public.admin_poems p);
end;
$$;
revoke all on function public.get_admin_poetry() from public, anon, authenticated;
grant execute on function public.get_admin_poetry() to authenticated;
comment on table public.admin_poems is 'Private Kaizen poetry collection. Browser roles have no direct access. The read-only RPC checks the existing single-owner admin allowlist.';
comment on function public.get_admin_poetry() is 'Only the existing matchmaking admin may read this collection. Ordinary members and anonymous requests are denied.';

notify pgrst, 'reload schema';
commit;
