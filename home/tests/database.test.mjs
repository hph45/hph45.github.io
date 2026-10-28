import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { makeProfile } from "../../matchmaking/src/profile.js";

test("public map exposes only anonymous city totals and shares an hourly cache without opening private tables", async t => {
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
  for (const file of (await readdir(folder)).filter(file => file.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(file, folder), "utf8"));
  }
  await db.exec("insert into public.matchmaking_books(work_id,title,author) values ('OL1W','A book','An author')");
  const [A, B, C] = [1, 2, 3].map(i => `70000000-0000-4000-8000-00000000000${i}`);
  const profile = makeProfile({ display_name: "Private Name", instagram_handle: "private.handle", birth_date: "1994-06-15",
    city_id: 5378538, intents: ["friends"], favorite_book_id: "OL1W", location_preference: "same_city", friendship_interests: "Private interests" });
  const add = async (id, isActive = true) => {
    await db.query("insert into auth.users(id,email) values ($1,'private@example.invalid')", [id]);
    const values = { ...profile, user_id: id, is_active: isActive };
    await db.query(`insert into public.matchmaking_profiles (${Object.keys(values).join(",")}) values (${Object.keys(values).map((_, i) => `$${i + 1}`).join(",")})`, Object.values(values));
  };
  const asRole = async (role, fn) => {
    await db.exec(`set role ${role}`);
    try { return await fn(); } finally { await db.exec("reset role"); }
  };
  const map = (role = "anon") => asRole(role, async () => (await db.query("select public.get_public_matchmaking_map() as data")).rows[0].data);
  const expire = () => db.exec("update public.matchmaking_public_map_cache set refreshed_at=now()-interval '61 minutes'");

  assert.deepEqual((await map()).cities, [], "empty community is a valid public response");
  await add(A); await add(B, false); await expire();
  const before = (await db.query("select * from public.matchmaking_profiles order by user_id")).rows;
  const first = await map();
  assert.equal(first.total_members, 2, "paused profiles are included, matching the member dashboard");
  assert.equal(first.cities.length, 1);
  assert.equal(first.cities[0].member_count, 2);
  assert.equal(first.cities[0].name, "Oakland");
  assert.deepEqual(Object.keys(first).sort(), ["cities", "generated_at", "total_members"]);
  assert.deepEqual(Object.keys(first.cities[0]).sort(), ["country", "id", "latitude", "longitude", "member_count", "name", "region"]);
  for (const privateValue of [A, B, "Private Name", "private.handle", "private@example.invalid", "Private interests", "A book"]) {
    assert.ok(!JSON.stringify(first).includes(privateValue));
  }
  assert.deepEqual((await db.query("select * from public.matchmaking_profiles order by user_id")).rows, before);

  await add(C);
  assert.deepEqual(await map(), first, "anonymous visits reuse the server snapshot");
  assert.deepEqual(await map("authenticated"), first, "signed-in requests use the same aggregate cache");
  await expire();
  assert.equal((await map()).total_members, 3, "new profiles appear at expiry");
  await db.query("delete from auth.users where id=$1", [C]);
  await expire();
  assert.equal((await map()).total_members, 2, "deletions leave the next snapshot");

  for (const role of ["anon", "authenticated"]) {
    await asRole(role, async () => {
      for (const sql of ["select * from public.matchmaking_public_map_cache", "update public.matchmaking_public_map_cache set refreshed_at=now()",
        "select * from public.matchmaking_match_members", "select * from public.matchmaking_admin_access"]) {
        await assert.rejects(db.query(sql), error => error.code === "42501");
      }
      await assert.rejects(db.query("select public.get_matchmaking_admin_profiles()"), error => error.code === "42501");
    });
  }
  await asRole("anon", async () => {
    for (const sql of ["select * from public.matchmaking_profiles", "select public.get_matchmaking_community()", "select * from public.get_my_matchmaking_matches()"])
      await assert.rejects(db.query(sql), error => error.code === "42501");
  });
});
