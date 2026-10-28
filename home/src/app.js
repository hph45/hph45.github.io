import { renderCommunityMap } from "../../matchmaking/src/map.js";
import { createPublicMapLoader, CACHE_AGE } from "./community.js";

const section = document.querySelector("#community");
if (section) {
  let storage;
  try { storage = window.localStorage; } catch { /* Private browsing can disable storage. */ }
  const load = createPublicMapLoader({ fetch: window.fetch.bind(window), storage });
  let visible = false, running = false, nextRefresh = 0, timer;

  async function refresh() {
    clearTimeout(timer);
    if (!visible || document.hidden || running) return;
    if (Date.now() < nextRefresh) {
      timer = setTimeout(refresh, nextRefresh - Date.now());
      return;
    }
    running = true;
    try {
      const data = await load();
      renderCommunityMap(document, data, { showCounts: false, hoverOnly: true });
      // Expire from the server's snapshot time, not fetch time, so the two
      // caches cannot combine into two hours of stale member locations.
      nextRefresh = Date.parse(data.generated_at) + CACHE_AGE;
    } catch {
      document.querySelector("#map-markers").replaceChildren();
      nextRefresh = Date.now() + 5 * 60 * 1000;
    } finally {
      running = false;
      if (visible && !document.hidden) timer = setTimeout(refresh, Math.max(1000, nextRefresh - Date.now()));
    }
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearTimeout(timer); else refresh(); });
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (visible) refresh(); else clearTimeout(timer);
    }, { rootMargin: "150px" });
    observer.observe(section);
  } else {
    visible = true;
    refresh();
  }
}
