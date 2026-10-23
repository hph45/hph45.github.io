import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { INTENTS, makeProfile } from "../src/profile.js";

const ids = [1, 2, 3].map(n => `00000000-0000-4000-8000-00000000000${n}`);
const [A, B, C] = ids;
const types = Object.keys(INTENTS);
const answers = {
  display_name: "Reader", birth_date: "1994-06-15", city_id: 5378538,
  city: "Oakland", country: "United States", favorite_book_id: "OL1W",
  favorite_book: "A book", favorite_author: "An author", location_preference: "same_city",
  gender: "other", interested_in: ["woman", "other"], age_min: 25, age_max: 80,
  romance_ideal_match: "A private ideal match", friendship_interests: "Bookshops and coffee",
  business_about: "A neighborhood bookshop", business_skills: "Events and community",
  business_seeking: "An operations partner", business_linkedin_url: "https://www.linkedin.com/in/reader",
};

test("multiple connection types migrate safely and enforce completeness and match privacy", async t => {
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
  async function asUser(id, fn) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    try { return await fn(); } finally { await db.exec("reset role"); }
  }
  const update = (id, values) => asUser(id, () => db.query(
    `update public.matchmaking_profiles set ${Object.keys(values).map((key, i) => `${key}=$${i + 2}`).join(",")} where user_id=$1 returning *`,
    [id, ...Object.values(values)],
  ));
  const migrationFolder = new URL("../../supabase/migrations/", import.meta.url);
  let before;
  let selectionsBefore;
  for (const file of (await readdir(migrationFolder)).filter(file => file.endsWith(".sql")).sort()) {
    if (file === "20261022000000_multiple_matchmaking_intents.sql") {
      await db.exec("insert into public.matchmaking_books(work_id,title,author) values ('OL1W','A book','An author')");
      for (const [i, intent] of types.entries()) {
        await db.query("insert into auth.users(id) values ($1)", [ids[i]]);
        const legacy = { user_id: ids[i], ...makeProfile({ ...answers, intent }), intent,
          created_at: "2020-01-01T00:00:00Z", updated_at: "2026-10-20T00:00:00Z", books_updated_at: "2026-10-20T00:00:00Z" };
        delete legacy.intents;
        for (const key of ["current_book_id", "current_book", "current_author"]) delete legacy[key];
        await db.query(`insert into public.matchmaking_profiles (${Object.keys(legacy).join(",")}) values (${Object.keys(legacy).map((_, index) => `$${index + 1}`).join(",")})`, Object.values(legacy));
      }
      before = (await db.query("select * from public.matchmaking_profiles order by user_id")).rows;
      selectionsBefore = (await db.query("select * from public.matchmaking_favorite_selections order by user_id")).rows;
    }
    await db.exec(await readFile(new URL(file, migrationFolder), "utf8"));
  }

  await t.test("backfill preserves every existing answer, timestamp, and favorite selection", async () => {
    const after = (await db.query("select * from public.matchmaking_profiles order by user_id")).rows;
    for (const [i, row] of after.entries()) {
      const { intents, current_book_id, current_book, current_author, current_book_updated_at, ...unchanged } = row;
      assert.deepEqual(intents, [before[i].intent]);
      assert.deepEqual([current_book_id, current_book, current_author, current_book_updated_at], [null, "", "", null]);
      assert.deepEqual(unchanged, before[i]);
    }
    assert.deepEqual((await db.query("select * from public.matchmaking_favorite_selections order by user_id")).rows, selectionsBefore);
  });

  await t.test("all seven combinations save with every selected type's required answers", async () => {
    for (let mask = 1; mask < 8; mask++) {
      const intents = types.filter((_, index) => mask & (1 << index));
      const saved = (await update(A, makeProfile({ ...answers, intents }))).rows[0];
      assert.deepEqual(saved.intents, intents);
      assert.equal(saved.intent, intents[0]);
      assert.deepEqual(saved.books_updated_at, before[0].books_updated_at);
      const required = {
        romance: { gender: null, interested_in: [], age_min: null, age_max: null },
        friends: { friendship_interests: "" },
        business_partners: { business_about: "", business_skills: "", business_seeking: "" },
      };
      for (const intent of intents) {
        for (const [field, value] of Object.entries(required[intent])) {
          await assert.rejects(update(A, { [field]: value }), error => error.code === "23514", `${intents}: ${field}`);
        }
      }
    }
    const saved = (await update(A, { romance_ideal_match: "", business_linkedin_url: "" })).rows[0];
    assert.deepEqual(saved.intents, types, "optional answers can stay empty across multiple types");
    await update(A, makeProfile({ ...answers, intents: types }));
  });

  await t.test("invalid arrays fail, while unchanged legacy fields never collapse the selections", async () => {
    for (const intents of [[], null, ["unknown"], ["friends", "unknown"], [null], ["romance", null], ["friends", "friends"]]) {
      await assert.rejects(update(A, { intents }), error => ["23514", "23502"].includes(error.code));
    }
    const saved = (await update(A, { intent: "romance", email_matches: true })).rows[0];
    assert.deepEqual(saved.intents, types);
    const own = await asUser(A, () => db.query("select intents from public.matchmaking_profiles where user_id=$1", [B]));
    assert.equal(own.rows.length, 0, "the new array remains owner-only");
    const forged = await asUser(A, () => db.query("update public.matchmaking_profiles set intents=array['friends'] where user_id=$1 returning user_id", [B]));
    assert.equal(forged.rows.length, 0);
    await db.exec("set role anon");
    await assert.rejects(db.query("select intents from public.matchmaking_profiles"), error => error.code === "42501");
    await db.exec("reset role");
  });

  await t.test("one profile still counts as one reader and one favorite vote", async () => {
    const result = (await asUser(A, () => db.query("select public.get_matchmaking_community() as data"))).rows[0].data;
    assert.equal(result.total_members, 3);
    assert.equal(result.cities[0].member_count, 3);
    assert.equal(result.top_books[0].votes, 3);
    assert.deepEqual((await db.query("select * from public.matchmaking_favorite_selections order by user_id")).rows, selectionsBefore);
  });

  await t.test("a new signup can insert an array without the compatibility column", async () => {
    const id = "00000000-0000-4000-8000-000000000004";
    await db.query("insert into auth.users(id) values ($1)", [id]);
    const values = { user_id: id, ...makeProfile({ ...answers, intents: types }) };
    assert.ok(!("intent" in values));
    const inserted = await asUser(id, () => db.query(`insert into public.matchmaking_profiles (${Object.keys(values).join(",")}) values (${Object.keys(values).map((_, i) => `$${i + 1}`).join(",")}) returning *`, Object.values(values)));
    assert.deepEqual(inserted.rows[0].intents, types);
    assert.equal(inserted.rows[0].intent, "romance");
    assert.equal(inserted.rows[0].favorite_book_2_id, null);
    await assert.rejects(update(id, { favorite_book_2_id: "OL1W" }), /BOOKS_LOCKED/);
    await db.query("delete from auth.users where id=$1", [id]);
  });

  async function createMatch(intent, week, first, second) {
    const match = (await db.query("insert into public.matchmaking_matches (intent,week_start,reason) values ($1,$2,'A shared love of books') returning id", [intent, week])).rows[0].id;
    await db.query("insert into public.matchmaking_match_members(match_id,week_start,user_id) values ($1,$2,$3),($1,$2,$4)", [match, week, first, second]);
    return match;
  }
  const release = id => db.query("update public.matchmaking_matches set released_at=now() where id=$1", [id]);

  await t.test("introductions can use any shared type and expose only that type's answers", async () => {
    await update(B, makeProfile({ ...answers, intents: ["friends", "business_partners"] }));
    await update(C, makeProfile({ ...answers, intents: ["romance"] }));
    const business = await createMatch("business_partners", "2026-10-05", A, B);
    await release(business);
    await release(await createMatch("friends", "2026-10-12", A, B));
    await release(await createMatch("romance", "2026-10-19", A, C));
    const invalid = await createMatch("romance", "2026-10-26", A, B);
    await assert.rejects(release(invalid), /two active members/);
    const matches = (await asUser(A, () => db.query("select * from public.get_my_matchmaking_matches()"))).rows;
    assert.equal(matches.length, 3);
    for (const match of matches) {
      assert.equal(match.friendship_interests, match.intent === "friends" ? answers.friendship_interests : "");
      assert.equal(match.business_about, match.intent === "business_partners" ? answers.business_about : "");
      assert.equal(match.business_linkedin_url, match.intent === "business_partners" ? answers.business_linkedin_url : "");
      for (const privateField of ["intents", "gender", "interested_in", "romance_ideal_match", "birth_date", "email"]) assert.ok(!(privateField in match));
    }
    // Direct API edits that leave old answers behind must not expose a removed type.
    await update(B, { intents: ["friends"], business_linkedin_url: "" });
    const removed = (await asUser(A, () => db.query("select * from public.get_my_matchmaking_matches() where id=$1", [business]))).rows[0];
    for (const field of ["business_about", "business_skills", "business_seeking", "business_linkedin_url"]) assert.equal(removed[field], "");
    const another = (await db.query("insert into public.matchmaking_matches(intent,week_start,reason) values ('romance','2026-10-05','Another category') returning id")).rows[0].id;
    await assert.rejects(db.query("insert into public.matchmaking_match_members(match_id,week_start,user_id) values ($1,'2026-10-05',$2)", [another, A]), error => error.code === "23505");
  });
});
