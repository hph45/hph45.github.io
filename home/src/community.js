export const CACHE_KEY = "zbc.public-community-map.v2";
export const CACHE_AGE = 15 * 60 * 1000;
export const MAX_SNAPSHOT_AGE = 3 * 60 * 60 * 1000;
export const SNAPSHOT_URL = "/assets/community-map.json";

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
  const usable = data => data && now() - Date.parse(data.generated_at) >= -300000
    && now() - Date.parse(data.generated_at) < MAX_SNAPSHOT_AGE;
  const fresh = entry => entry && Number.isFinite(entry.checked_at) && now() >= entry.checked_at
    && now() - entry.checked_at < CACHE_AGE && usable(entry.data);
  return async function load() {
    if (fresh(cached)) return cached.data;
    try {
      const saved = storage?.getItem(CACHE_KEY);
      if (saved) {
        const entry = JSON.parse(saved);
        entry.data = parsePublicMap(entry.data);
        if (fresh(entry)) { cached = entry; return cached.data; }
      }
      storage?.removeItem(CACHE_KEY);
    } catch { /* Storage may be disabled or contain an obsolete snapshot. */ }
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        // Every visitor reads the same CDN-hosted file. Never fall back to the
        // database on a miss/outage: that would recreate traffic-proportional logs.
        const response = await fetch(SNAPSHOT_URL, {
          cache: "no-cache", credentials: "omit", signal: controller.signal,
        });
        if (!response.ok) throw new Error("Community map unavailable");
        const data = parsePublicMap(await response.json());
        if (!usable(data)) throw new Error("Community snapshot expired");
        cached = { checked_at: now(), data };
        try { storage?.setItem(CACHE_KEY, JSON.stringify(cached)); } catch { /* The in-memory cache still works. */ }
        return data;
      } finally { clearTimeout(timer); }
    })();
    try { return await pending; } finally { pending = null; }
  };
}
