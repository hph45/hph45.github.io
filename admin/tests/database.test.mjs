import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { makeProfile } from "../../matchmaking/src/profile.js";

const ids = Array.from({ length: 14 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
const [owner, other] = ids;
const permissionDenied = error => error.code === "42501";

test("admin statistics enforce server-owned access and accurate, aggregate-only demographics", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to authenticated;
  `);
  const migrations = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => file.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(file, migrations), "utf8"));
  }
  const rpc = async () => (await db.query("select public.get_matchmaking_admin_stats() as data")).rows[0].data;
  const poetry = async () => (await db.query("select public.get_admin_poetry() as data")).rows[0].data;
  const profiles = async (search = "", intent = null, page = 1, size = 20, { minAge = null, maxAge = null, gender = null } = {}) => (await db.query("select public.get_matchmaking_admin_profiles($1,$2,$3,$4,$5,$6,$7) as data", [search, intent, page, size, minAge, maxAge, gender])).rows[0].data;
  async function asUser(id, action, role = "authenticated") {
    await db.exec(`set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id || ""]);
    try { return await action(); } finally { await db.exec("reset role"); }
  }
  await db.exec("insert into public.matchmaking_books(work_id,title,author) values ('OL1W','Private favorite title','Private author'), ('OL2W','Second favorite','Second author'), ('OL3W','Third favorite','Third author')");
  const ages = [18, 24, 25, 34, 35, 44, 45, 54, 55, 64, 65, 79, 80, 100];
  for (const [i, id] of ids.entries()) {
    const email = i === 3 ? null : i === 1 ? "reader_1+club@example.invalid" : i === 2 ? "Reader.2+Club@Example.invalid" : `reader.${i}+club@example.invalid`;
    await db.query("insert into auth.users(id,email) values ($1,$2)", [id, email]);
    const birth = (await db.query("select (current_date - make_interval(years => $1))::date::text as birth", [ages[i]])).rows[0].birth;
    const values = { user_id: id, ...makeProfile({
      display_name: `Private reader ${i}`, birth_date: birth, city_id: [5378538, 5128581, 2643743][i % 3],
      favorite_book_id: "OL1W", location_preference: "anywhere",
      favorite_book_2_id: i === 0 ? "OL2W" : null, favorite_book_3_id: i === 0 ? "OL3W" : null,
      intents: i === 0 ? ["romance", "friends", "business_partners"] : i === 3 ? ["friends", "business_partners"] : i % 4 === 3 ? ["friends"] : ["romance", "friends"],
      gender: ["woman", "man", "other"][i % 4], interested_in: ["woman", "man", "other"],
      age_min: 18, age_max: 80, romance_ideal_match: "Private ideal match", friendship_interests: "Private friendship answer",
      business_about: "Private business project", business_skills: "Private business skills", business_seeking: "Private partner answer",
      business_linkedin_url: "https://www.linkedin.com/in/reader", email_matches: i === 0,
    }, { isActive: i % 2 === 0 }) };
    await db.query(`insert into public.matchmaking_profiles (${Object.keys(values).join(",")}) values (${Object.keys(values).map((_, index) => `$${index + 1}`).join(",")})`, Object.values(values));
  }
  // A retained answer on a profile that no longer selects romance is unknown.
  await db.query("update public.matchmaking_profiles set gender='woman' where user_id=$1", [ids[3]]);

  await t.test("the migration grants nobody access by default", async () => {
    await assert.rejects(asUser(owner, rpc), permissionDenied);
    await assert.rejects(asUser(other, rpc), permissionDenied);
    await assert.rejects(asUser(null, rpc, "anon"), permissionDenied);
    await assert.rejects(asUser(owner, profiles), permissionDenied);
    await assert.rejects(asUser(owner, poetry), permissionDenied);
  });
  await db.query("insert into public.matchmaking_admin_access(user_id) values ($1)", [owner]);

  await t.test("only the existing owner can read private poems through the RPC", async () => {
    assert.deepEqual(await asUser(owner, poetry), []);
    await db.query(`insert into public.admin_poems(slug,title,author,body,sort_order,language,translation,translation_note)
      values ('second','Second','Author','Private second text',2,'es','Private translation','Translation note'),
        ('first','First','Author',E'Line one.\nLine two.\n\nNew stanza.',1,'en','','')`);
    const result = await asUser(owner, poetry);
    assert.deepEqual(result.map(p => p.slug), ["first", "second"]);
    assert.equal(result[0].body, "Line one.\nLine two.\n\nNew stanza.");
    assert.equal(result[1].language, "es");
    assert.equal(result[1].translation, "Private translation");
    for (const id of [null, other]) await assert.rejects(asUser(id, poetry), /ADMIN_ONLY/);
    await assert.rejects(asUser(owner, poetry, "anon"), permissionDenied);
    for (const role of ["anon", "authenticated"]) {
      for (const id of [null, other, owner]) {
        for (const sql of [
          "select * from public.admin_poems",
          "insert into public.admin_poems(slug,title,author,body,sort_order) values ('fake','Fake','Fake','Fake',0)",
          "update public.admin_poems set body='Changed'",
          "delete from public.admin_poems",
          "truncate public.admin_poems",
        ]) await assert.rejects(asUser(id, () => db.exec(sql), role), permissionDenied);
      }
    }
    const security = (await db.query(`select c.relrowsecurity, p.prosecdef, p.proconfig
      from pg_class c join pg_proc p on p.proname='get_admin_poetry'
      where c.oid='public.admin_poems'::regclass`)).rows[0];
    assert.equal(security.relrowsecurity, true);
    assert.equal(security.prosecdef, true);
    assert.deepEqual(security.proconfig, ['search_path=""']);
  });

  await t.test("only the allowlisted authenticated ID can call the function", async () => {
    await assert.rejects(asUser(other, rpc), /ADMIN_ONLY/);
    await assert.rejects(asUser(null, rpc), /ADMIN_ONLY/);
    await assert.rejects(asUser(owner, rpc, "anon"), permissionDenied);
    await asUser(other, async () => {
      await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ user_metadata: { admin: true, role: "admin", email: "owner@example.invalid" } })]);
      await assert.rejects(rpc(), /ADMIN_ONLY/);
    });
    assert.equal((await asUser(owner, rpc)).total_members, 14);
    for (const id of [other, null]) await assert.rejects(asUser(id, profiles), /ADMIN_ONLY/);
    await assert.rejects(asUser(owner, profiles, "anon"), permissionDenied);
  });

  await t.test("browser users cannot read, grant, replace, or revoke admin access", async () => {
    for (const id of [owner, other]) {
      await asUser(id, async () => {
        for (const sql of [
          "select * from public.matchmaking_admin_access",
          `insert into public.matchmaking_admin_access(user_id) values ('${other}')`,
          `update public.matchmaking_admin_access set user_id='${other}'`,
          "delete from public.matchmaking_admin_access",
          "truncate public.matchmaking_admin_access",
        ]) await assert.rejects(db.query(sql), permissionDenied);
      });
    }
    await assert.rejects(db.query("insert into public.matchmaking_admin_access(user_id) values ($1)", [other]), error => error.code === "23505");
    await assert.rejects(db.query("insert into public.matchmaking_admin_access(singleton,user_id) values (false,$1)", [other]), error => error.code === "23514");
  });

  await t.test("bins, median, cities, and countries count every completed profile exactly once", async () => {
    const stats = await asUser(owner, rpc);
    assert.equal(stats.total_members, 14);
    assert.equal(stats.active_members, 7, "paused profiles stay in all demographic totals");
    assert.equal(stats.median_age, 49.5);
    assert.deepEqual(stats.age_groups.map(row => [row.label, row.member_count]), ["18–24", "25–34", "35–44", "45–54", "55–64", "65–79", "80+"].map(label => [label, 2]));
    assert.deepEqual(stats.genders.map(row => [row.key, row.member_count]), [["woman", 4], ["man", 4], ["other", 3], ["not_provided", 3]]);
    assert.deepEqual(stats.connection_types.map(row => [row.key, row.member_count]), [["romance", 11], ["friends", 14], ["business_partners", 2]]);
    assert.equal(stats.city_count, 3); assert.equal(stats.country_count, 2);
    assert.deepEqual(stats.countries, [{ country: "United States", member_count: 10 }, { country: "United Kingdom", member_count: 4 }]);
    assert.deepEqual(stats.cities.map(row => [row.id, row.member_count]), [[5128581, 5], [5378538, 5], [2643743, 4]]);
    for (const key of ["age_groups", "genders", "cities", "countries"]) {
      assert.equal(stats[key].reduce((sum, row) => sum + row.member_count, 0), 14);
    }
    await db.query("update public.matchmaking_profiles set birth_date=(current_date - interval '25 years' + interval '1 day')::date where user_id=$1", [ids[2]]);
    const beforeBirthday = await asUser(owner, rpc);
    assert.equal(beforeBirthday.age_groups[0].member_count, 3, "tomorrow's birthday does not count a year early");
    assert.equal(beforeBirthday.age_groups[1].member_count, 1);
  });

  await t.test("no personal records or wider table access are exposed, including to the admin browser", async () => {
    const stats = await asUser(owner, rpc);
    assert.deepEqual(Object.keys(stats).sort(), ["generated_at", "total_members", "active_members", "median_age", "city_count", "country_count", "age_groups", "genders", "connection_types", "cities", "countries"].sort());
    for (const city of stats.cities) assert.deepEqual(Object.keys(city).sort(), ["id", "name", "region", "country", "latitude", "longitude", "member_count"].sort());
    const json = JSON.stringify(stats);
    assert.doesNotMatch(json, /Private|birth_date|user_id|email|favorite|ideal_match|interested_in/);
    for (const id of ids) assert.ok(!json.includes(id));
    const readable = await asUser(owner, () => db.query("select user_id from public.matchmaking_profiles"));
    assert.deepEqual(readable.rows, [{ user_id: owner }]);
    const changed = await asUser(owner, () => db.query("update public.matchmaking_profiles set display_name='forged' where user_id=$1 returning user_id", [other]));
    assert.equal(changed.rows.length, 0);
  });

  await t.test("the owner can review books and all current answers without exposing auth records or retired fields", async () => {
    const result = await asUser(owner, () => profiles("Private reader 0"));
    assert.equal(result.total_count, 1);
    const profile = result.profiles[0];
    assert.equal(profile.age, 18);
    assert.deepEqual(profile.intents, ["romance", "friends", "business_partners"]);
    assert.deepEqual(profile.favorite_books, [
      { title: "Private favorite title", author: "Private author" },
      { title: "Second favorite", author: "Second author" },
      { title: "Third favorite", author: "Third author" },
    ]);
    assert.equal(profile.romance_ideal_match, "Private ideal match");
    assert.equal(profile.friendship_interests, "Private friendship answer");
    assert.equal(profile.business_about, "Private business project");
    assert.equal(profile.business_skills, "Private business skills");
    assert.equal(profile.business_seeking, "Private partner answer");
    assert.equal(profile.business_linkedin_url, "https://www.linkedin.com/in/reader");
    assert.deepEqual(profile.interested_in, ["woman", "man", "other"]);
    assert.equal(profile.age_max, 120);
    assert.equal(profile.email_matches, true);
    assert.equal(profile.city, "Oakland");
    for (const key of ["birth_date", "user_id", "email", "book_reason", "gender_legacy", "favorite_book_id"]) assert.ok(!(key in profile), key);
    for (const id of ids) assert.ok(!JSON.stringify(result).includes(id));
    const nonRomance = (await asUser(owner, () => profiles("Private reader 3"))).profiles[0];
    assert.equal(nonRomance.gender, null);
    assert.deepEqual(nonRomance.interested_in, []);
    assert.equal(nonRomance.romance_ideal_match, "");
    const singleBook = (await asUser(owner, () => profiles("Private reader 2"))).profiles[0];
    assert.equal(singleBook.favorite_books.length, 1);
  });

  await t.test("profile search, type filtering, and pagination include paused members and enforce bounds", async () => {
    const all = await asUser(owner, profiles);
    assert.equal(all.total_count, 14); assert.equal(all.profiles.length, 14);
    assert.equal(all.profiles.filter(row => !row.is_active).length, 7);
    const first = await asUser(owner, () => profiles("", null, 1, 2));
    const second = await asUser(owner, () => profiles("", null, 2, 2));
    assert.equal(first.profiles.length, 2); assert.equal(second.profiles.length, 2);
    assert.equal(second.page, 2); assert.equal(second.total_count, 14);
    assert.ok(!first.profiles.some(a => second.profiles.some(b => a.display_name === b.display_name)));
    assert.equal((await asUser(owner, () => profiles("", "romance"))).total_count, 11);
    assert.equal((await asUser(owner, () => profiles("", "friends"))).total_count, 14);
    assert.equal((await asUser(owner, () => profiles("", "business_partners"))).total_count, 2);
    assert.equal((await asUser(owner, () => profiles("SECOND FAVORITE", "business_partners"))).total_count, 1);
    assert.equal((await asUser(owner, () => profiles("London"))).total_count, 4);
    assert.equal((await asUser(owner, () => profiles("' OR true --"))).total_count, 0);
    assert.equal((await asUser(owner, () => profiles("%"))).total_count, 0, "search is literal, not a wildcard pattern");
    assert.equal((await asUser(owner, () => profiles("", null, 999, 2))).page, 7);
    const bounded = await asUser(owner, () => profiles("", null, -1, 10000));
    assert.equal(bounded.page, 1); assert.equal(bounded.page_size, 50);
    assert.equal((await asUser(owner, () => profiles("", null, 1, 0))).page_size, 1);
    await assert.rejects(asUser(owner, () => profiles("", "unknown")), error => error.code === "22023");
    await assert.rejects(asUser(other, () => profiles("", "unknown")), /ADMIN_ONLY/, "authorization happens before search processing");
  });

  await t.test("email search uses the current Auth email, supports partial and mixed-case queries, and stays admin-only", async () => {
    const full = await asUser(owner, () => profiles("  READER.0+CLUB@EXAMPLE.INVALID  "));
    assert.equal(full.total_count, 1);
    assert.equal(full.profiles[0].display_name, "Private reader 0");
    assert.equal((await asUser(owner, () => profiles(".0+club@", "business_partners"))).total_count, 1);
    const mixed = await asUser(owner, () => profiles("reader.2+club@example.invalid"));
    assert.equal(mixed.total_count, 1); assert.equal(mixed.profiles[0].display_name, "Private reader 2");
    const literal = await asUser(owner, () => profiles("reader_1+club@"));
    assert.equal(literal.total_count, 1); assert.equal(literal.profiles[0].display_name, "Private reader 1");
    const domain = await asUser(owner, () => profiles("@example.invalid", null, 2, 5));
    assert.equal(domain.total_count, 13); assert.equal(domain.profiles.length, 5); assert.equal(domain.page, 2);
    assert.equal((await asUser(owner, () => profiles("Private reader 3"))).total_count, 1, "a null email does not hide an existing profile");
    await db.query("insert into auth.users(id,email) values ($1,'unfinished@example.invalid')", ["00000000-0000-4000-8000-000000000099"]);
    assert.equal((await asUser(owner, () => profiles("unfinished@example.invalid"))).total_count, 0, "accounts without profiles are not in the directory");
    await assert.rejects(asUser(other, () => profiles("reader.0+club@example.invalid")), /ADMIN_ONLY/);
    await assert.rejects(asUser(null, () => profiles("@example.invalid"), "anon"), permissionDenied);
    assert.ok(full.profiles.every(profile => !("email" in profile)));
    await db.query("update auth.users set email='updated.reader@example.invalid' where id=$1", [owner]);
    assert.equal((await asUser(owner, () => profiles("reader.0+club@example.invalid"))).total_count, 0);
    assert.equal((await asUser(owner, () => profiles("UPDATED.READER@example.invalid"))).total_count, 1);
    await asUser(owner, async () => {
      await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ user_metadata: { email: "fake.metadata@example.invalid" } })]);
      assert.equal((await profiles("fake.metadata@example.invalid")).total_count, 0, "editable metadata cannot spoof an account's searchable email");
    });
  });

  await t.test("age filters use inclusive current ages, support open bounds, and include readers over 80", async () => {
    const range = async filters => (await asUser(owner, () => profiles("", null, 1, 20, filters))).profiles.map(p => p.age).sort((a, b) => a - b);
    assert.deepEqual(await range({ minAge: 18, maxAge: 24 }), [18, 24, 24], "tomorrow's 25th birthday is still age 24");
    assert.deepEqual(await range({ minAge: 24, maxAge: 24 }), [24, 24]);
    assert.deepEqual(await range({ maxAge: 34 }), [18, 24, 24, 34]);
    assert.deepEqual(await range({ minAge: 80 }), [80, 100]);
    assert.deepEqual(await range({ minAge: 100, maxAge: 120 }), [100]);
    assert.deepEqual(await range({ minAge: 120, maxAge: 120 }), []);
  });

  await t.test("gender filters ignore retired answers and combine with age, search, types, and pagination", async () => {
    for (const [gender, count] of [["woman", 4], ["man", 4], ["other", 3], ["not_provided", 3]]) {
      const result = await asUser(owner, () => profiles("", null, 1, 20, { gender }));
      assert.equal(result.total_count, count);
      assert.ok(result.profiles.every(p => (p.gender || "not_provided") === gender));
    }
    const retired = await asUser(owner, () => profiles("Private reader 3", "business_partners", 1, 20, { minAge: 34, maxAge: 34, gender: "not_provided" }));
    assert.equal(retired.total_count, 1, "a stale romance gender is not treated as current");
    assert.equal((await asUser(owner, () => profiles("Private reader 3", null, 1, 20, { gender: "woman" }))).total_count, 0);
    const filter = { minAge: 24, maxAge: 65, gender: "man" };
    const first = await asUser(owner, () => profiles("@EXAMPLE.INVALID", "friends", 1, 1, filter));
    const second = await asUser(owner, () => profiles("@EXAMPLE.INVALID", "friends", 2, 1, filter));
    assert.equal(second.total_count, 3); assert.equal(second.page, 2); assert.equal(second.profiles.length, 1);
    assert.notEqual(first.profiles[0].display_name, second.profiles[0].display_name);
    assert.ok(second.profiles.every(p => p.age >= 24 && p.age <= 65 && p.gender === "man" && p.intents.includes("friends")));
    assert.equal((await asUser(owner, () => profiles("", "friends", 99, 1, filter))).page, 3);
    const exact = await asUser(owner, () => profiles("LONDON", "romance", 1, 20, { minAge: 24, maxAge: 65, gender: "other" }));
    assert.equal(exact.total_count, 1); assert.equal(exact.profiles[0].display_name, "Private reader 2");
  });

  await t.test("invalid demographic filters fail only after authorization", async () => {
    for (const filter of [{ minAge: 17 }, { maxAge: 121 }, { minAge: 40, maxAge: 39 }, { minAge: -1 }, { gender: "unknown" }]) {
      await assert.rejects(asUser(owner, () => profiles("", null, 1, 20, filter)), error => error.code === "22023");
      await assert.rejects(asUser(other, () => profiles("", null, 1, 20, filter)), /ADMIN_ONLY/);
      await assert.rejects(asUser(null, () => profiles("", null, 1, 20, filter), "anon"), permissionDenied);
    }
  });

  await t.test("one RPC signature supports previous clients and optional named filters", async () => {
    const signatures = await db.query("select oid from pg_proc where pronamespace='public'::regnamespace and proname='get_matchmaking_admin_profiles'");
    assert.equal(signatures.rows.length, 1);
    await asUser(owner, async () => {
      for (const sql of ["select public.get_matchmaking_admin_profiles() as data", "select public.get_matchmaking_admin_profiles('',null,1,20) as data"]) {
        assert.equal((await db.query(sql)).rows[0].data.total_count, 14);
      }
      const named = (await db.query("select public.get_matchmaking_admin_profiles(p_min_age => 80, p_gender => 'man') as data")).rows[0].data;
      assert.equal(named.total_count, 1); assert.equal(named.profiles[0].age, 100);
    });
  });

  await t.test("the current read is searchable and returned only through the protected directory", async () => {
    await db.exec("insert into public.matchmaking_books(work_id,title,author) values ('OL4W','A current read','Current author')");
    await asUser(owner, () => db.query("update public.matchmaking_profiles set current_book_id='OL4W' where user_id=$1", [owner]));
    for (const search of ["A CURRENT READ", "CURRENT AUTHOR"]) {
      const result = await asUser(owner, () => profiles(search));
      assert.equal(result.total_count, 1);
      assert.equal(result.profiles[0].current_book, "A current read");
      assert.equal(result.profiles[0].current_author, "Current author");
      assert.equal(result.profiles[0].favorite_books.length, 3);
      assert.ok(!("current_book_id" in result.profiles[0]));
      await assert.rejects(asUser(other, () => profiles(search)), /ADMIN_ONLY/);
    }
  });

  await t.test("revocation takes effect on the very next request", async () => {
    await db.exec("delete from public.matchmaking_admin_access");
    await assert.rejects(asUser(owner, rpc), /ADMIN_ONLY/);
    await assert.rejects(asUser(owner, profiles), /ADMIN_ONLY/);
    await assert.rejects(asUser(owner, poetry), /ADMIN_ONLY/);
    await db.query("insert into public.matchmaking_admin_access(user_id) values ($1)", [owner]);
  });

  await t.test("an empty community returns zero counts and no invented demographics", async () => {
    await db.exec("delete from public.matchmaking_profiles");
    const stats = await asUser(owner, rpc);
    assert.equal(stats.total_members, 0); assert.equal(stats.active_members, 0);
    assert.equal(stats.median_age, null); assert.equal(stats.city_count, 0); assert.equal(stats.country_count, 0);
    assert.deepEqual(stats.cities, []); assert.deepEqual(stats.countries, []);
    assert.ok([...stats.age_groups, ...stats.genders, ...stats.connection_types].every(row => row.member_count === 0));
    assert.deepEqual(await asUser(owner, profiles), { total_count: 0, page: 1, page_size: 20, profiles: [] });
  });
});
