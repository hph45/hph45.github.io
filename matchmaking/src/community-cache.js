import { parsePublicMap } from "../../home/src/community.js";

export const COMMUNITY_CACHE_KEY = "zbc.member-community.v2";
export const COMMUNITY_CACHE_AGE = 15 * 60 * 1000;

// Explicitly allow aggregate fields only. Profiles, contacts, introductions,
// and ratings must never enter this browser cache.
export function parseCommunity(value) {
  const map = parsePublicMap({ ...value, generated_at: new Date(0).toISOString() });
  const books = (items, ranked) => {
    if (!Array.isArray(items)) throw new Error("Invalid community books");
    return items.map(book => {
      if ([book?.work_id, book?.title, book?.author].some(text => typeof text !== "string")
        || (ranked && (!Number.isSafeInteger(book.votes) || book.votes < 1))) throw new Error("Invalid community book");
      const { work_id, title, author } = book;
      return { work_id, title, author, ...(ranked ? { votes: book.votes } : {}) };
    });
  };
  let countries;
  if (value.countries !== undefined) {
    if (!Array.isArray(value.countries)) throw new Error("Invalid community countries");
    const seen = new Set();
    countries = value.countries.map(row => {
      if (typeof row?.country !== "string" || !row.country || row.country.length > 200 || seen.has(row.country)
        || !Number.isSafeInteger(row.member_count) || row.member_count < 1) throw new Error("Invalid community country");
      seen.add(row.country);
      const top_book = row.top_book ? books([row.top_book], true)[0] : null;
      if (top_book && top_book.votes > row.member_count) throw new Error("Invalid country favorites");
      return { country: row.country, member_count: row.member_count, top_book };
    });
    if (countries.reduce((sum, row) => sum + row.member_count, 0) !== map.total_members) throw new Error("Invalid country totals");
  }
  return { total_members: map.total_members, cities: map.cities,
    ...(countries ? { countries } : {}),
    top_books: books(value.top_books || [], true).slice(0, 10),
    rising_books: books(value.rising_books || [], false).slice(0, 2) };
}

export function communityChanged(before, after) {
  return !before || !after || ["city_id", "favorite_book_id", "favorite_book_2_id", "favorite_book_3_id"]
    .some(field => (before[field] ?? null) !== (after[field] ?? null));
}

export function createCommunityCache({ client, storage, now = Date.now }) {
  try { storage?.removeItem("zbc.member-community.v1"); } catch { /* Retire the older aggregate format. */ }
  let cached, pending, generation = 0;
  const valid = (entry, userId) => entry?.user_id === userId && Number.isFinite(entry.fetched_at)
    && now() >= entry.fetched_at && now() - entry.fetched_at < COMMUNITY_CACHE_AGE;
  function invalidate() {
    generation++; cached = null; pending = null;
    try { storage?.removeItem(COMMUNITY_CACHE_KEY); } catch { /* Storage is optional. */ }
  }
  async function load(userId) {
    if (!userId) throw new Error("Sign in to load the community");
    if (valid(cached, userId)) return cached.data;
    try {
      const saved = JSON.parse(storage?.getItem(COMMUNITY_CACHE_KEY) || "null");
      if (valid(saved, userId)) {
        cached = { user_id: userId, fetched_at: saved.fetched_at, data: parseCommunity(saved.data) };
        return cached.data;
      }
    } catch { /* A failed cache read never blocks a fresh authorized request. */ }
    if (pending?.userId === userId) return pending.promise;
    const current = generation;
    const request = { userId, promise: null };
    request.promise = (async () => {
      const { data, error } = await client.rpc("get_matchmaking_community");
      if (error || !data) throw error || new Error("No community data");
      const parsed = parseCommunity(data);
      if (current === generation && pending === request) {
        cached = { user_id: userId, fetched_at: now(), data: parsed };
        try { storage?.setItem(COMMUNITY_CACHE_KEY, JSON.stringify(cached)); } catch { /* Memory still works. */ }
      }
      return parsed;
    })();
    pending = request;
    try { return await request.promise; } finally { if (pending === request) pending = null; }
  }
  return { load, invalidate };
}
