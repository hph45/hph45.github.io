import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { openGuestCommunity } from "../src/guest-community.js";

test("community visits respect the shared sign-in on entry, across tabs, and when restored from history", t => {
  const browser = new Window();
  t.after(() => browser.close());
  const page = browser.document.body;
  let authEvent;
  const navigation = [];
  openGuestCommunity({ onAuthStateChange(callback) { authEvent = callback; } }, page, {
    addEventListener: browser.addEventListener.bind(browser),
    location: { replace: path => navigation.push(path), reload: () => navigation.push("reload") },
  });
  const signedIn = { user: { id: "member" } };
  authEvent("INITIAL_SESSION", signedIn);
  assert.equal(page.hasAttribute("data-guest-ready"), false);
  assert.deepEqual(navigation, ["/matchmaking/"]);
  authEvent("INITIAL_SESSION", null);
  assert.equal(page.hasAttribute("data-guest-ready"), true);
  authEvent("SIGNED_IN", signedIn);
  assert.equal(page.hasAttribute("data-guest-ready"), false);
  assert.deepEqual(navigation, ["/matchmaking/", "/matchmaking/"]);
  authEvent("INITIAL_SESSION", null);
  browser.dispatchEvent(new browser.Event("pagehide"));
  assert.equal(page.hasAttribute("data-guest-ready"), false);
  const restore = new browser.Event("pageshow");
  Object.defineProperty(restore, "persisted", { value: true });
  browser.dispatchEvent(restore);
  assert.equal(navigation.at(-1), "reload");
});
