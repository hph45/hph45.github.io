import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { makeProfile } from "../src/profile.js";

test("referral entries are awarded once, only at signup, behind the database boundary", async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to authenticated;`);
  const folder = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(folder)).filter(file => file.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, folder), "utf8"));
  const ids = Array.from({ length: 10 }, (_, i) => `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
  for (const id of ids) await db.query("insert into auth.users(id,email) values ($1,'reader@example.invalid')", [id]);
  await db.exec("insert into public.matchmaking_books(work_id,title,author) values ('OL1W','A book','An author')");
  const base = makeProfile({ display_name: "Reader", birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States", intents: ["friends"], favorite_book_id: "OL1W", favorite_book: "A book", favorite_author: "An author", location_preference: "same_city", friendship_interests: "Afternoons in bookshops" });
  const as = async (id, fn) => {
    await db.exec("set role authenticated"); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    try { return await fn(); } finally { await db.exec("reset role"); }
  };
  const signup = (id, patch = {}) => as(id, () => {
    const values = { ...base, user_id: id, ...patch };
    return db.query(`insert into public.matchmaking_profiles (${Object.keys(values).join(",")}) values (${Object.keys(values).map((_, i) => `$${i + 1}`).join(",")}) returning *`, Object.values(values));
  });
  const entries = async () => (await db.query("select * from public.matchmaking_merch_referrals order by referred_user_id")).rows;
  const alice = (await signup(ids[0], { instagram_handle: "alice", merch_raffle_prize: "hoodie" })).rows[0];
  await signup(ids[1], { referred_by_instagram: " @ALICE ", instagram_handle: "bob" });
  let rows = await entries();
  assert.equal(rows.length, 1); assert.equal(rows[0].referrer_user_id, ids[0]); assert.equal(rows[0].referred_user_id, ids[1]);
  assert.equal(rows[0].status, "credited"); assert.equal(rows[0].instagram_credit, "alice");
  await as(ids[1], () => db.query("update public.matchmaking_profiles set display_name='Bob' where user_id=$1", [ids[1]]));
  assert.deepEqual(await entries(), rows, "ordinary profile edits and repeated loads cannot award another entry");
  await as(ids[0], async () => {
    const saved = (await db.query("update public.matchmaking_profiles set merch_raffle_prize='cap' where user_id=$1 returning *", [ids[0]])).rows[0];
    assert.equal(saved.merch_raffle_prize, "cap"); assert.deepEqual(saved.books_updated_at, alice.books_updated_at);
    assert.equal((await db.query("select * from public.matchmaking_profiles where user_id=$1", [ids[1]])).rows.length, 0);
    assert.equal((await db.query("update public.matchmaking_profiles set merch_raffle_prize='hoodie' where user_id=$1 returning *", [ids[1]])).rows.length, 0);
    for (const query of ["select * from public.matchmaking_merch_referrals", "delete from public.matchmaking_merch_referrals", "select public.record_matchmaking_referral()", "update public.matchmaking_profiles set referred_by_instagram='forged'"])
      await assert.rejects(db.query(query), e => e.code === "42501");
    await assert.rejects(db.query("update public.matchmaking_profiles set merch_raffle_prize='cash' where user_id=$1", [ids[0]]), e => e.code === "23514");
  });
  await signup(ids[2], { instagram_handle: "carol", referred_by_instagram: "carol" });
  await signup(ids[3], { referred_by_instagram: "not.a.member" });
  await signup(ids[4], { instagram_handle: "alice" });
  await signup(ids[5], { referred_by_instagram: "alice" });
  await signup(ids[6]);
  for (const handle of ["bad handle", "javascript:alert(1)", "a..b", "a.", "reels", "a".repeat(31)])
    await assert.rejects(signup(ids[7], { referred_by_instagram: handle }), /INVALID_REFERRAL_INSTAGRAM/);
  rows = await entries();
  assert.deepEqual(rows.map(r => r.status), ["credited", "self_referral", "unresolved", "ambiguous"]);
  assert.ok(rows.slice(1).every(r => r.referrer_user_id === null));
  const community = (await as(ids[0], () => db.query("select public.get_matchmaking_community() as data"))).rows[0].data;
  assert.ok(!JSON.stringify(community).match(/referred_by|merch_raffle|alice|bob/));
  await db.exec("set role anon");
  await assert.rejects(db.query("select * from public.matchmaking_merch_referrals"), e => e.code === "42501");
  await db.exec("reset role");
  await db.query("delete from auth.users where id=$1", [ids[1]]);
  assert.equal((await entries()).length, 3, "account deletion removes referral credits");
});
