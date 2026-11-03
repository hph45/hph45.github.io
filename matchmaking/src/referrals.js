import { normalizeInstagramHandle } from "./profile.js";

export const RAFFLE_PRIZES = { hoodie: "Hoodie", t_shirt: "T-shirt", cap: "Baseball cap" };
export const REFERRAL_STORAGE_KEY = "zebra-referral-signup";
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export function referralURL(handle) {
  const normalized = normalizeInstagramHandle(handle);
  if (!normalized) return "";
  const url = new URL("https://zebrabookclub.com/matchmaking/");
  url.searchParams.set("ref", normalized);
  return url.href;
}

// Only the inviter's handle and an optional prize choice survive Google OAuth.
// Never store the reader's answers, email, session, or current URL.
export function createReferralDraft(window) {
  let draft = {};
  try {
    const saved = JSON.parse(window.localStorage.getItem(REFERRAL_STORAGE_KEY));
    if (saved?.savedAt <= Date.now() && Date.now() - saved.savedAt < MAX_AGE) {
      draft = { handle: normalizeInstagramHandle(saved.handle) || "", prize: Object.hasOwn(RAFFLE_PRIZES, saved.prize) ? saved.prize : "", open: saved.open === true, savedAt: saved.savedAt };
    }
  } catch { /* Storage is optional; the same-tab draft still works. */ }
  const params = new URL(window.location.href).searchParams;
  if (params.has("ref")) { draft.handle = normalizeInstagramHandle(params.get("ref")) || ""; draft.savedAt = Date.now(); }
  if (params.has("raffle")) {
    draft.open = true;
    draft.savedAt = Date.now();
    if (Object.hasOwn(RAFFLE_PRIZES, params.get("raffle"))) draft.prize = params.get("raffle");
  }
  function persist() {
    try {
      if (draft.handle || draft.prize || draft.open) window.localStorage.setItem(REFERRAL_STORAGE_KEY, JSON.stringify({ ...draft, savedAt: draft.savedAt || Date.now() }));
      else window.localStorage.removeItem(REFERRAL_STORAGE_KEY);
    } catch { /* No persistent storage available. */ }
  }
  persist();
  return {
    get handle() { return draft.handle || ""; },
    get prize() { return draft.prize || ""; },
    get shouldOpen() { return Boolean(draft.open); },
    rememberPrize(prize) { draft.prize = Object.hasOwn(RAFFLE_PRIZES, prize) ? prize : ""; draft.open = true; draft.savedAt = Date.now(); persist(); },
    rememberHandle(handle) { draft.handle = normalizeInstagramHandle(handle) || ""; draft.savedAt = Date.now(); persist(); },
    consumeReferral() { delete draft.handle; persist(); },
    dismiss() { delete draft.open; delete draft.prize; persist(); },
    clear() { draft = {}; persist(); },
  };
}
