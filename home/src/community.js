import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../../matchmaking/src/config.js";

export const CACHE_KEY = "zbc.public-community-map.v1";
export const CACHE_AGE = 60 * 60 * 1000;

// Whitelist the public response before rendering or saving it in browser storage.
// The home page never reads a login session or requests individual profiles.
export function parsePublicMap(value) {
  if (!value || !Number.isSafeInteger(value.total_members) || value.total_members < 0
    || typeof value.generated_at !== "string" || !Number.isFinite(Date.parse(value.generated_at))
    || !Array.isArray(value.cities)) throw new Error("Invalid community map");
  const ids = new Set();
  const cities = value.cities.map(city => {
    if (!Number.isSafeInteger(city.id) || ids.has(city.id)
      || !Number.isSafeInteger(city.member_count) || city.member_count < 1
      || !Number.isFinite(city.latitude) || Math.abs(city.latitude) > 90
      || !Number.isFinite(city.longitude) || Math.abs(city.longitude) > 180
      || [city.name, city.region, city.country].some(text => typeof text !== "string" || text.length > 200)) {
      throw new Error("Invalid community city");
    }
    ids.add(city.id);
    const { id, name, region, country, latitude, longitude, member_count } = city;
    return { id, name, region, country, latitude, longitude, member_count };
  });
  if (cities.reduce((sum, city) => sum + city.member_count, 0) !== value.total_members) throw new Error("Inconsistent community total");
  return { generated_at: value.generated_at, total_members: value.total_members, cities };
}

export function createPublicMapLoader({ fetch, storage, now = Date.now, timeout = 10000 }) {
  let cached, pending;
  const fresh = data => data && now() - Date.parse(data.generated_at) >= -300000
    && now() - Date.parse(data.generated_at) < CACHE_AGE;
  return async function load() {
    if (fresh(cached)) return cached;
    try {
      const saved = storage?.getItem(CACHE_KEY);
      if (saved) {
        const data = parsePublicMap(JSON.parse(saved));
        if (fresh(data)) return (cached = data);
      }
      storage?.removeItem(CACHE_KEY);
    } catch { /* Storage may be disabled or contain an obsolete snapshot. */ }
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_public_matchmaking_map`, {
          method: "POST", headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
          body: "{}", credentials: "omit", signal: controller.signal,
        });
        if (!response.ok) throw new Error("Community map unavailable");
        const data = parsePublicMap(await response.json());
        if (!fresh(data)) throw new Error("Community snapshot expired");
        cached = data;
        try { storage?.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* The in-memory cache still works. */ }
        return data;
      } finally { clearTimeout(timer); }
    })();
    try { return await pending; } finally { pending = null; }
  };
}
