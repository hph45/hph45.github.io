import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { makeProfile } from "../src/profile.js";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const MATCH = "00000000-0000-4000-8000-000000000010";

test("distance and category age preferences persist privately and constrain new releases", async t => {
  const db = new PGlite();
  t.after(() => db.close());
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
  for (const name of (await readdir(folder)).filter(f => f.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(name, folder), "utf8"));
  }
  await db.exec(`
    insert into public.matchmaking_cities values
      (2000000001,'West','west','','Example',0,0,20000),
      (2000000002,'East','east','','Example',0,1,20000),
      (2000000003,'Far','far','','Example',0,90,20000);
    insert into public.matchmaking_books(work_id,title,author) values
      ('OL1W','Fixture favorite','Fixture author'), ('OL2W','Shared next read','Fixture author');
  `);
  for (const [id, city] of [[A, 2000000001], [B, 2000000002], [C, 2000000003]]) {
    await db.query("insert into auth.users(id,email) values ($1,'reader@example.invalid')", [id]);
    const values = { user_id: id, ...makeProfile({ display_name: "Reader", birth_date: "1994-06-15", city_id: city,
      city: "Fixture", country: "Example", intents: ["friends"], friendship_interests: "Walking and books",
      favorite_book_id: "OL1W", favorite_book: "Fixture favorite", favorite_author: "Fixture author",
      location_preference: "anywhere", share_email_with_matches: true }) };
    await db.query(`insert into public.matchmaking_profiles (${Object.keys(values).join(",")}) values (${Object.keys(values).map((_, i) => `$${i + 1}`).join(",")})`, Object.values(values));
  }
  async function asUser(id, fn) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    try { return await fn(); } finally { await db.exec("reset role"); }
  }
  const radius = (id, miles) => asUser(id, () => db.query("update public.matchmaking_profiles set location_preference='radius', match_radius_miles=$1 where user_id=$2 returning *", [miles, id]));
  const anywhere = id => asUser(id, () => db.query("update public.matchmaking_profiles set location_preference='anywhere' where user_id=$1 returning *", [id]));
  const pair = async (a = A, b = B) => (await db.query("select public.matchmaking_pair_within_radius($1,$2) as allowed", [a, b])).rows[0].allowed;
  const release = () => db.query("update public.matchmaking_matches set released_at=now() where id=$1", [MATCH]);

  await t.test("owners can save a radius without changing book clocks, and legacy updates clear it", async () => {
    const before = (await db.query("select * from public.matchmaking_profiles where user_id=$1", [A])).rows[0];
    const saved = (await radius(A, 70)).rows[0];
    assert.equal(saved.match_radius_miles, 70);
    assert.deepEqual(saved.books_updated_at, before.books_updated_at);
    assert.deepEqual(saved.current_book_updated_at, before.current_book_updated_at);
    assert.equal((await anywhere(A)).rows[0].match_radius_miles, null);
    for (const value of [null, 0, -1, 301, 2.5]) await assert.rejects(radius(A, value));
    for (const value of [1, 299, 300]) assert.equal((await radius(A, value)).rows[0].match_radius_miles, value);
    await radius(A, 70);
  });
  await t.test("both members' limits apply, including across the date line and within the same city", async () => {
    assert.equal(await pair(), true, "one degree is about 69.09 miles");
    await radius(B, 69);
    assert.equal(await pair(), false); assert.equal(await pair(B, A), false);
    await anywhere(B);
    await radius(A, 69); assert.equal(await pair(), false);
    await radius(A, 70); assert.equal(await pair(), true);
    await db.exec("update public.matchmaking_cities set longitude=179.9 where id=2000000001; update public.matchmaking_cities set longitude=-179.9 where id=2000000002");
    await radius(A, 14); assert.equal(await pair(), true);
    await radius(A, 13); assert.equal(await pair(), false);
    await db.exec("update public.matchmaking_cities set longitude=0 where id in (2000000001,2000000002)");
    await radius(A, 1); assert.equal(await pair(), true);
    await db.exec("update public.matchmaking_cities set longitude=1 where id=2000000002");
    await radius(A, 70);
  });
  await t.test("the new preference stays owner/admin-only, with no public distance lookup", async () => {
    await asUser(B, async () => {
      assert.equal((await db.query("select match_radius_miles from public.matchmaking_profiles where user_id=$1", [A])).rows.length, 0);
      assert.equal((await db.query("update public.matchmaking_profiles set match_radius_miles=100 where user_id=$1 returning user_id", [A])).rows.length, 0);
      await assert.rejects(db.query("select public.matchmaking_pair_within_radius($1,$2)", [A, B]), /permission denied/);
      await assert.rejects(db.query("select public.get_matchmaking_admin_profiles()"), /ADMIN_ONLY/);
      const community = await db.query("select public.get_matchmaking_community() as data");
      assert.ok(!JSON.stringify(community.rows[0]).includes("match_radius_miles"));
    });
    await db.query("insert into public.matchmaking_admin_access(user_id) values ($1)", [A]);
    await asUser(A, async () => {
      const result = (await db.query("select public.get_matchmaking_admin_profiles() as data")).rows[0].data;
      assert.ok(result.profiles.some(p => p.location_preference === "radius" && p.match_radius_miles === 70));
    });
    assert.equal((await db.query("select match_radius_miles from public.matchmaking_nonreview_profiles where user_id=$1", [A])).rows[0].match_radius_miles, 70);
  });
  await t.test("drafts are allowed but releases and later member replacements cannot bypass a radius", async () => {
    await radius(A, 69);
    await db.query("insert into public.matchmaking_matches(id,week_start,intent,reason,recommended_book_id,recommendation_reason) values ($1,'2026-11-23','friends','Shared reading interests','OL2W','Read together')", [MATCH]);
    for (const id of [A, B]) await db.query("insert into public.matchmaking_match_members(match_id,week_start,user_id) values ($1,'2026-11-23',$2)", [MATCH, id]);
    await assert.rejects(release(), /MATCH_OUTSIDE_DISTANCE_RADIUS/);
    assert.equal((await db.query("select released_at from public.matchmaking_matches where id=$1", [MATCH])).rows[0].released_at, null);
    await radius(A, 70);
    await release();
    await assert.rejects(db.query("update public.matchmaking_match_members set user_id=$1 where match_id=$2 and user_id=$3", [C, MATCH, B]), /MATCH_OUTSIDE_DISTANCE_RADIUS/);
  });
  await t.test("a changed radius retains past introductions and anywhere removes the cap", async () => {
    await radius(A, 1);
    await db.query("update public.matchmaking_matches set reason='Still shared reading interests' where id=$1", [MATCH]);
    assert.ok((await db.query("select released_at from public.matchmaking_matches where id=$1", [MATCH])).rows[0].released_at);
    await anywhere(A);
    assert.equal(await pair(A, C), true);
    await radius(A, 299);
    assert.equal(await pair(A, C), false);
    await radius(A, 300);
    assert.equal(await pair(A, C), true, "300+ imposes no cap");
    await radius(C, 10);
    assert.equal(await pair(A, C), false, "300+ still respects the other person's radius");
  });
  await t.test("friends and business releases honor both private age ranges independently", async () => {
    for (const id of [A, B, C]) {
      await anywhere(id);
      await asUser(id, () => db.query(`update public.matchmaking_profiles set intents=array['friends', 'business_partners'],
        business_about='Book events', business_skills='Publishing', business_seeking='Local bookshops' where user_id=$1`, [id]));
    }
    const age = (await db.query(`select extract(year from age((now() at time zone 'America/Los_Angeles')::date, birth_date))::int as age
      from public.matchmaking_profiles where user_id=$1`, [A])).rows[0].age;
    const saveAges = (id, friendsMin, friendsMax, businessMin, businessMax) => asUser(id, () => db.query(`update public.matchmaking_profiles
      set friendship_age_min=$2, friendship_age_max=$3, business_age_min=$4, business_age_max=$5 where user_id=$1 returning *`,
      [id, friendsMin, friendsMax, businessMin, businessMax]));
    for (const bad of [[17, 60, 18, 120], [18, 121, 18, 120], [30, 29, 18, 120], [18, 120, 50, 49], [18, 120, null, 120]]) {
      await assert.rejects(saveAges(A, ...bad), error => ["23514", "23502"].includes(error.code));
    }
    const saved = (await saveAges(A, age, age, age + 1, 120)).rows[0];
    assert.deepEqual([saved.friendship_age_min, saved.friendship_age_max, saved.business_age_min, saved.business_age_max], [age, age, age + 1, 120]);
    await saveAges(B, 18, age - 1, age, age);
    await saveAges(C, age + 1, 120, 18, 120);
    await asUser(A, async () => {
      const directory = (await db.query("select public.get_matchmaking_admin_profiles() as data")).rows[0].data.profiles;
      assert.ok(directory.some(p => p.friendship_age_min === age && p.business_age_min === age + 1));
    });
    await asUser(B, async () => {
      assert.equal((await db.query("select friendship_age_min from public.matchmaking_profiles where user_id=$1", [A])).rows.length, 0);
      const feeds = (await db.query("select public.get_matchmaking_community() as community, public.get_my_matchmaking_introductions() as introductions")).rows[0];
      assert.ok(feeds.introductions.items.length);
      assert.doesNotMatch(JSON.stringify(feeds), /(?:friendship|business)_age_(?:min|max)/);
    });
    async function draft(intent, week) {
      const { rows: [match] } = await db.query(`insert into public.matchmaking_matches(week_start,intent,reason,recommended_book_id,recommendation_reason)
        values ($1,$2,'Shared interests','OL2W','Read together') returning id`, [week, intent]);
      for (const id of [A, B]) await db.query("insert into public.matchmaking_match_members(match_id,week_start,user_id) values ($1,$2,$3)", [match.id, week, id]);
      return match.id;
    }
    const publish = id => db.query("update public.matchmaking_matches set released_at=now() where id=$1", [id]);
    const friends = await draft("friends", "2030-01-07");
    const business = await draft("business_partners", "2030-01-14");
    await assert.rejects(publish(friends), /MATCH_OUTSIDE_CONNECTION_AGE_RANGE/);
    await assert.rejects(publish(business), /MATCH_OUTSIDE_CONNECTION_AGE_RANGE/);
    await saveAges(B, age, age, age, age);
    await publish(friends);
    await assert.rejects(db.query("update public.matchmaking_matches set intent='business_partners' where id=$1", [friends]), /MATCH_OUTSIDE_CONNECTION_AGE_RANGE/);
    await assert.rejects(db.query("update public.matchmaking_match_members set user_id=$1 where match_id=$2 and user_id=$3", [C, friends, B]), /MATCH_OUTSIDE_CONNECTION_AGE_RANGE/);
    await saveAges(A, age + 1, 120, age, age);
    await publish(business);
    assert.ok((await db.query("select released_at from public.matchmaking_matches where id=$1", [friends])).rows[0].released_at);
  });
});
