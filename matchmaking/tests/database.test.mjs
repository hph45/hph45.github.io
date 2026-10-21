import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { makeProfile } from "../src/profile.js";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const D = "00000000-0000-4000-8000-000000000004";
const MATCH = "00000000-0000-4000-8000-000000000010";
const OTHER_MATCH = "00000000-0000-4000-8000-000000000011";
const BUSINESS_MATCH = "00000000-0000-4000-8000-000000000012";
const fixture = makeProfile({
  display_name: "Reader", birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States", favorite_book_id: "OL1W",
  intent: "friends", favorite_book: "A good book", favorite_author: "An author",
  location_preference: "same_city",
  friendship_interests: "Coffee and conversation",
});

test("Postgres enforces ownership, validation, and released-match privacy", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to authenticated;
  `);
  const migrationFolder = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(migrationFolder)).filter(file => file.endsWith(".sql")).sort()) {
    const preferencesMigration = file === "20261021000400_matchmaking_preferences.sql";
    const legacyID = "00000000-0000-4000-8000-000000000099";
    if (preferencesMigration) {
      await db.query("insert into auth.users(id) values ($1)", [legacyID]);
      await db.exec("insert into public.matchmaking_books (work_id,title,author) values ('OL99999W','Legacy book','An author')");
      await db.query(`insert into public.matchmaking_profiles
        (user_id,display_name,birth_date,city_id,city,country,intent,favorite_book_id,favorite_book,favorite_author,
         location_preference,gender,gender_description,interested_in,age_min,age_max,books_updated_at)
        values ($1,'Legacy member','1994-06-15',5378538,'Oakland','United States','romance','OL99999W','Legacy book','An author',
                'same_city','self_described','A private self-description',array['woman','nonbinary','self_described'],25,40,'2026-10-21T00:00:00Z')`, [legacyID]);
    }
    await db.exec(await readFile(new URL(file, migrationFolder), "utf8"));
    if (preferencesMigration) {
      await t.test("the preference migration maps legacy choices without losing private answers or resetting the book clock", async () => {
        const migrated = (await db.query("select * from public.matchmaking_profiles where user_id=$1", [legacyID])).rows[0];
        assert.equal(migrated.gender, "other");
        assert.deepEqual(migrated.interested_in, ["other", "woman"]);
        assert.equal(migrated.gender_description, "A private self-description");
        assert.equal(migrated.romance_ideal_match, "");
        assert.equal(migrated.business_linkedin_url, "");
        assert.equal(new Date(migrated.books_updated_at).toISOString(), "2026-10-21T00:00:00.000Z");
      });
      await db.query("delete from auth.users where id=$1", [legacyID]);
      await db.exec("delete from public.matchmaking_books where work_id='OL99999W'");
    }
  }
  await db.exec("insert into public.matchmaking_books (work_id,title,author) values ('OL1W','A good book','An author'),('OL2W','Another good book','Another author'),('OL3W','A third book','A third author')");
  await db.query("insert into auth.users(id) values ($1), ($2), ($3), ($4)", [A, B, C, D]);
  const insert = (id, changes = {}) => {
    const values = { user_id: id, ...fixture, ...changes };
    const columns = Object.keys(values);
    return db.query(`insert into public.matchmaking_profiles (${columns.join(",")}) values (${columns.map((_, i) => `$${i + 1}`).join(",")}) returning user_id`, Object.values(values));
  };
  async function asUser(id, fn) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    try { return await fn(); } finally { await db.exec("reset role"); }
  }
  const denied = (promise) => assert.rejects(promise, error => error.code === "42501");

  await t.test("owners can create and edit; visitors and other members cannot access private profiles", async () => {
    await asUser(A, () => insert(A, { display_name: "Alice" }));
    await insert(B, { display_name: "Bob", book_reason: "A legacy answer that stays private." });
    await asUser(A, async () => {
      assert.deepEqual((await db.query("select user_id from public.matchmaking_profiles")).rows.map(row => row.user_id), [A]);
      const saved = (await db.query("select favorite_book_id, favorite_book_2_id, favorite_book_3_id, book_reason from public.matchmaking_profiles where user_id=$1", [A])).rows[0];
      assert.deepEqual(saved, { favorite_book_id: "OL1W", favorite_book_2_id: null, favorite_book_3_id: null, book_reason: "" }, "one book can be saved without an explanation");
      assert.equal((await db.query("update public.matchmaking_profiles set city='Boston' where user_id=$1 returning user_id", [B])).rows.length, 0);
      await denied(insert(C));
      await denied(db.query("update public.matchmaking_profiles set user_id=$1 where user_id=$2", [C, A]));
      await denied(db.query("update public.matchmaking_profiles set profile_consent_at='2020-01-01' where user_id=$1", [A]));
      await denied(db.query("delete from public.matchmaking_profiles where user_id=$1", [A]));
      assert.equal((await db.query("update public.matchmaking_profiles set city='Forged city' where user_id=$1 returning city", [A])).rows[0].city, "Oakland");
      assert.equal((await db.query("update public.matchmaking_profiles set display_name='Alice Reader' where user_id=$1 returning display_name", [A])).rows[0].display_name, "Alice Reader");
    });
    await db.exec("set role anon");
    await denied(db.query("select * from public.matchmaking_profiles"));
    await denied(db.query("select * from public.get_my_matchmaking_matches()"));
    await db.exec("reset role");
  });

  await t.test("database checks reject incomplete preferences and underage profiles", async () => {
    const underage = (await db.query("select ((current_date - interval '18 years')::date + 1)::text as birthday")).rows[0].birthday;
    await asUser(C, async () => {
      await assert.rejects(insert(C, { birth_date: underage }), error => error.code === "23514");
      await assert.rejects(insert(C, { intent: "romance" }), error => error.code === "23514");
      await assert.rejects(insert(C, { intent: "romance", gender: "man", interested_in: ["woman"], age_min: 35, age_max: 25 }), error => error.code === "23514");
      for (const changes of [
        { gender: "nonbinary" }, { interested_in: ["self_described"] }, { interested_in: [null] },
        { age_min: 17 }, { age_max: 121 }, { romance_ideal_match: "a".repeat(601) },
      ]) await assert.rejects(insert(C, { intent: "romance", gender: "other", interested_in: ["other"], age_min: 25, age_max: 40, ...changes }), error => error.code === "23514");
      await assert.rejects(insert(C, { intent: "business_partners" }), error => error.code === "23514");
      await assert.rejects(insert(C, { favorite_book_2_id: "OL1W" }), error => error.code === "23514");
      await assert.rejects(insert(C, { favorite_book_id: null }), /Choose a book/);
      await denied(insert(C, { book_reason: "The removed question cannot be submitted" }));
      await denied(insert(C, { gender_description: "The retired gender question cannot be submitted" }));
      await insert(C);
    });
    await insert(D, { books_updated_at: "2000-01-01T00:00:00Z" });
  });

  await t.test("three canonical favorites have a server-enforced 24-hour editing interval", async () => {
    await asUser(A, async () => {
      await assert.rejects(db.query("update public.matchmaking_profiles set favorite_book_2_id='OL2W' where user_id=$1", [A]), /BOOKS_LOCKED/);
      await denied(db.query("update public.matchmaking_profiles set book_reason='An attempt to change the retired answer' where user_id=$1", [A]));
      await denied(db.query("update public.matchmaking_profiles set books_updated_at='2000-01-01' where user_id=$1", [A]));
      await denied(db.query("insert into public.matchmaking_books(work_id,title,author) values ('OL999W','Forged','Forged')"));
      assert.equal((await db.query("update public.matchmaking_profiles set favorite_book='Typo',favorite_author='Wrong author',email_matches=true where user_id=$1 returning favorite_book,email_matches", [A])).rows[0].favorite_book, "A good book");
    });
    await asUser(D, async () => {
      const saved = (await db.query("update public.matchmaking_profiles set favorite_book_2_id='OL2W',favorite_book_3_id='OL3W' where user_id=$1 returning *", [D])).rows[0];
      assert.equal(saved.favorite_book_2, "Another good book");
      assert.equal(saved.favorite_author_3, "A third author");
      assert.ok(new Date(saved.books_updated_at).getUTCFullYear() > 2000);
      await assert.rejects(db.query("update public.matchmaking_profiles set favorite_book_3_id=null where user_id=$1", [D]), /BOOKS_LOCKED/);
      const unchanged = (await db.query("update public.matchmaking_profiles set is_active=false where user_id=$1 returning books_updated_at", [D])).rows[0];
      assert.deepEqual(unchanged.books_updated_at, saved.books_updated_at, "other settings do not reset the book clock");
    });
  });

  await t.test("community map and top ten use anonymous totals and canonical book IDs", async () => {
    const community = (await asUser(A, () => db.query("select public.get_matchmaking_community() as community"))).rows[0].community;
    assert.equal(community.total_members, 4);
    assert.equal(community.cities.length, 1);
    assert.equal(community.cities[0].name, "Oakland");
    assert.equal(community.cities[0].member_count, 4);
    assert.deepEqual(community.top_books.map(book => [book.work_id, book.votes]), [["OL1W", 4], ["OL3W", 1], ["OL2W", 1]]);
    assert.ok(!JSON.stringify(community).includes(A));
    assert.ok(!JSON.stringify(community).includes("Alice"));
    const cities = await asUser(A, () => db.query("select * from public.search_matchmaking_cities('oakland')"));
    assert.ok(cities.rows.some(city => city.id === 5378538));
    await db.exec("set role anon");
    await denied(db.query("select public.get_matchmaking_community()"));
    await db.exec("reset role");
  });

  await t.test("only the service can create matches, and exactly two active members are required", async () => {
    await asUser(A, async () => {
      await denied(db.query("select * from public.matchmaking_matches"));
      await denied(db.query("insert into public.matchmaking_matches (week_start,intent,reason) values ('2026-10-19','friends','Shared interests')"));
    });
    await db.exec("set role service_role");
    await db.query("insert into public.matchmaking_matches (id,week_start,intent,reason) values ($1,'2026-10-19','friends','A shared love of stories')", [MATCH]);
    await assert.rejects(db.query("update public.matchmaking_matches set released_at=now() where id=$1", [MATCH]), /two active members/);
    await db.query("insert into public.matchmaking_match_members (match_id,week_start,user_id) values ($1,'2026-10-19',$2),($1,'2026-10-19',$3)", [MATCH, A, B]);
    await db.exec("reset role");
    assert.equal((await asUser(A, () => db.query("select * from public.get_my_matchmaking_matches()"))).rows.length, 0);
    await db.exec("set role service_role");
    await db.query("update public.matchmaking_profiles set is_active=false where user_id=$1", [B]);
    await assert.rejects(db.query("update public.matchmaking_matches set released_at=now() where id=$1", [MATCH]), /two active members/);
    await db.query("update public.matchmaking_profiles set is_active=true where user_id=$1", [B]);
    await db.query("update public.matchmaking_matches set released_at=now() where id=$1", [MATCH]);
    await db.exec("reset role");
  });

  await t.test("only participants see released introductions, with no birthday, email, or account ID", async () => {
    const result = (await asUser(A, () => db.query("select * from public.get_my_matchmaking_matches()"))).rows;
    assert.equal(result.length, 1);
    assert.equal(result[0].display_name, "Bob");
    assert.equal(result[0].favorite_book, fixture.favorite_book);
    assert.equal(result[0].book_reason, "", "legacy explanations are never returned to matches");
    for (const key of ["birth_date", "email", "user_id", "gender", "gender_description", "interested_in", "romance_ideal_match", "email_matches"]) assert.ok(!(key in result[0]), key);
    assert.equal(result[0].business_linkedin_url, "");
    assert.equal((await asUser(B, () => db.query("select * from public.get_my_matchmaking_matches()"))).rows[0].display_name, "Alice Reader");
    assert.equal((await asUser(C, () => db.query("select * from public.get_my_matchmaking_matches()"))).rows.length, 0);
  });

  await t.test("LinkedIn is optional, validated by Postgres, and shared only in released business introductions", async () => {
    const becomeBusiness = id => asUser(id, () => db.query(`update public.matchmaking_profiles
      set intent='business_partners', business_about='A community bookshop', business_skills='Events and books',
          business_seeking='An operations partner', is_active=true where user_id=$1`, [id]));
    await becomeBusiness(C);
    await becomeBusiness(D);
    await asUser(D, async () => {
      for (const url of ["javascript:alert(1)", "https://linkedin.com.evil.example/in/reader", "https://www.linkedin.com/feed", "http://www.linkedin.com/in/reader", "https://www.linkedin.com/in/" + "a".repeat(300)]) {
        await assert.rejects(db.query("update public.matchmaking_profiles set business_linkedin_url=$1 where user_id=$2", [url, D]), error => error.code === "23514");
      }
      await db.query("update public.matchmaking_profiles set business_linkedin_url='https://www.linkedin.com/company/zebra-books' where user_id=$1", [D]);
    });
    await db.query("insert into public.matchmaking_matches (id,week_start,intent,reason) values ($1,'2026-10-26','business_partners','A shared interest in books')", [BUSINESS_MATCH]);
    await db.query("insert into public.matchmaking_match_members (match_id,week_start,user_id) values ($1,'2026-10-26',$2),($1,'2026-10-26',$3)", [BUSINESS_MATCH, C, D]);
    assert.equal((await asUser(C, () => db.query("select * from public.get_my_matchmaking_matches()"))).rows.length, 0);
    await db.query("update public.matchmaking_matches set released_at=now() where id=$1", [BUSINESS_MATCH]);
    const introduced = (await asUser(C, () => db.query("select * from public.get_my_matchmaking_matches()"))).rows[0];
    assert.equal(introduced.business_linkedin_url, "https://www.linkedin.com/company/zebra-books");
    assert.equal((await asUser(D, () => db.query("select * from public.get_my_matchmaking_matches()"))).rows[0].business_linkedin_url, "");
    await asUser(D, async () => {
      await assert.rejects(db.query("update public.matchmaking_profiles set intent='friends' where user_id=$1", [D]), error => error.code === "23514", "a LinkedIn link cannot remain on another profile type");
      await db.query(`update public.matchmaking_profiles set intent='romance', gender='other', interested_in=array['other'],
        age_min=25,age_max=40,romance_ideal_match='Someone curious and kind',
        business_about='',business_skills='',business_seeking='',business_linkedin_url='' where user_id=$1`, [D]);
      assert.equal((await db.query("select romance_ideal_match from public.matchmaking_profiles where user_id=$1", [D])).rows[0].romance_ideal_match, "Someone curious and kind");
    });
    const afterChange = (await asUser(C, () => db.query("select * from public.get_my_matchmaking_matches()"))).rows[0];
    assert.equal(afterChange.business_linkedin_url, "");
    assert.ok(!JSON.stringify(afterChange).includes("Someone curious and kind"));
    assert.ok(!("romance_ideal_match" in afterChange));
  });

  await t.test("a person gets at most one match per week and deletion removes their profile and memberships", async () => {
    await db.query("insert into public.matchmaking_matches (id,week_start,intent,reason) values ($1,'2026-10-19','friends','Another connection')", [OTHER_MATCH]);
    await assert.rejects(db.query("insert into public.matchmaking_match_members(match_id,week_start,user_id) values ($1,'2026-10-19',$2)", [OTHER_MATCH, A]), error => error.code === "23505");
    await db.query("delete from auth.users where id=$1", [B]);
    assert.equal((await db.query("select * from public.matchmaking_profiles where user_id=$1", [B])).rows.length, 0);
    assert.equal((await db.query("select * from public.matchmaking_match_members where user_id=$1", [B])).rows.length, 0);
    assert.equal((await asUser(A, () => db.query("select * from public.get_my_matchmaking_matches()"))).rows.length, 0);
  });
});
