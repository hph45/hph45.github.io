import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleProviderCheck, PROVIDER_CACHE_AGE } from "../src/google-provider.js";
import { createCommunityCache, parseCommunity, communityChanged, COMMUNITY_CACHE_AGE, COMMUNITY_CACHE_KEY } from "../src/community-cache.js";

const instant = Date.parse("2026-11-02T12:00:00Z");
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const aggregate = () => ({ total_members: 1, cities: [{ id: 1, name: "Oakland", region: "California", country: "United States", latitude: 37.8, longitude: -122.27, member_count: 1 }],
  countries: [{ country: "United States", member_count: 1, top_book: { work_id: "OL1W", title: "A book", author: "An author", votes: 1 } }],
  top_books: [{ work_id: "OL1W", title: "A book", author: "An author", votes: 1 }], rising_books: [] });

test("enabled Google checks survive page reload, expire, and are refreshed after an OAuth failure", async () => {
  const saved = storage(); let now = instant, calls = 0, enabled = true;
  const options = { storage: saved, now: () => now, url: "https://example.invalid", key: "public-key", fetch: async () => {
    calls++; return { ok: true, json: async () => ({ external: { google: enabled } }) };
  } };
  const check = createGoogleProviderCheck(options);
  assert.equal(await check(), true);
  assert.equal(await createGoogleProviderCheck(options)(), true);
  assert.equal(calls, 1);
  enabled = false;
  assert.equal(await check({ force: true }), false);
  assert.equal(await createGoogleProviderCheck(options)(), false, "disabled states are not cached");
  assert.equal(calls, 3);
  enabled = true; await check();
  now += PROVIDER_CACHE_AGE;
  await createGoogleProviderCheck(options)();
  assert.equal(calls, 5);
});

test("Google check failures and blocked storage do not poison later checks", async () => {
  let calls = 0;
  const check = createGoogleProviderCheck({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); } },
    url: "https://example.invalid", key: "public", now: () => instant, fetch: async () => {
      calls++; if (calls === 1) throw Error("offline");
      return { ok: true, json: async () => ({ external: { google: true } }) };
    } });
  await assert.rejects(check(), /offline/);
  assert.equal(await check(), true); await check(); assert.equal(calls, 2);
});

test("community caches are bounded, reusable across reloads, and scoped to the signed-in account", async () => {
  const saved = storage(); let now = instant, calls = 0;
  const client = { rpc: async () => { calls++; return { data: aggregate(), error: null }; } };
  const options = { client, storage: saved, now: () => now };
  const first = createCommunityCache(options);
  assert.deepEqual(await Promise.all([first.load("A"), first.load("A")]), [aggregate(), aggregate()]);
  await createCommunityCache(options).load("A"); assert.equal(calls, 1);
  await createCommunityCache(options).load("B"); assert.equal(calls, 2);
  now += COMMUNITY_CACHE_AGE;
  await createCommunityCache(options).load("B"); assert.equal(calls, 3);
  first.invalidate(); assert.equal(saved.getItem(COMMUNITY_CACHE_KEY), undefined);
  await assert.rejects(first.load(null), /Sign in/);
});

test("only aggregate fields are cached; corrupt, expired, or future entries trigger a fresh read", async () => {
  const value = aggregate(); value.profiles = [{ email: "private@example.invalid" }]; value.cities[0].instagram = "private.handle";
  value.top_books[0].user_ids = ["private-user"]; value.matches = [{ name: "Private Name" }];
  value.countries[0].members = ["private-user"]; value.countries[0].top_book.email = "private@example.invalid";
  assert.deepEqual(parseCommunity(value), aggregate());
  let calls = 0;
  const saved = storage(), client = { rpc: async () => { calls++; return { data: value }; } };
  for (const entry of ["bad JSON", { user_id: "A", fetched_at: instant + 1, data: value },
    { user_id: "A", fetched_at: instant, data: { ...value, total_members: 9 } },
    { user_id: "A", fetched_at: instant - COMMUNITY_CACHE_AGE, data: value }]) {
    saved.setItem(COMMUNITY_CACHE_KEY, typeof entry === "string" ? entry : JSON.stringify(entry));
    assert.deepEqual(await createCommunityCache({ client, storage: saved, now: () => instant }).load("A"), aggregate());
    assert.ok(!saved.getItem(COMMUNITY_CACHE_KEY).includes("private"));
  }
  assert.equal(calls, 4);
});

test("invalidation during a request cannot repopulate a signed-out or edited account's cache", async () => {
  const saved = storage(); let finish, calls = 0;
  const client = { rpc: async () => {
    calls++; if (calls === 1) return new Promise(resolve => { finish = resolve; });
    return { data: aggregate() };
  } };
  const cache = createCommunityCache({ client, storage: saved, now: () => instant });
  const old = cache.load("A"); cache.invalidate();
  await cache.load("B"); finish({ data: { ...aggregate(), total_members: 0, cities: [], countries: [] } }); await old;
  assert.equal(JSON.parse(saved.getItem(COMMUNITY_CACHE_KEY)).user_id, "B");
  assert.equal(JSON.parse(saved.getItem(COMMUNITY_CACHE_KEY)).data.total_members, 1);
});

test("country caches reject inconsistent counts, duplicate countries, and impossible favorite totals", () => {
  for (const change of [
    value => { value.countries[0].member_count = 2; },
    value => { value.countries.push(value.countries[0]); },
    value => { value.countries[0].top_book.votes = 2; },
  ]) {
    const data = aggregate(); change(data); assert.throws(() => parseCommunity(data));
  }
});

test("community errors are retryable and only changes affecting counts require invalidation", async () => {
  let calls = 0;
  const cache = createCommunityCache({ now: () => instant, client: { rpc: async () => {
    calls++; return calls === 1 ? { error: Error("offline") } : { data: aggregate() };
  } } });
  await assert.rejects(cache.load("A"), /offline/);
  assert.deepEqual(await cache.load("A"), aggregate());
  const before = { city_id: 1, favorite_book_id: "OL1W" };
  assert.equal(communityChanged(before, { ...before, display_name: "New", instagram_handle: "changed", current_book_id: "OL9W" }), false);
  assert.equal(communityChanged(before, { ...before, city_id: 2 }), true);
  assert.equal(communityChanged(before, { ...before, favorite_book_2_id: "ZB1" }), true);
  assert.equal(communityChanged(null, before), true);
});
