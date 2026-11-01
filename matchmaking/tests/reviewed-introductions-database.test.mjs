import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { makeProfile } from "../src/profile.js";

test("reviewed friendship options and private notices preserve release security", async t => {
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
  let reviewedOptionsMigration;
  for (const file of (await readdir(folder)).filter(file => file.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(file, folder), "utf8");
    if (file === "20261101000100_reviewed_introduction_options.sql") reviewedOptionsMigration = sql;
    else await db.exec(sql);
  }
  const [A, B, C, D, OUTSIDER] = [1, 2, 3, 4, 5].map(i => `31000000-0000-4000-8000-00000000000${i}`);
  await db.exec("insert into public.matchmaking_books(work_id,title,author) values ('OL3101W','Favorite','Author'),('OL3102W','Current','Author'),('OL3103W','Next read','Author')");
  for (const [i, id] of [A, B, C, D, OUTSIDER].entries()) {
    await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `reader${i}@example.invalid`]);
    const values = { user_id: id, ...makeProfile({
      display_name: `Reader ${i}`, birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States",
      intents: i === 2 ? ["business_partners"] : i === 0 || i === 3 ? ["romance"] : ["friends"],
      gender: "other", interested_in: ["other"], age_min: 25, age_max: 40,
      romance_ideal_match: "PRIVATE ROMANTIC ANSWER", friendship_interests: "Reading and walking",
      business_about: "A bookshop", business_skills: "Design", business_seeking: "A partner",
      favorite_book_id: "OL3101W", current_book_id: "OL3102W", location_preference: "anywhere", instagram_handle: `reader${i}.books`,
    }) };
    await db.query(`insert into public.matchmaking_profiles (${Object.keys(values).join(",")}) values (${Object.keys(values).map((_, j) => `$${j + 1}`).join(",")})`, Object.values(values));
  }
  async function asUser(id, fn) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || ""]);
    try { return await fn(); } finally { await db.exec("reset role"); }
  }
  const page = (id, cursor = null, limit = 24) => asUser(id, async () => (await db.query(
    "select public.get_my_matchmaking_introductions($1,$2,$3) as data", [cursor?.released_at || null, cursor?.id || null, limit])).rows[0].data);
  const release = (id, at = "2000-01-01T00:00:00Z") => db.query("update public.matchmaking_matches set released_at=$2 where id=$1", [id, at]);
  const editMember = (id, user, fields) => db.query(`update public.matchmaking_match_members set ${Object.keys(fields).map((k, i) => `${k}=$${i + 3}`).join(",")} where match_id=$1 and user_id=$2`, [id, user, ...Object.values(fields)]);
  async function draft({ intent = "friends", members = [A, B], recommendation = "OL3103W", reason = "Try a different story together" } = {}) {
    const id = (await db.query("insert into public.matchmaking_matches(week_start,intent,reason,recommended_book_id,recommendation_reason) values ('2026-11-02',$1,'Shared reading',$2,$3) returning id", [intent, recommendation, reason])).rows[0].id;
    for (const user of members) await db.query("insert into public.matchmaking_match_members(match_id,week_start,user_id) values ($1,'2026-11-02',$2)", [id, user]);
    return id;
  }

  const legacy = await draft({ intent: "romance", members: [A, D] });
  await release(legacy);
  await db.query("update public.matchmaking_match_members set revealed_at='2000-01-02T00:00:00Z' where match_id=$1 and user_id=$2", [legacy, A]);
  const legacyPair = (await db.query("select * from public.matchmaking_matches where id=$1", [legacy])).rows[0];
  const legacyMembers = (await db.query("select * from public.matchmaking_match_members where match_id=$1 order by user_id", [legacy])).rows;
  const originalProfiles = (await db.query("select * from public.matchmaking_profiles order by user_id")).rows;
  assert.ok(reviewedOptionsMigration);
  await db.exec(reviewedOptionsMigration);

  await t.test("migration preserves existing released rows, reveal receipts, and complete profiles", async () => {
    assert.deepEqual((await db.query("select * from public.matchmaking_matches where id=$1", [legacy])).rows[0], legacyPair);
    assert.deepEqual((await db.query("select * from public.matchmaking_match_members where match_id=$1 order by user_id", [legacy])).rows,
      legacyMembers.map(m => ({ ...m, optional_friendship: false, member_notice: "", contact_via_email: false })));
    assert.deepEqual((await db.query("select * from public.matchmaking_profiles order by user_id")).rows, originalProfiles);
    assert.equal((await page(A)).items.find(m => m.id === legacy).reason, legacyPair.reason);
  });

  const first = await draft();
  await t.test("fallback is off by default, per participant, and restricted to optional friendship", async () => {
    const defaults = (await db.query("select optional_friendship,member_notice,contact_via_email from public.matchmaking_match_members where match_id=$1", [first])).rows;
    assert.deepEqual(defaults, Array(2).fill({ optional_friendship: false, member_notice: "", contact_via_email: false }));
    await assert.rejects(release(first), /two active members/);
    await editMember(first, B, { optional_friendship: true });
    await assert.rejects(release(first), /two active members/, "the other member's flag cannot authorize A");
    await editMember(first, A, { optional_friendship: true });
    // The service role can release without receiving SELECT access to auth.users.
    await db.exec("set role service_role");
    try {
      await assert.rejects(db.query("select email from auth.users"), e => e.code === "42501");
      await release(first);
    } finally { await db.exec("reset role"); }
    const bothRomance = await draft({ members: [A, D] });
    await editMember(bothRomance, A, { optional_friendship: true });
    await assert.rejects(release(bothRomance), /two active members/);
    await editMember(bothRomance, D, { optional_friendship: true });
    await release(bothRomance);
    for (const config of [{ members: [A, C] }, { intent: "romance" }, { intent: "business_partners", members: [A, C] }]) {
      const id = await draft(config);
      for (const user of config.members || [A, B]) await editMember(id, user, { optional_friendship: true });
      await assert.rejects(release(id), /two active members/, "flags must not manufacture another category or include business-only profiles");
    }
  });

  await t.test("only the caller's notice is appended; raw flags and private answers never leak", async () => {
    await editMember(first, A, { member_notice: "A ONLY: optional friendship and next-round priority." });
    await editMember(first, B, { member_notice: "B ONLY: an introduction outside your city." });
    const a = (await page(A)).items.find(m => m.id === first), b = (await page(B)).items.find(m => m.id === first);
    assert.equal(a.reason, "Shared reading\n\nA ONLY: optional friendship and next-round priority.");
    assert.equal(b.reason, "Shared reading\n\nB ONLY: an introduction outside your city.");
    assert.ok(!JSON.stringify(a).includes("B ONLY")); assert.ok(!JSON.stringify(b).includes("A ONLY"));
    assert.equal(b.friendship_interests, "", "a romance-only counterpart's stale friendship answer stays private");
    for (const field of ["member_notice", "optional_friendship", "contact_via_email", "romance_ideal_match", "user_id", "email", "birth_date"]) assert.ok(!(field in a));
    assert.ok(!JSON.stringify(a).includes("PRIVATE ROMANTIC ANSWER"));
    const emptyNotice = (await page(A)).items.find(m => m.id !== first);
    assert.equal(emptyNotice.reason, "Shared reading", "an empty notice does not add blank separators");
  });

  await t.test("email override suppresses placeholder Instagram and obeys current sharing consent", async () => {
    await db.query("update public.matchmaking_profiles set instagram_handle='0' where user_id=$1", [B]);
    await editMember(first, B, { contact_via_email: true });
    let view = (await page(A)).items.find(m => m.id === first);
    assert.equal(view.instagram_handle, null); assert.equal(view.contact_email, "reader1@example.invalid");
    const reverse = (await page(B)).items.find(m => m.id === first);
    assert.equal(reverse.instagram_handle, "reader0.books"); assert.equal(reverse.contact_email, null);
    await asUser(B, () => db.query("update public.matchmaking_profiles set share_email_with_matches=false where user_id=$1", [B]));
    view = (await page(A)).items.find(m => m.id === first);
    assert.equal(view.contact_email, null); assert.equal(view.instagram_handle, null, "never fall back to the disallowed placeholder");
    await assert.rejects(release(first), /MATCH_CONTACT_REQUIRED/);
    await asUser(B, () => db.query("update public.matchmaking_profiles set share_email_with_matches=true where user_id=$1", [B]));
    await release(first);
  });

  await t.test("new releases require a real permitted contact route including email existence", async () => {
    const id = await draft(); await editMember(id, A, { optional_friendship: true });
    await db.query("update public.matchmaking_profiles set instagram_handle=null,share_email_with_matches=false where user_id=$1", [B]);
    await assert.rejects(release(id), /MATCH_CONTACT_REQUIRED/);
    await db.query("update public.matchmaking_profiles set share_email_with_matches=true where user_id=$1", [B]);
    await db.query("update auth.users set email='   ' where id=$1", [B]);
    await assert.rejects(release(id), /MATCH_CONTACT_REQUIRED/);
    await db.query("update auth.users set email='reader1@example.invalid' where id=$1", [B]);
    await release(id);
    assert.equal((await page(A)).items.find(m => m.id === id).contact_email, "reader1@example.invalid");
    await db.query("update public.matchmaking_profiles set instagram_handle='reader1.books' where user_id=$1", [B]);
  });

  await t.test("fallback cannot bypass two-member, activity, or recommended-book checks", async () => {
    for (const members of [[A], [A, B, C]]) {
      const id = await draft({ members }); await editMember(id, A, { optional_friendship: true });
      await assert.rejects(release(id), /two active members/);
    }
    const inactive = await draft(); await editMember(inactive, A, { optional_friendship: true });
    await db.query("update public.matchmaking_profiles set is_active=false where user_id=$1", [B]);
    await assert.rejects(release(inactive), /two active members/);
    await db.query("update public.matchmaking_profiles set is_active=true where user_id=$1", [B]);
    for (const recommendation of [null, "OL3101W", "OL3102W"]) {
      const id = await draft({ recommendation }); await editMember(id, A, { optional_friendship: true });
      await assert.rejects(release(id), recommendation === null ? /MATCH_RECOMMENDATION_REQUIRED/ : /MATCH_RECOMMENDATION_ALREADY_SELECTED/);
    }
    const noReason = await draft({ reason: " " }); await editMember(noReason, A, { optional_friendship: true });
    await assert.rejects(release(noReason), /MATCH_RECOMMENDATION_REQUIRED/);
    await assert.rejects(draft({ recommendation: "NONEXISTENT-BOOK" }), e => e.code === "23503");
    await assert.rejects(db.query("update public.matchmaking_matches set recommended_book_id='OL3101W' where id=$1", [first]), /MATCH_RECOMMENDATION_ALREADY_SELECTED/);
  });

  await t.test("authenticated members cannot write server-owned options or read raw memberships", async () => {
    await asUser(A, async () => {
      for (const sql of [
        "select * from public.matchmaking_match_members",
        "update public.matchmaking_match_members set optional_friendship=true",
        "update public.matchmaking_match_members set member_notice='Forged'",
        "update public.matchmaking_match_members set contact_via_email=true",
        "update public.matchmaking_matches set released_at=now()",
      ]) await assert.rejects(db.query(sql), e => e.code === "42501");
      await assert.rejects(db.query("insert into public.matchmaking_match_members(match_id,week_start,user_id,optional_friendship) values ($1,'2026-11-02',$2,true)", [first, OUTSIDER]), e => e.code === "42501");
    });
    assert.equal((await page(OUTSIDER)).total_count, 0);
    await assert.rejects(page(null), /SIGN_IN_REQUIRED/);
    await db.exec("set role anon");
    try { await assert.rejects(db.query("select public.get_my_matchmaking_introductions()"), e => e.code === "42501"); }
    finally { await db.exec("reset role"); }
  });

  await t.test("future/draft visibility, stable pagination, and private reveals retain their gates", async () => {
    const pending = await draft(), future = await draft();
    await editMember(future, A, { optional_friendship: true }); await release(future, "2999-01-01T00:00:00Z");
    const full = await page(A); assert.ok(!full.items.some(m => [pending, future].includes(m.id)));
    const ids = []; let cursor;
    do { const result = await page(A, cursor, 1); ids.push(...result.items.map(m => m.id)); cursor = result.next_cursor; } while (cursor);
    assert.deepEqual(ids, full.items.map(m => m.id)); assert.equal(new Set(ids).size, full.total_count);
    const reveal = (user, id) => asUser(user, async () => (await db.query("select public.reveal_matchmaking_match($1) as seen", [id])).rows[0].seen);
    for (const [user, id] of [[A, pending], [A, future], [OUTSIDER, first], [null, first]]) await assert.rejects(reveal(user, id), /INTRODUCTION_UNAVAILABLE/);
    assert.deepEqual(await reveal(A, first), await reveal(A, first));
    assert.equal((await page(B)).items.find(m => m.id === first).revealed_at, null);
    await assert.rejects(page(A, { released_at: "2000-01-01T00:00:00Z" }), /INVALID_MATCH_CURSOR/);
    await db.query("delete from auth.users where id=$1", [B]);
    assert.ok(!(await page(A)).items.some(m => m.id === first));
    await assert.rejects(reveal(A, first), /INTRODUCTION_UNAVAILABLE/);
  });
});
