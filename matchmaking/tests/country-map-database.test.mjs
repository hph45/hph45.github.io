import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { makeProfile } from "../src/profile.js";

test("country summaries count unique readers, rank all favorites, and stay behind existing access checks", async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to authenticated;`);
  const folder = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(folder)).filter(file => file.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, folder), "utf8"));
  const ids = Array.from({ length: 7 }, (_, i) => `43000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
  await db.exec("insert into public.matchmaking_books(work_id,title,author) values('OL1W','Alpha','Author A'),('OL2W','Zebra','Author Z'),('OL3W','Middle','Author M'),('OL4W','Current read','Author C')");
  const cities = [5378538, 5128581, 5378538, 2643743, 2643743, 1668341, 1816670];
  const picks = [[2,1], [3,2,1], [2], [1,3], [3,1], [1], [2]];
  for (const [i, id] of ids.entries()) {
    await db.query("insert into auth.users values($1,$2)", [id, `reader${i}@example.invalid`]);
    const p = { user_id: id, ...makeProfile({ display_name: `Private person ${i}`, birth_date: "1994-06-15", city_id: cities[i],
      intents: ["friends"], favorite_book_id: `OL${picks[i][0]}W`, favorite_book_2_id: picks[i][1] ? `OL${picks[i][1]}W` : null,
      favorite_book_3_id: picks[i][2] ? `OL${picks[i][2]}W` : null, current_book_id: "OL4W", location_preference: "anywhere", friendship_interests: "Private answer" }, { isActive: i !== 2 }) };
    await db.query(`insert into public.matchmaking_profiles(${Object.keys(p).join(",")}) values(${Object.keys(p).map((_, n) => `$${n + 1}`).join(",")})`, Object.values(p));
  }
  async function asUser(id, run, role = "authenticated") {
    await db.exec(`set role ${role}`); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || ""]);
    try { return await run(); } finally { await db.exec("reset role"); }
  }
  const call = async name => (await db.query(`select public.${name}() as data`)).rows[0].data;
  const community = () => asUser(ids[0], () => call("get_matchmaking_community"));
  const countries = (await community()).countries;
  assert.deepEqual(countries.map(({ country, member_count, top_book }) => [country, member_count, top_book.work_id, top_book.votes]), [
    ["United States", 3, "OL2W", 3], ["United Kingdom", 2, "OL1W", 2], ["China", 1, "OL2W", 1], ["Taiwan", 1, "OL1W", 1],
  ]);
  assert.equal(countries.reduce((sum, row) => sum + row.member_count, 0), 7);
  assert.ok(countries.every(row => row.top_book.work_id !== "OL4W"), "current reads do not vote");
  const serialized = JSON.stringify(countries);
  assert.doesNotMatch(serialized, /Private|user_id|email|birth_date|instagram|friendship/);
  for (const id of ids) assert.ok(!serialized.includes(id));
  for (const [id, role] of [[ids[0], "authenticated"], [null, "anon"]]) {
    await assert.rejects(asUser(id, () => call("matchmaking_country_stats"), role), error => error.code === "42501");
  }
  await assert.rejects(asUser(null, () => call("get_matchmaking_community"), "anon"), error => error.code === "42501");
  await assert.rejects(asUser(ids[1], () => call("get_matchmaking_admin_stats")), /ADMIN_ONLY/);
  await db.query("insert into public.matchmaking_admin_access(user_id) values($1)", [ids[0]]);
  assert.deepEqual((await asUser(ids[0], () => call("get_matchmaking_admin_stats"))).countries, countries);
  const publicMap = await asUser(null, () => call("get_public_matchmaking_map"), "anon");
  assert.equal(publicMap.countries, undefined);
  assert.doesNotMatch(JSON.stringify(publicMap), /top_book|work_id|Author [AZMC]/);
  await db.query("delete from auth.users where id=$1", [ids[2]]);
  const afterDeletion = (await community()).countries.find(row => row.country === "United States");
  assert.equal(afterDeletion.member_count, 2);
  assert.equal(afterDeletion.top_book.work_id, "OL1W", "tied favorites use title then work ID consistently");
  await db.exec("delete from public.matchmaking_profiles");
  assert.deepEqual((await community()).countries, []);
});
