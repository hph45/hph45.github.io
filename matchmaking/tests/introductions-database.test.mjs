import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { makeProfile } from "../src/profile.js";

test("introduction history, recommendations, contact preferences, and private reveal state", async t => {
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
  const folder = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(folder)).filter(file => file.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, folder), "utf8"));
  const [A, B, C] = [1, 2, 3].map(n => `29000000-0000-4000-8000-00000000000${n}`);
  await db.exec("insert into public.matchmaking_books(work_id,title,author) values ('OL1W','A favorite','Author'),('OL2W','Reading now','Author'),('OL3W','Our next read','Another author')");
  for (const [i, id] of [A, B, C].entries()) {
    await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `reader${i}@example.invalid`]);
    const values = { ...makeProfile({ display_name: `Reader ${i}`, birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States",
      intents: ["friends", "romance", "business_partners"], favorite_book_id: "OL1W", current_book_id: "OL2W",
      friendship_interests: "Walking and books", gender: "other", interested_in: ["other"], age_min: 25, age_max: 40,
      romance_ideal_match: "PRIVATE IDEAL MATCH", business_about: "Building a bookshop", business_skills: "Design", business_seeking: "A partner", location_preference: "anywhere",
    }), user_id: id };
    await db.query(`insert into public.matchmaking_profiles (${Object.keys(values).join(",")}) values (${Object.keys(values).map((_, i) => `$${i + 1}`).join(",")})`, Object.values(values));
  }
  async function asUser(id, callback) {
    await db.exec("set role authenticated"); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || ""]);
    try { return await callback(); } finally { await db.exec("reset role"); }
  }
  const page = (user, cursor = null, limit = 24) => asUser(user, async () => (await db.query(
    "select public.get_my_matchmaking_introductions($1,$2,$3) as data", [cursor?.released_at || null, cursor?.id || null, limit])).rows[0].data);
  const reveal = (user, id) => asUser(user, async () => (await db.query("select public.reveal_matchmaking_match($1) as seen", [id])).rows[0].seen);
  const release = (id, time = "2000-01-01T00:00:00Z") => db.query("update public.matchmaking_matches set released_at=$2 where id=$1", [id, time]);
  async function draft(intent = "friends", recommendation = "OL3W") {
    const id = (await db.query("insert into public.matchmaking_matches(week_start,intent,reason,recommended_book_id,recommendation_reason) values ('2026-10-26',$1,'Shared books',$2,'A different story to discover together') returning id", [intent, recommendation])).rows[0].id;
    await db.query("insert into public.matchmaking_match_members(match_id,week_start,user_id) values ($1,'2026-10-26',$2),($1,'2026-10-26',$3)", [id, A, B]);
    return id;
  }
  const first = await draft(), future = await draft(), pending = await draft();
  await release(first); await release(future, "2999-01-01T00:00:00Z");

  await t.test("only participants see currently released introductions; private fields and other categories stay out", async () => {
    assert.equal((await page(C)).items.length, 0);
    const result = await page(A); assert.equal(result.total_count, 1); assert.equal(result.items[0].id, first);
    const match = result.items[0];
    assert.equal(match.display_name, "Reader 1"); assert.equal(match.revealed_at, null);
    assert.equal(match.business_about, ""); assert.equal(match.contact_email, "reader1@example.invalid", "email contact is enabled by default without Instagram");
    assert.deepEqual(match.recommended_book, { work_id: "OL3W", title: "Our next read", author: "Another author", reason: "A different story to discover together" });
    assert.deepEqual((await page(B)).items[0].recommended_book, match.recommended_book);
    for (const field of ["birth_date", "email", "user_id", "intents", "gender", "interested_in", "romance_ideal_match", "book_reason"]) assert.ok(!(field in match));
    assert.ok(!JSON.stringify(result).includes("PRIVATE IDEAL MATCH"));
    await assert.rejects(page(null), /SIGN_IN_REQUIRED/);
    await db.exec("set role anon");
    for (const sql of ["select public.get_my_matchmaking_introductions()", `select public.reveal_matchmaking_match('${first}')`]) await assert.rejects(db.query(sql), e => e.code === "42501");
    await db.exec("reset role");
    await asUser(A, async () => {
      await assert.rejects(db.query("select * from public.matchmaking_match_members"), e => e.code === "42501");
      await assert.rejects(db.query("update public.matchmaking_match_members set revealed_at=now()"), e => e.code === "42501");
      await assert.rejects(db.query("update public.matchmaking_matches set recommended_book_id='OL1W'"), e => e.code === "42501");
    });
  });

  await t.test("reveal is persistent, idempotent, and independent for each participant", async () => {
    for (const [who, id] of [[C, first], [A, future], [A, pending], [null, first]]) await assert.rejects(reveal(who, id), /INTRODUCTION_UNAVAILABLE/);
    const seen = await reveal(A, first); assert.ok(seen);
    assert.deepEqual(await reveal(A, first), seen);
    assert.equal(new Date((await page(A)).items[0].revealed_at).toISOString(), seen.toISOString());
    assert.equal((await page(B)).items[0].revealed_at, null, "no read receipts for the other person");
  });

  await t.test("email defaults on, is hidden when Instagram exists, and respects persistent owner opt-outs", async () => {
    const before = (await db.query("select books_updated_at,current_book_updated_at from public.matchmaking_profiles where user_id=$1", [B])).rows[0];
    await asUser(B, () => db.query("update public.matchmaking_profiles set share_email_with_matches=false where user_id=$1", [B]));
    await asUser(C, () => db.query("update public.matchmaking_profiles set share_email_with_matches=true where user_id=$1", [B]));
    assert.equal((await page(A)).items[0].contact_email, null);
    await asUser(B, () => db.query("update public.matchmaking_profiles set share_email_with_matches=true where user_id=$1", [B]));
    assert.equal((await page(A)).items[0].contact_email, "reader1@example.invalid");
    assert.equal((await page(C)).items.length, 0);
    await asUser(B, () => db.query("update public.matchmaking_profiles set instagram_handle='reader.books' where user_id=$1", [B]));
    assert.equal((await page(A)).items[0].contact_email, null);
    assert.equal((await page(A)).items[0].instagram_handle, "reader.books");
    await asUser(B, () => db.query("update public.matchmaking_profiles set instagram_handle=null where user_id=$1", [B]));
    assert.equal((await page(A)).items[0].contact_email, "reader1@example.invalid");
    await asUser(B, () => db.query("update public.matchmaking_profiles set share_email_with_matches=false,instagram_handle=null where user_id=$1", [B]));
    assert.equal((await page(A)).items[0].contact_email, null);
    await asUser(B, () => db.query("update public.matchmaking_profiles set display_name='Updated reader' where user_id=$1", [B]));
    assert.equal((await page(A)).items[0].contact_email, null, "an unrelated edit cannot undo an opt-out");
    assert.deepEqual((await db.query("select books_updated_at,current_book_updated_at from public.matchmaking_profiles where user_id=$1", [B])).rows[0], before);
    const community = (await asUser(A, () => db.query("select public.get_matchmaking_community() as data"))).rows[0].data;
    assert.ok(!JSON.stringify(community).includes("reader1@example.invalid"));
  });

  await t.test("new releases require a recommendation neither participant has already selected", async () => {
    await assert.rejects(release(await draft("friends", null)), /MATCH_RECOMMENDATION_REQUIRED/);
    await assert.rejects(release(await draft("friends", "OL1W")), /MATCH_RECOMMENDATION_ALREADY_SELECTED/);
    await assert.rejects(release(await draft("friends", "OL2W")), /MATCH_RECOMMENDATION_ALREADY_SELECTED/);
    await asUser(B, () => db.query("update public.matchmaking_profiles set is_active=false where user_id=$1", [B]));
    await assert.rejects(release(pending), /two active members/);
    await asUser(B, () => db.query("update public.matchmaking_profiles set is_active=true where user_id=$1", [B]));
  });

  await t.test("dozens of matches in one drop paginate stably without losing reveals or exposing other members", async () => {
    for (let i = 0; i < 60; i++) await release(await draft(i % 2 ? "friends" : "business_partners"));
    const ids = [], chunks = []; let cursor;
    do {
      const result = await page(A, cursor); assert.equal(result.total_count, 61);
      chunks.push(result.items.length); ids.push(...result.items.map(m => m.id)); cursor = result.next_cursor;
    } while (cursor);
    assert.deepEqual(chunks, [24, 24, 13]); assert.equal(new Set(ids).size, 61);
    assert.equal((await page(A, null, 999)).items.length, 48, "server caps page size");
    assert.equal((await page(C)).total_count, 0);
    await assert.rejects(page(A, { released_at: "2000-01-01T00:00:00Z" }), /INVALID_MATCH_CURSOR/);
    const newer = await draft(); await release(newer, "2001-01-01T00:00:00Z");
    const newPage = await page(A); assert.equal(newPage.items[0].id, newer); assert.equal(newPage.total_count, 62);
    assert.ok(await reveal(A, first), "old reveal survives the new drop");
  });

  await t.test("romance suggestions are private, canonical, deduplicated, and rate limited without account lookups", async () => {
    const suggest = (id, first, second) => asUser(id, async () => (await db.query(
      "select public.suggest_matchmaking_friends($1,$2) as saved", [first, second])).rows[0].saved);
    const emptyProfile = "29000000-0000-4000-8000-000000000009";
    await db.query("insert into auth.users(id) values ($1)", [emptyProfile]);
    await assert.rejects(suggest(null, "first.friend", "second.friend"), /SIGN_IN_REQUIRED/);
    await assert.rejects(suggest(emptyProfile, "first.friend", "second.friend"), /PROFILE_REQUIRED/);
    for (const value of ["", "two words", "reader..books", "reels", "javascript:alert(1)", "https://evil.test/reader", "a".repeat(31)])
      await assert.rejects(suggest(A, value, "second.friend"), /INVALID_INSTAGRAM/);
    await assert.rejects(suggest(A, "@SAME.FRIEND", "same.friend"), /DIFFERENT_FRIENDS_REQUIRED/);
    const before = (await db.query("select * from public.matchmaking_profiles where user_id=$1", [A])).rows[0];
    assert.equal(await suggest(A, " @SECOND.Friend ", "first.friend"), true);
    const rows = (await db.query("select * from public.matchmaking_friend_suggestions where submitted_by=$1", [A])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].first_instagram, "first.friend"); assert.equal(rows[0].second_instagram, "second.friend");
    assert.equal(rows[0].intent, "romance");
    assert.equal(await suggest(A, "FIRST.FRIEND", "second.friend"), true);
    assert.equal((await db.query("select count(*)::integer as n from public.matchmaking_friend_suggestions where submitted_by=$1", [A])).rows[0].n, 1);
    assert.deepEqual((await db.query("select * from public.matchmaking_profiles where user_id=$1", [A])).rows[0], before);
    for (let i = 0; i < 4; i++) assert.equal(await suggest(A, `friend${i}`, "another.friend"), true);
    await assert.rejects(suggest(A, "sixth.friend", "another.friend"), /FRIEND_SUGGESTION_LIMIT/);
    assert.equal(await suggest(A, "first.friend", "second.friend"), true, "retrying a saved pair never consumes quota");
    assert.equal(await suggest(B, "first.friend", "second.friend"), true, "separate members can suggest the same pair");
    for (const who of [A, C]) await asUser(who, async () => {
      await assert.rejects(db.query("select * from public.matchmaking_friend_suggestions"), e => e.code === "42501");
      await assert.rejects(db.query("update public.matchmaking_friend_suggestions set intent='friends'"), e => e.code === "42501");
    });
    await db.exec("set role anon");
    await assert.rejects(db.query("select public.suggest_matchmaking_friends('one.friend','two.friend')"), e => e.code === "42501");
    await db.exec("reset role");
    await db.query("update public.matchmaking_friend_suggestions set created_at=now()-interval '25 hours' where submitted_by=$1", [A]);
    assert.equal(await suggest(A, "sixth.friend", "another.friend"), true);
  });

  await t.test("account deletion removes memberships and suggestions and prevents stale introductions from opening", async () => {
    await db.query("delete from auth.users where id=$1", [B]);
    assert.equal((await page(A)).items.length, 0);
    assert.equal((await db.query("select * from public.matchmaking_friend_suggestions where submitted_by=$1", [B])).rows.length, 0);
    await assert.rejects(reveal(A, first), /INTRODUCTION_UNAVAILABLE/);
  });
});
