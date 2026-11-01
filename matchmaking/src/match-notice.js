const storagePrefix = "zebra-match-notice:v1:";

// Only release timestamps and opaque match IDs are remembered, never profiles.
// Memory provides the same per-account behavior for this visit if storage fails.
export function createMatchNotice({ document, window, getUserId }) {
  const dialog = document.querySelector("#match-notice-dialog");
  const close = document.querySelector("#match-notice-close");
  const jump = document.querySelector("#match-notice-jump");
  const section = document.querySelector(".matches-section");
  const heading = document.querySelector("#matches-title");
  const seen = new Map();
  let pending = null, returnFocus = null, shownFor = null;

  function remembered(account) {
    if (!seen.has(account)) {
      let value = null;
      try {
        const stored = JSON.parse(window.localStorage.getItem(storagePrefix + account));
        if (Number.isFinite(stored?.at) && Array.isArray(stored.ids)
          && stored.ids.every(id => typeof id === "string")) value = stored;
      } catch { /* Browser storage is optional. */ }
      seen.set(account, value);
    }
    return seen.get(account);
  }

  function dismiss(restoreFocus = true) {
    const previous = returnFocus, account = shownFor;
    returnFocus = null; shownFor = null;
    if (dialog.open) dialog.close();
    if (restoreFocus && account === getUserId() && previous?.isConnected) previous.focus({ preventScroll: true });
  }

  function tryShow() {
    if (!pending || dialog.open || document.hidden) return;
    if (pending.account !== getUserId()) { pending = null; return; }
    if (section.closest("[hidden]") || document.querySelector("dialog[open]")) return;
    const { account, release } = pending;
    returnFocus = document.activeElement;
    try { dialog.showModal(); } catch { returnFocus = null; return; }
    shownFor = account; pending = null;
    const previous = remembered(account);
    const value = { at: release.at, ids: [...new Set([
      ...(previous?.at === release.at ? previous.ids : []), ...release.ids,
    ])] };
    seen.set(account, value);
    try { window.localStorage.setItem(storagePrefix + account, JSON.stringify(value)); } catch { /* Retain the in-memory marker. */ }
    jump.focus({ preventScroll: true });
  }

  function offer(items) {
    const account = getUserId();
    if (!account || !Array.isArray(items)) return;
    const released = items.map(item => ({ id: item.id, at: Date.parse(item.released_at) }))
      .filter(item => typeof item.id === "string" && Number.isFinite(item.at) && item.at <= Date.now());
    if (!released.length) return;
    const at = Math.max(...released.map(item => item.at));
    const release = { at, ids: released.filter(item => item.at === at).map(item => item.id).sort() };
    const previous = remembered(account);
    if (previous && (at < previous.at || (at === previous.at && release.ids.every(id => previous.ids.includes(id))))) return;
    pending = { account, release };
    tryShow();
  }

  function cancel(event) { event.preventDefault(); dismiss(); }
  function closeNotice() { dismiss(); }
  function scrollToMatches() {
    if (shownFor !== getUserId()) { dismiss(false); return; }
    dismiss(false);
    heading.focus({ preventScroll: true });
    section.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }
  close.addEventListener("click", closeNotice);
  jump.addEventListener("click", scrollToMatches);
  dialog.addEventListener("cancel", cancel);
  document.addEventListener("visibilitychange", tryShow);
  const observer = new window.MutationObserver(tryShow);
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open", "hidden"] });

  function reset() { pending = null; dismiss(false); }
  return { offer, reset, destroy() {
    reset(); observer.disconnect();
    close.removeEventListener("click", closeNotice);
    jump.removeEventListener("click", scrollToMatches);
    dialog.removeEventListener("cancel", cancel);
    document.removeEventListener("visibilitychange", tryShow);
  } };
}
