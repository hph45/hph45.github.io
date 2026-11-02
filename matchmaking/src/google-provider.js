const KEY = "zbc.google-provider.v1";
export const PROVIDER_CACHE_AGE = 24 * 60 * 60 * 1000;

// Only a successful public provider check is cached. OAuth itself still decides
// whether sign-in succeeds; this value never authenticates a member.
export function createGoogleProviderCheck({ fetch, storage, url, key, now = Date.now }) {
  let checkedAt = null, pending;
  const fresh = time => Number.isFinite(time) && now() >= time && now() - time < PROVIDER_CACHE_AGE;
  return async function check({ force = false } = {}) {
    if (force) {
      checkedAt = null;
      try { storage?.removeItem(KEY); } catch { /* Storage is optional. */ }
    } else {
      if (fresh(checkedAt)) return true;
      try {
        const cached = JSON.parse(storage?.getItem(KEY) || "null");
        if (cached?.enabled === true && fresh(cached.checked_at)) {
          checkedAt = cached.checked_at;
          return true;
        }
      } catch { /* Ignore obsolete or unavailable storage. */ }
    }
    if (pending) return pending;
    pending = (async () => {
      const response = await fetch(`${url}/auth/v1/settings`, {
        headers: { apikey: key }, signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error("Settings unavailable");
      const settings = await response.json();
      if (settings.external?.google === true) {
        checkedAt = now();
        try { storage?.setItem(KEY, JSON.stringify({ enabled: true, checked_at: checkedAt })); } catch { /* Memory still works. */ }
      }
      return settings.external?.google !== false;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
