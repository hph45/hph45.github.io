import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { makeProfile } from "../src/profile.js";

test("optional Instagram preserves profiles, eligibility checks, and released-match privacy", async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to authenticated;
  `);
  const [A, B, C, D] = [1, 2, 3, 4].map(i => `20000000-0000-4000-8000-00000000000${i}`);
  const basics = makeProfile({ display_name: "Reader", birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States",
    intents: ["friends"], favorite_book_id: "OL1W", favorite_book: "A book", favorite_author: "An author", current_book_id: "OL2W",
    location_preference: "same_city", friendship_interests: "Coffee and bookshops" });
  async function asUser(id, fn) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    try { return await fn(); } finally { await db.exec("reset role"); }
  }
  const insert = (id, values) => db.query(`insert into public.matchmaking_profiles (${Object.keys(values).join(",")},user_id)
    values (${Object.keys(values).map((_, i) => `$${i + 1}`).join(",")},$${Object.keys(values).length + 1}) returning *`, [...Object.values(values), id]);
  const updateHandle = (id, handle) => asUser(id, () => db.query("update public.matchmaking_profiles set instagram_handle=$2 where user_id=$1 returning *", [id, handle]));
  const profiles = async () => (await db.query("select * from public.matchmaking_profiles order by user_id")).rows;
  const selections = async () => (await db.query("select * from public.matchmaking_favorite_selections order by user_id,work_id")).rows;
  const community = async () => (await asUser(A, () => db.query("select public.get_matchmaking_community() as data"))).rows[0].data;
  let before, beforeSelections, beforeCommunity;
  const folder = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(folder)).filter(file => file.endsWith(".sql")).sort()) {
    if (file === "20261024000200_matchmaking_instagram.sql") {
      await db.exec("insert into public.matchmaking_books(work_id,title,author) values ('OL1W','A book','An author'),('OL2W','A current read','Another author')");
      for (const id of [A, B, C, D]) await db.query("insert into auth.users(id,email) values ($1,'reader@example.invalid')", [id]);
      const legacy = { ...basics }; delete legacy.instagram_handle;
      for (const id of [A, B, C]) await asUser(id, () => insert(id, legacy));
      before = await profiles(); beforeSelections = await selections(); beforeCommunity = await community();
    }
    await db.exec(await readFile(new URL(file, folder), "utf8"));
  }

  await db.exec("insert into public.matchmaking_books(work_id,title,author) values ('OL900W','A shared next read','A recommendation author')");
  await t.test("migration leaves all answers, timestamps, favorites, current reads, and totals intact", async () => {
    assert.deepEqual(await profiles(), before.map(row => ({ ...row, instagram_handle: null, share_email_with_matches: true })));
    assert.deepEqual(await selections(), beforeSelections);
    assert.deepEqual(await community(), beforeCommunity);
    // New and older clients can save profiles without Instagram.
    const saved = (await asUser(D, () => insert(D, basics))).rows[0];
    assert.equal(saved.instagram_handle, null);
    const changed = (await asUser(A, () => db.query("update public.matchmaking_profiles set display_name='Updated reader',email_matches=true where user_id=$1 returning *", [A]))).rows[0];
    assert.equal(changed.instagram_handle, null);
    assert.deepEqual(changed.books_updated_at, before[0].books_updated_at);
    assert.deepEqual(changed.current_book_updated_at, before[0].current_book_updated_at);
  });

  const match = (await db.query("insert into public.matchmaking_matches(intent,week_start,reason) values ('friends','2026-10-19','Books in common') returning id")).rows[0].id;
  await db.query("insert into public.matchmaking_match_members(match_id,week_start,user_id) values ($1,'2026-10-19',$2),($1,'2026-10-19',$3)", [match, A, B]);
  const release = () => db.query("update public.matchmaking_matches set released_at=now(),recommended_book_id='OL900W',recommendation_reason='A new book to read together' where id=$1", [match]);
  const matches = id => asUser(id, () => db.query("select * from public.get_my_matchmaking_matches()"));

  await t.test("members without Instagram can be matched while inactive profiles and drafts stay protected", async () => {
    assert.equal((await matches(A)).rows.length, 0, "drafts stay private without Instagram");
    await asUser(B, () => db.query("update public.matchmaking_profiles set is_active=false where user_id=$1", [B]));
    await assert.rejects(release(), /two active members/);
    await asUser(B, () => db.query("update public.matchmaking_profiles set is_active=true where user_id=$1", [B]));
    await release();
    assert.equal((await matches(A)).rows[0].instagram_handle, null);
    assert.equal((await matches(B)).rows[0].instagram_handle, null);
    assert.equal((await matches(C)).rows.length, 0, "outsiders cannot see email-only introductions either");
    const saved = (await updateHandle(A, " @Reader.Books ")).rows[0];
    assert.equal(saved.instagram_handle, "reader.books");
    assert.deepEqual(saved.books_updated_at, before[0].books_updated_at);
    assert.deepEqual(saved.current_book_updated_at, before[0].current_book_updated_at);
    assert.deepEqual(await selections(), [...beforeSelections, ...(await selections()).filter(row => row.user_id === D)]);
    await release();
    assert.equal((await matches(A)).rows[0].instagram_handle, null, "one participant can choose email only");
    await updateHandle(B, "other.reader");
    await db.query("update public.matchmaking_matches set released_at=null where id=$1", [match]);
    assert.equal((await matches(A)).rows.length, 0, "draft matches remain private even with both handles");
    await release();
    assert.equal((await matches(A)).rows[0].instagram_handle, "other.reader");
    assert.equal((await matches(B)).rows[0].instagram_handle, "reader.books");
    assert.equal((await matches(C)).rows.length, 0, "outsiders cannot see introductions or contact handles");
    await db.query("update public.matchmaking_matches set released_at=now()+interval '1 day' where id=$1", [match]);
    assert.equal((await matches(A)).rows.length, 0, "future introductions remain private");
    await release();
  });

  await t.test("the owner may clear or change a handle, while invalid handles never reach profiles", async () => {
    for (const value of [null, "", "   "]) {
      await updateHandle(A, "reader.books");
      const cleared = (await updateHandle(A, value)).rows[0];
      assert.equal(cleared.instagram_handle, null);
      assert.deepEqual(cleared.books_updated_at, before[0].books_updated_at);
      assert.deepEqual(cleared.current_book_updated_at, before[0].current_book_updated_at);
      assert.equal((await matches(B)).rows[0].instagram_handle, null);
    }
    for (const value of ["two words", ".reader", "reader.", "reader..books", "a".repeat(31), "https://evil.test/reader", "javascript:alert(1)", "reels"])
      await assert.rejects(updateHandle(A, value), /INVALID_INSTAGRAM/);
    const changed = (await updateHandle(A, "NEW.Reader")).rows[0];
    assert.equal(changed.instagram_handle, "new.reader");
    assert.deepEqual(changed.books_updated_at, before[0].books_updated_at);
    assert.deepEqual(changed.current_book_updated_at, before[0].current_book_updated_at);
    assert.equal((await matches(B)).rows[0].instagram_handle, "new.reader");
  });

  await t.test("contact data stays owner-only outside released matches and the allowlisted admin directory", async () => {
    await asUser(C, async () => {
      assert.equal((await db.query("select instagram_handle from public.matchmaking_profiles where user_id=$1", [A])).rows.length, 0);
      assert.equal((await db.query("update public.matchmaking_profiles set instagram_handle='forged' where user_id=$1 returning user_id", [A])).rows.length, 0);
      await assert.rejects(db.query("select public.normalize_matchmaking_instagram()"), error => error.code === "42501");
      await assert.rejects(db.query("select public.get_matchmaking_admin_profiles()"), /ADMIN_ONLY/);
      await assert.rejects(db.query("update public.matchmaking_matches set released_at=now()"), error => error.code === "42501");
    });
    const totals = JSON.stringify(await community());
    for (const privateText of ["instagram", "new.reader", "other.reader"]) assert.ok(!totals.includes(privateText));
    await db.query("insert into public.matchmaking_admin_access(user_id) values ($1)", [A]);
    const directory = (await asUser(A, () => db.query("select public.get_matchmaking_admin_profiles('OTHER.READER') as data"))).rows[0].data;
    assert.equal(directory.total_count, 1);
    assert.equal(directory.profiles[0].instagram_handle, "other.reader");
    await db.exec("set role anon");
    for (const sql of ["select instagram_handle from public.matchmaking_profiles", "select * from public.get_my_matchmaking_matches()", "select public.get_matchmaking_admin_profiles()"])
      await assert.rejects(db.query(sql), error => error.code === "42501");
    await db.exec("reset role");
  });
});
