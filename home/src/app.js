import { renderCommunityMap } from "../../matchmaking/src/map.js";
import { createPublicMapLoader, CACHE_AGE, MAX_SNAPSHOT_AGE } from "./community.js";

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
      // A scheduled publication can be delayed. Check the static file at a
      // bounded interval, never loop on a snapshot's already-passed hourly age.
      nextRefresh = Math.min(Date.now() + CACHE_AGE, Date.parse(data.generated_at) + MAX_SNAPSHOT_AGE);
    } catch {
      document.querySelector("#map-markers").replaceChildren();
      nextRefresh = Date.now() + CACHE_AGE;
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
