import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Window } from "happy-dom";
import { PUBLIC_FILES } from "../../scripts/build-pages.mjs";
import { STATS_PAGES, parseCommunityStats, renderReaderMap, renderStatsHtml, refreshCommunityStats } from "../../scripts/refresh-community-stats.mjs";

const root = new URL("../../", import.meta.url);
const file = path => readFile(new URL(path, root), "utf8");
const sample = () => ({
  methodology_version: 2, measured_at: "2026-11-23T04:00:00Z", active_accounts: 11,
  reader_country_count: 2, matches_made: 23,
  reader_countries: [{ country: "Canada", latitude: 43.65, longitude: -79.38 }, { country: "Malta", latitude: 35.9, longitude: 14.5 }],
});
const now = Date.parse("2026-11-23T05:00:00Z");

test("the community snapshot counts people by account, countries by city catalog, and historical introductions by release", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create schema auth;
    create table auth.users(id integer primary key, deleted_at timestamptz, is_anonymous boolean, banned_until timestamptz);
    create table auth.identities(user_id integer, provider text);
    create table public.matchmaking_profiles(user_id integer primary key, is_active boolean, city_id integer);
    create table public.matchmaking_review_accounts(user_id integer primary key);
    create table public.matchmaking_cities(id integer primary key, country text, latitude float, longitude float, population integer);
    create table public.matchmaking_matches(id integer primary key, released_at timestamptz);
    create table public.matchmaking_match_members(match_id integer, user_id integer);
    insert into public.matchmaking_cities values (1,'Canada',49,-123,50), (2,'Canada',43,-79,100), (3,'Malta',35,14,20), (4,'France',48,2,80);
    insert into auth.users(id, is_anonymous) select n, false from generate_series(1,11) n;
    insert into public.matchmaking_profiles select n, n <> 2, case when n = 2 then 3 when n between 4 and 7 or n = 11 then 4 else 1 end
      from generate_series(1,11) n where n <> 3;
    update auth.users set deleted_at = now() where id = 4;
    update auth.users set is_anonymous = true where id = 5;
    insert into public.matchmaking_review_accounts values (6),(11);
    update auth.users set banned_until = now() + interval '1 day' where id = 7;
    update auth.users set banned_until = now() - interval '1 day' where id = 8;
    insert into auth.identities values (9,'apple'),(9,'google');
    update auth.users set is_anonymous = null where id = 10;
    insert into public.matchmaking_matches values (1,now()),(2,now()),(3,now()),(4,null),(5,now()+interval '1 day'),(6,now());
    insert into public.matchmaking_match_members values (1,1),(1,9),(2,1),(2,2),(3,9),(4,1),(4,9),(5,1),(5,9),(6,6),(6,11);
  `);
  const result = (await db.exec(await file("scripts/community-stats.sql"))).flatMap(item => item.rows)[0];
  assert.equal(Number(result.active_accounts), 4);
  assert.equal(Number(result.reader_country_count), 2, "paused readers count toward geographic reach");
  assert.equal(Number(result.matches_made), 3, "includes a release after one participant left, excludes draft, future and test pairs");
  assert.deepEqual(result.reader_countries[0], { country: "Canada", latitude: 43, longitude: -79 }, "map fallback is the most populous catalog city, even though no reader chose it");
});

test("the public snapshot retains only typed aggregates and catalog locations", () => {
  const stats = sample();
  const input = { ...stats, private_email: "private@example.invalid", reader_countries: stats.reader_countries.map(c => ({ ...c, member_id: "private" })) };
  assert.deepEqual(parseCommunityStats({ rows: [input] }), stats);
  for (const invalid of [null, { rows: [stats, stats] }, { ...stats, active_accounts: -1 }, { ...stats, matches_made: 1.5 },
    { ...stats, reader_country_count: 3 }, { ...stats, reader_countries: [stats.reader_countries[0],stats.reader_countries[0]] },
    { ...stats, measured_at: "2026-02-30T00:00:00Z" }, { ...stats, methodology_version: 1 }]) {
    assert.throws(() => parseCommunityStats(invalid));
  }
});

test("the three printed figures, map, and date match the snapshot without JavaScript", async t => {
  const stats = parseCommunityStats(JSON.parse(await file("assets/community-stats.json")));
  const window = new Window();
  t.after(() => window.close());
  const html = await file("community-stats/index.html");
  const doc = new window.DOMParser().parseFromString(html, "text/html");
  const values = Object.fromEntries([...doc.querySelectorAll(".totals > div")].map(row => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]));
  assert.deepEqual(values, {
    "Active accounts": stats.active_accounts.toLocaleString("en-US"),
    "Countries & territories": stats.reader_country_count.toLocaleString("en-US"),
    "Matches made": stats.matches_made.toLocaleString("en-US"),
  });
  assert.equal(doc.querySelector("time").getAttribute("datetime"), stats.measured_at);
  assert.match(doc.querySelector("time").textContent, /^[A-Za-z]+ \d+, \d{4}$/);
  assert.equal(doc.querySelector('details, a[download]'), null);
  assert.equal(await file("assets/community-readers-map.svg"), renderReaderMap(stats.reader_countries));
  assert.match(renderReaderMap(sample().reader_countries), /<circle /, "small regions missing from the outline get a catalog marker");
  for (const page of STATS_PAGES) {
    const original = await file(page);
    assert.equal(renderStatsHtml(original, stats), original, page);
  }
});

test("the only HTML link to Our community belongs to the signed-out matchmaking welcome view", async t => {
  const window = new Window();
  t.after(() => window.close());
  const parser = new window.DOMParser();
  const links = [];
  for (const path of PUBLIC_FILES.filter(path => path.endsWith(".html"))) {
    const doc = parser.parseFromString(await file(path), "text/html");
    for (const a of doc.querySelectorAll("a[href]")) {
      if (a.getAttribute("href").startsWith("#")) continue;
      const url = new URL(a.getAttribute("href"), `https://zebrabookclub.com/${path}`);
      if (url.origin === "https://zebrabookclub.com" && /^\/community-stats(?:\/(?:index\.html)?)?$/.test(url.pathname)) {
        links.push([path, a.closest("section")?.id, a.textContent.trim()]);
      }
    }
  }
  assert.deepEqual(links, [["matchmaking/index.html", "welcome-view", "Our community"]]);
});

test("refresh upgrades a prior snapshot, keeps the homepage intact, and rejects malformed or stale inputs", async t => {
  const folder = await mkdtemp(join(tmpdir(), "zbc-stats-test-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  for (const page of [...STATS_PAGES, "sitemap.xml", "index.html", "assets/community-stats.json"]) {
    await mkdir(dirname(join(folder, page)), { recursive: true });
    await writeFile(join(folder, page), await file(page));
  }
  const snapshot = join(folder, "assets/community-stats.json");
  await writeFile(snapshot, JSON.stringify({ methodology_version: 1, active_accounts: 10, measured_at: "2026-11-22T07:00:00Z" }));
  await refreshCommunityStats(folder, sample(), { now });
  assert.deepEqual(JSON.parse(await readFile(snapshot, "utf8")), sample());
  assert.equal(await readFile(join(folder, "index.html"), "utf8"), await file("index.html"));
  const statsPage = join(folder, "community-stats/index.html");
  const before = await readFile(statsPage, "utf8");
  assert.match(before, />November 22, 2026<\/time>/, "date shown in club time even after UTC midnight");
  for (const date of ["2026-11-22T23:00:00Z", "2026-11-25T07:30:00Z", "2026-11-19T07:30:00Z"]) {
    await assert.rejects(refreshCommunityStats(folder, { ...sample(), measured_at: date }, { now }));
  }
  await writeFile(join(folder, "press/index.html"), "missing required markers");
  await assert.rejects(refreshCommunityStats(folder, { ...sample(), active_accounts: 4000 }, { now }), /markers/);
  assert.equal(await readFile(statsPage, "utf8"), before);
});
