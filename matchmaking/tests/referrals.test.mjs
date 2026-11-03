import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createReferralDraft, REFERRAL_STORAGE_KEY, referralURL } from "../src/referrals.js";

test("personal invites include only a normalized Instagram credit", () => {
  assert.equal(referralURL("https://instagram.com/My.Books/"), "https://zebrabookclub.com/matchmaking/?ref=my.books");
  for (const handle of ["", "https://evil.test/a", "javascript:alert(1)", "a&code=secret", "a..b"]) assert.equal(referralURL(handle), "");
});
test("referral credit and prize survive the Google round trip without OAuth tokens", async () => {
  const window = new Window({ url: "https://zebrabookclub.com/matchmaking/?ref=%40Reader.Books&raffle=cap&code=SECRET#access_token=SECRET" });
  const draft = createReferralDraft(window);
  assert.equal(draft.handle, "reader.books"); assert.equal(draft.prize, "cap");
  assert.ok(!window.localStorage.getItem(REFERRAL_STORAGE_KEY).includes("SECRET"));
  window.history.replaceState({}, "", "/matchmaking/?code=return-code");
  const restored = createReferralDraft(window);
  assert.equal(restored.handle, "reader.books"); assert.equal(restored.prize, "cap");
  restored.consumeReferral(); assert.equal(restored.handle, ""); assert.equal(restored.prize, "cap");
  restored.clear(); assert.equal(window.localStorage.getItem(REFERRAL_STORAGE_KEY), null);
  await window.happyDOM.close();
});
test("expired or invalid referral drafts cannot prefill signup", async () => {
  const window = new Window({ url: "https://zebrabookclub.com/matchmaking/" });
  for (const saved of ["broken JSON", JSON.stringify({ savedAt: 1, handle: "old.reader" }), JSON.stringify({ savedAt: Date.now(), handle: "bad handle", prize: "__proto__" })]) {
    window.localStorage.setItem(REFERRAL_STORAGE_KEY, saved);
    const draft = createReferralDraft(window); assert.equal(draft.handle, ""); assert.equal(draft.prize, "");
  }
  await window.happyDOM.close();
});
