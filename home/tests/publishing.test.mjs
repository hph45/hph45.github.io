import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetchPublicSnapshot, writePublicSnapshot } from "../../scripts/refresh-public-map.mjs";
import { buildPages, PUBLIC_FILES } from "../../scripts/build-pages.mjs";

const now = Date.parse("2026-11-02T12:00:00Z");
const sample = () => ({ generated_at: new Date(now).toISOString(), total_members: 1,
  cities: [{ id: 1, name: "Oakland", region: "California", country: "United States", latitude: 37.8, longitude: -122.27, member_count: 1 }] });
const temporary = async t => { const folder = await mkdtemp(join(tmpdir(), "zbc-publishing-test-")); t.after(() => rm(folder, { recursive: true, force: true })); return folder; };

test("publishing reads the public aggregate once and strips unexpected personal fields", async () => {
  let calls = 0;
  const data = sample(); data.profiles = [{ email: "private@example.invalid" }]; data.cities[0].user_ids = ["private"];
  const result = await fetchPublicSnapshot({ now: () => now, fetch: async (url, options) => {
    calls++; assert.match(url, /\/rpc\/get_public_matchmaking_map$/);
    assert.equal(options.headers.apikey.startsWith("sb_publishable_"), true);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.credentials, "omit"); assert.equal(options.body, "{}");
    return { ok: true, json: async () => data };
  } });
  assert.deepEqual(result, sample()); assert.equal(calls, 1);
});

test("failed, stale, and malformed snapshots never replace a known-good publication", async t => {
  const file = join(await temporary(t), "map.json"); await writeFile(file, JSON.stringify(sample()));
  for (const response of [{ ok: false, status: 503 },
    { ok: true, json: async () => ({ ...sample(), total_members: 9 }) },
    { ok: true, json: async () => ({ ...sample(), generated_at: new Date(now - 2 * 60 * 60 * 1000).toISOString() }) }]) {
    await assert.rejects(writePublicSnapshot(file, { now: () => now, fetch: async () => response }));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), sample());
  }
});

test("the Pages artifact contains public assets and excludes private snapshots and database tooling", async t => {
  const root = await temporary(t), source = join(root, "source"), destination = join(root, "site");
  const files = [...PUBLIC_FILES, "assets/icons.svg", "assets/review-covers/sources.csv", "matchmaking/data/books.hash.json",
    ".matchmaking-private/members.json", "supabase/migrations/private.sql", ".env", ".DS_Store", "assets/.secret", "matchmaking/src/app.js"];
  for (const file of files) { await mkdir(dirname(join(source, file)), { recursive: true }); await writeFile(join(source, file), "fixture"); }
  await buildPages(source, destination);
  for (const file of [...PUBLIC_FILES, "assets/icons.svg", "assets/review-covers/sources.csv", "matchmaking/data/books.hash.json"])
    assert.equal(await readFile(join(destination, file), "utf8"), "fixture");
  for (const file of [".matchmaking-private", "supabase", ".env", ".DS_Store", "assets/.secret", "matchmaking/src"])
    await assert.rejects(readFile(join(destination, file)), error => error.code === "ENOENT");
  assert.equal((await readdir(destination)).includes(".nojekyll"), true);
  await assert.rejects(buildPages(source, destination), error => error.code === "EEXIST");
  await symlink(join(source, ".env"), join(source, "assets/leak.json"));
  await assert.rejects(buildPages(source, join(root, "unsafe")), /Symlinks/);
});
