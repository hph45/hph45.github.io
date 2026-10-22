import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("Rising favorites records real additions, protects private selections, and shares a 48-hour ranking", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to authenticated;
  `);
  const migrationFolder = new URL("../../supabase/migrations/", import.meta.url);
  let nextID = 1;
  const member = async (book, daysAgo = 1, extraBook = null) => {
    const id = `00000000-0000-4000-8000-${String(nextID++).padStart(12, "0")}`;
    await db.query("insert into auth.users(id) values ($1)", [id]);
    await db.query(`insert into public.matchmaking_profiles
      (user_id,display_name,birth_date,city_id,city,country,intent,favorite_book_id,favorite_book,favorite_author,
       favorite_book_2_id,location_preference,friendship_interests,created_at,books_updated_at)
      values ($1,'Private reader','1994-06-15',5378538,'Oakland','United States','friends',$2,'Book','Author',
        $3,'anywhere','Bookshop afternoons',now() - interval '30 days',now() - interval '2 days')`, [id, book, extraBook]);
    if (daysAgo !== null) await db.query("update public.matchmaking_favorite_selections set added_at=now() - $1 * interval '1 day' where user_id=$2", [daysAgo, id]);
    return id;
  };
  let legacy;
  for (const file of (await readdir(migrationFolder)).filter(file => file.endsWith(".sql")).sort()) {
    if (file === "20261021000500_rising_favorites.sql") {
      await db.exec("insert into public.matchmaking_books(work_id,title,author) values ('OL900W','Legacy book','Author')");
      legacy = await member("OL900W", null);
    }
    await db.exec(await readFile(new URL(file, migrationFolder), "utf8"));
  }
  const asUser = async (id, fn) => {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    try { return await fn(); } finally { await db.exec("reset role"); }
  };
  const denied = promise => assert.rejects(promise, error => error.code === "42501");
  const community = async () => (await asUser(legacy, () => db.query("select public.get_matchmaking_community() as data"))).rows[0].data;
  const snapshot = async () => (await db.query("select * from public.matchmaking_rising_snapshot")).rows[0];
  const selections = async id => (await db.query("select work_id,added_at from public.matchmaking_favorite_selections where user_id=$1 order by work_id", [id])).rows;

  await t.test("migration does not mistake all books on a recently edited shelf for new additions", async () => {
    const row = (await db.query(`select f.added_at,p.created_at,p.books_updated_at from public.matchmaking_favorite_selections f
      join public.matchmaking_profiles p using(user_id) where user_id=$1`, [legacy])).rows[0];
    assert.deepEqual(row.added_at, row.created_at);
    assert.ok(new Date(row.added_at) < new Date(row.books_updated_at));
  });
  await db.exec(`insert into public.matchmaking_books(work_id,title,author)
    select 'OL' || n || 'W', case when n <= 1010 then 'Top book ' || n
      when n in (1013,1016) then 'Alpha rising' when n=1011 then 'Zulu rising' else 'Book ' || n end, 'Author'
    from generate_series(1001,1016) n`);

  await t.test("new books use the server clock; unchanged/reordered books retain their dates", async () => {
    const id = await member("OL1011W", 10, "OL1012W");
    const before = await selections(id);
    await asUser(id, () => db.query("update public.matchmaking_profiles set favorite_book_3_id='OL1013W' where user_id=$1", [id]));
    const after = await selections(id);
    assert.deepEqual(after.slice(0, 2), before);
    assert.ok(Date.now() - new Date(after[2].added_at).getTime() < 5000);
    await asUser(id, () => db.query("update public.matchmaking_profiles set is_active=false where user_id=$1", [id]));
    assert.deepEqual(await selections(id), after);
    await asUser(id, () => assert.rejects(db.query("update public.matchmaking_profiles set favorite_book_3_id=null where user_id=$1", [id]), /BOOKS_LOCKED/));
    // Advance only the fixture's edit lock, without changing the selections.
    await db.exec("alter table public.matchmaking_profiles disable trigger matchmaking_profile_updated_at");
    await db.query("update public.matchmaking_profiles set books_updated_at=now()-interval '2 days' where user_id=$1", [id]);
    await db.exec("alter table public.matchmaking_profiles enable trigger matchmaking_profile_updated_at");
    await asUser(id, () => db.query("update public.matchmaking_profiles set favorite_book_id='OL1012W',favorite_book_2_id='OL1011W',favorite_book_3_id=null where user_id=$1", [id]));
    assert.deepEqual(await selections(id), before, "slot order does not reset arrival times, and removed books disappear");
    await db.query("delete from auth.users where id=$1", [id]);
    assert.deepEqual(await selections(id), []);
  });

  await t.test("clients cannot read/forge selection dates, alter snapshots, or invoke the trigger", async () => {
    for (const role of ["authenticated", "anon"]) {
      await db.exec(`set role ${role}`);
      for (const query of [
        "select * from public.matchmaking_favorite_selections",
        "update public.matchmaking_favorite_selections set added_at=now()",
        "select * from public.matchmaking_rising_snapshot",
        "update public.matchmaking_rising_snapshot set refreshed_at=null",
        "select public.sync_matchmaking_favorite_selections()",
      ]) await denied(db.query(query));
      if (role === "anon") await denied(db.query("select public.get_matchmaking_community()"));
      await db.exec("reset role");
    }
  });

  for (let book = 1001; book <= 1010; book++) for (let i = 0; i < 8; i++) await member(`OL${book}W`, 30);
  for (const [book, days] of [[1011, [1, 2, 30]], [1012, [1, 2, 3]], [1013, [1, 2]], [1014, [8, 9, 10, 11]], [1015, [-1]], [1016, [1, 2]]]) {
    for (const day of days) await member(`OL${book}W`, day);
  }
  let initial;
  await t.test("recent votes outrank lifetime totals; seven-day filtering and ties are deterministic", async () => {
    initial = await community();
    assert.equal(initial.top_books.length, 10);
    assert.ok(initial.top_books.every(book => Number(book.work_id.slice(2, -1)) <= 1010));
    assert.deepEqual(initial.rising_books.map(book => book.work_id), ["OL1012W", "OL1013W"]);
    const ranks = (await snapshot()).rankings;
    assert.deepEqual(ranks.map(book => [book.work_id, book.votes]), [["OL1012W", 3], ["OL1013W", 2], ["OL1016W", 2], ["OL1011W", 2]]);
    assert.ok(!JSON.stringify(initial).includes(legacy));
    assert.ok(!JSON.stringify(initial).includes("Private reader"));
    assert.deepEqual(Object.keys(initial.rising_books[0]).sort(), ["author", "title", "work_id"]);
  });
  await t.test("everyone sees the same ranking until 48 hours, then it refreshes", async () => {
    await member("OL1011W", 1); await member("OL1011W", 1);
    const cached = await community();
    assert.deepEqual(cached.rising_books, initial.rising_books);
    assert.equal(cached.rising_refreshed_at, initial.rising_refreshed_at);
    await db.exec("update public.matchmaking_rising_snapshot set refreshed_at=now()-interval '47 hours'");
    assert.deepEqual((await community()).rising_books, initial.rising_books);
    await db.exec("update public.matchmaking_rising_snapshot set refreshed_at=now()-interval '48 hours'");
    const refreshed = await community();
    assert.deepEqual(refreshed.rising_books.map(book => book.work_id), ["OL1011W", "OL1012W"]);
    assert.ok(new Date(refreshed.rising_refreshed_at) > new Date(initial.rising_refreshed_at));
  });
  await t.test("a cached favorite entering the live Top Ten is replaced without waiting two days", async () => {
    const before = await snapshot();
    for (let i = 0; i < 5; i++) await member("OL1011W", 1);
    const current = await community();
    assert.ok(current.top_books.some(book => book.work_id === "OL1011W"));
    assert.deepEqual(current.rising_books.map(book => book.work_id), ["OL1012W", "OL1013W"]);
    assert.deepEqual(await snapshot(), before, "the cached ranking itself did not change");
  });
  await t.test("deleted selections never leave orphaned favorites; an empty community has no fabricated picks", async () => {
    await db.exec("delete from auth.users where id in (select user_id from public.matchmaking_favorite_selections where work_id='OL1012W')");
    assert.deepEqual((await community()).rising_books.map(book => book.work_id), ["OL1013W", "OL1016W"]);
    await db.exec("delete from auth.users");
    assert.equal((await db.query("select count(*)::int as n from public.matchmaking_favorite_selections")).rows[0].n, 0);
    const empty = await community();
    assert.deepEqual(empty.rising_books, []);
    assert.deepEqual(empty.top_books, []);
    assert.equal(empty.total_members, 0);
  });
});
