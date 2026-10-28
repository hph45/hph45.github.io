import test from "node:test";
import assert from "node:assert/strict";
import { CACHE_AGE, CACHE_KEY, createPublicMapLoader, parsePublicMap } from "../src/community.js";

const instant = Date.parse("2026-10-27T12:00:00Z");
const snapshot = (time = instant) => ({
  generated_at: new Date(time).toISOString(), total_members: 3,
  cities: [{ id: 1, name: "Oakland", region: "California", country: "United States", latitude: 37.8, longitude: -122.27, member_count: 3 }],
});
function memoryStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
}

test("public map sends no login/session data, deduplicates requests, and reuses its cache across visits", async () => {
  const storage = memoryStorage();
  let calls = 0;
  const fetch = async (url, options) => {
    calls++;
    assert.match(url, /\/rpc\/get_public_matchmaking_map$/);
    assert.equal(options.credentials, "omit");
    assert.equal(options.body, "{}");
    assert.deepEqual(Object.keys(options.headers).sort(), ["Content-Type", "apikey"]);
    return { ok: true, json: async () => snapshot() };
  };
  const load = createPublicMapLoader({ fetch, storage, now: () => instant });
  assert.deepEqual(await Promise.all([load(), load(), load()]), [snapshot(), snapshot(), snapshot()]);
  assert.equal(calls, 1);
  await createPublicMapLoader({ fetch, storage, now: () => instant + CACHE_AGE - 1 })();
  assert.equal(calls, 1, "a new page visit uses browser storage");
});

test("browser and server cache lifetimes do not stack into two hours", async () => {
  const storage = memoryStorage();
  storage.setItem(CACHE_KEY, JSON.stringify(snapshot()));
  let time = instant + CACHE_AGE - 1000, calls = 0;
  const load = createPublicMapLoader({ storage, now: () => time, fetch: async () => {
    calls++; return { ok: true, json: async () => snapshot(time) };
  } });
  assert.equal((await load()).generated_at, snapshot().generated_at);
  assert.equal(calls, 0);
  time += 1000;
  assert.equal((await load()).generated_at, snapshot(time).generated_at);
  assert.equal(calls, 1, "expire at one hour from generation even if fetched a moment ago");
});

test("bad or unavailable storage does not block the live map", async () => {
  for (const storage of [undefined, { getItem() { throw new Error("Blocked"); }, setItem() { throw new Error("Blocked"); } },
    { getItem: () => "broken JSON", setItem() {}, removeItem() {} }]) {
    let calls = 0;
    const load = createPublicMapLoader({ storage, now: () => instant, fetch: async () => {
      calls++; return { ok: true, json: async () => snapshot() };
    } });
    assert.deepEqual(await load(), snapshot());
    await load();
    assert.equal(calls, 1, "memory caching still works");
  }
});

test("failed requests can be retried and expired snapshots are never presented as current", async () => {
  let calls = 0;
  const load = createPublicMapLoader({ now: () => instant, fetch: async () => {
    calls++;
    if (calls === 1) return { ok: false };
    return { ok: true, json: async () => snapshot(calls === 2 ? instant - CACHE_AGE : instant) };
  } });
  await assert.rejects(load(), /unavailable/);
  await assert.rejects(load(), /expired/);
  assert.deepEqual(await load(), snapshot());
});

test("a hung request times out and a later attempt can recover", async () => {
  let calls = 0;
  const load = createPublicMapLoader({ now: () => instant, timeout: 5, fetch: async (url, { signal }) => {
    calls++;
    if (calls > 1) return { ok: true, json: async () => snapshot() };
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted"))));
  } });
  await assert.rejects(load(), /Aborted/);
  assert.deepEqual(await load(), snapshot());
});

test("only aggregate map fields survive parsing; inconsistent totals and coordinates are rejected", () => {
  const extra = snapshot(); extra.profiles = [{ email: "private@example.invalid" }]; extra.cities[0].instagram = "private";
  assert.deepEqual(parsePublicMap(extra), snapshot());
  assert.deepEqual(parsePublicMap({ generated_at: snapshot().generated_at, total_members: 0, cities: [] }).cities, []);
  for (const changes of [{ total_members: 9 }, { generated_at: "invalid" }, { cities: [snapshot().cities[0], snapshot().cities[0]] },
    { cities: [{ ...snapshot().cities[0], latitude: 100 }] }]) {
    assert.throws(() => parsePublicMap({ ...snapshot(), ...changes }));
  }
});
