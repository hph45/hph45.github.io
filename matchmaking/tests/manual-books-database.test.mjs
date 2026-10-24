import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { makeProfile } from "../src/profile.js";

test("typed books save atomically while catalog identity, privacy, rankings, and daily limits stay enforced", async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to authenticated;
  `);
  const folder = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(folder)).filter(file => file.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, folder), "utf8"));
  const [A, B, C, D] = [1, 2, 3, 4].map(i => `10000000-0000-4000-8000-00000000000${i}`);
  for (const id of [A, B, C, D]) await db.query("insert into auth.users(id) values ($1)", [id]);
  await db.exec(`insert into public.matchmaking_books(work_id,title,author) values
    ('OL100W','An Existing Book','E. Writer'),
    ('OL101W','An ambiguous title','One author'),('OL102W','An ambiguous title','Another author')`);
  const basics = { display_name: "Reader", birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States", intents: ["friends"],
    favorite_book: "The Handwritten Book", favorite_author: "A. Writer", location_preference: "same_city", friendship_interests: "Coffee and bookshops" };
  async function asUser(id, fn) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    try { return await fn(); } finally { await db.exec("reset role"); }
  }
  function insert(id, changes = {}) {
    const values = { user_id: id, ...makeProfile({ ...basics, ...changes }) };
    return db.query(`insert into public.matchmaking_profiles (${Object.keys(values).join(",")}) values (${Object.keys(values).map((_, i) => `$${i + 1}`).join(",")}) returning *`, Object.values(values));
  }
  const catalogSize = async () => (await db.query("select count(*)::integer as n from public.matchmaking_books")).rows[0].n;
  let savedA, savedB;

  await t.test("all four slots accept free text and known works reuse their existing ID", async () => {
    savedA = (await asUser(A, () => insert(A, { favorite_book_2: " an  existing book! ", favorite_author_2: "E Writer",
      favorite_book_3: "A title with no author", current_book: "The Handwritten Book", current_author: "A. Writer" }))).rows[0];
    assert.match(savedA.favorite_book_id, /^ZB[a-f0-9]{32}$/);
    assert.equal(savedA.favorite_book_2_id, "OL100W");
    assert.equal(savedA.favorite_book_2, "An Existing Book");
    assert.equal(savedA.favorite_author_2, "E. Writer");
    assert.equal(savedA.favorite_author_3, "Unknown author");
    assert.equal(savedA.current_book_id, savedA.favorite_book_id);
    assert.ok(savedA.current_book_updated_at);
    savedB = (await asUser(B, () => insert(B, { favorite_book: "Ｔhe handwritten book!", favorite_author: "a writer" }))).rows[0];
    assert.equal(savedB.favorite_book_id, savedA.favorite_book_id, "case, width, punctuation and spacing do not split a book");
    const totals = (await asUser(A, () => db.query("select public.get_matchmaking_community() as data"))).rows[0].data;
    assert.equal(totals.top_books.find(book => book.work_id === savedA.favorite_book_id).votes, 2, "a current read adds no extra favorite vote");
    const suggestions = (await asUser(A, () => db.query("select * from public.search_matchmaking_books('handwritten')"))).rows;
    assert.equal(suggestions[0].work_id, savedA.favorite_book_id);
    assert.deepEqual(Object.keys(suggestions[0]).sort(), ["author", "cover_id", "title", "work_id"]);
  });

  await t.test("no-author entries use an unambiguous known title but never guess between different authors", async () => {
    const known = (await asUser(C, () => insert(C, { favorite_book: "An Existing Book", favorite_author: "" }))).rows[0];
    assert.equal(known.favorite_book_id, "OL100W");
    const ambiguous = (await asUser(D, () => insert(D, { favorite_book: "An ambiguous title", favorite_author: "" }))).rows[0];
    assert.match(ambiguous.favorite_book_id, /^ZB/);
    assert.equal(ambiguous.favorite_author, "Unknown author");
  });

  await t.test("typed entries cannot bypass either edit clock, and rejected saves leave no stray books", async () => {
    const before = await catalogSize();
    await asUser(A, async () => {
      await assert.rejects(db.query("update public.matchmaking_profiles set favorite_book_id='manual',favorite_book='A new locked favorite' where user_id=$1", [A]), /BOOKS_LOCKED/);
      await assert.rejects(db.query("update public.matchmaking_profiles set current_book_id='manual',current_book='A new locked read' where user_id=$1", [A]), /CURRENT_READING_LOCKED/);
      const unchanged = (await db.query("update public.matchmaking_profiles set favorite_book_id='manual',favorite_book='the handwritten book',favorite_author='a writer',email_matches=true where user_id=$1 returning *", [A])).rows[0];
      assert.equal(unchanged.favorite_book_id, savedA.favorite_book_id);
      assert.deepEqual(unchanged.books_updated_at, savedA.books_updated_at);
      assert.deepEqual(unchanged.current_book_updated_at, savedA.current_book_updated_at);
    });
    assert.equal(await catalogSize(), before);
    const read = (await asUser(B, () => db.query("update public.matchmaking_profiles set current_book_id='manual',current_book='An unlisted current read',current_author='' where user_id=$1 returning *", [B]))).rows[0];
    assert.equal(read.current_author, "Unknown author");
    assert.deepEqual(read.books_updated_at, savedB.books_updated_at);
    assert.ok(read.current_book_updated_at);
    await asUser(B, () => assert.rejects(db.query("update public.matchmaking_profiles set current_book_id=null where user_id=$1", [B]), /CURRENT_READING_LOCKED/));
  });

  await t.test("duplicate detection happens after canonical resolution and all normal validations still apply", async () => {
    await db.exec("alter table public.matchmaking_profiles disable trigger matchmaking_profile_updated_at");
    await db.query("update public.matchmaking_profiles set books_updated_at=now()-interval '25 hours' where user_id=$1", [A]);
    await db.exec("alter table public.matchmaking_profiles enable trigger matchmaking_profile_updated_at");
    const before = await catalogSize();
    await asUser(A, async () => {
      await assert.rejects(db.query("update public.matchmaking_profiles set favorite_book_3_id='manual',favorite_book_3='An Existing Book',favorite_author_3='' where user_id=$1", [A]), /distinct_favorite_books/);
      await assert.rejects(db.query("update public.matchmaking_profiles set favorite_book_id='manual',favorite_book='   ' where user_id=$1", [A]), error => error.code === "22023");
      await assert.rejects(db.query("update public.matchmaking_profiles set favorite_book_id='manual',favorite_book=$2 where user_id=$1", [A, "x".repeat(301)]), error => error.code === "22023");
      await assert.rejects(db.query("update public.matchmaking_profiles set favorite_book_id='manual',favorite_book='Rollback book',birth_date=current_date where user_id=$1", [A]), error => error.code === "23514");
    });
    assert.equal(await catalogSize(), before);
  });

  await t.test("the new helper cannot write standalone books or expose other members", async () => {
    const before = await catalogSize();
    await asUser(A, async () => {
      await assert.rejects(db.query("select public.resolve_matchmaking_book_entry('Not allowed','Someone')"), error => error.code === "42501");
      await assert.rejects(db.query("insert into public.matchmaking_books(work_id,title,author) values ('OL999W','Not allowed','Someone')"), error => error.code === "42501");
      await assert.rejects(insert(D, { favorite_book: "Unauthorized new entry" }), error => error.code === "42501");
      assert.equal((await db.query("select user_id from public.matchmaking_profiles where user_id=$1", [B])).rows.length, 0);
      assert.equal((await db.query("update public.matchmaking_profiles set favorite_book_id='manual',favorite_book='Someone else' where user_id=$1 returning user_id", [B])).rows.length, 0);
    });
    assert.equal(await catalogSize(), before);
    await db.exec("set role anon");
    await assert.rejects(db.query("select * from public.search_matchmaking_books('book')"), error => error.code === "42501");
    await assert.rejects(db.query("select * from public.matchmaking_books"), error => error.code === "42501");
    await db.exec("reset role");
  });
});
