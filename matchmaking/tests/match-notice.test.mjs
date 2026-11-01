import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { createMatchNotice } from "../src/match-notice.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const first = { id: "match-one", released_at: "2026-01-01T00:00:00Z" };
const newer = { id: "match-two", released_at: "2026-02-01T00:00:00Z" };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(t) {
  const window = new Window({ url: "https://example.test/matchmaking/", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  window.document.write(html);
  const $ = selector => window.document.querySelector(selector);
  $("#dashboard-view").hidden = false;
  let account = "account-a";
  const args = { document: window.document, window, getUserId: () => account };
  const notice = createMatchNotice(args);
  t.after(async () => { notice.destroy(); await window.happyDOM.close(); });
  return { notice, args, $, window, account: value => { account = value; } };
}

test("only released matches for a signed-in account trigger the exact notice", t => {
  const { notice, $, account } = setup(t);
  for (const items of [[], [{ id: "no-date" }], [{ id: "draft", released_at: null }], [{ id: "bad-date", released_at: "invalid" }], [{ id: "future", released_at: "2999-01-01T00:00:00Z" }]]) {
    notice.offer(items); assert.equal($("#match-notice-dialog").open, false);
  }
  account(null); notice.offer([first]); assert.equal($("#match-notice-dialog").open, false);
  account("account-a"); notice.offer([first]);
  assert.equal($("#match-notice-dialog").open, true);
  assert.equal($("#match-notice-title").textContent + " " + $("#match-notice-jump").textContent, "You've been matched! Click here to scroll down and see your match.");
  assert.equal($("#match-notice-jump"), $(":focus"));
});

test("close and Escape restore focus and persist one notice per release", t => {
  const { notice, $, window, args } = setup(t);
  const previous = $("#edit-profile"); previous.focus();
  notice.offer([first]); $("#match-notice-close").click();
  assert.equal($("#match-notice-dialog").open, false);
  assert.equal(window.document.activeElement, previous);
  notice.offer([first]); assert.equal($("#match-notice-dialog").open, false);
  notice.destroy();
  const revisit = createMatchNotice(args);
  t.after(() => revisit.destroy());
  revisit.offer([first]); assert.equal($("#match-notice-dialog").open, false, "a restored visit remembers the release");
  revisit.offer([newer, first]); assert.equal($("#match-notice-dialog").open, true);
  const escape = new window.Event("cancel", { cancelable: true });
  $("#match-notice-dialog").dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal($("#match-notice-dialog").open, false);
  assert.equal(window.document.activeElement, previous);
  const stored = window.localStorage.getItem("zebra-match-notice:v1:account-a");
  assert.deepEqual(JSON.parse(stored), { at: Date.parse(newer.released_at), ids: [newer.id] });
});

test("new IDs in the latest release notify once, while older history and removals do not", t => {
  const { notice, $ } = setup(t);
  notice.offer([newer]); $("#match-notice-close").click();
  notice.offer([first]); assert.equal($("#match-notice-dialog").open, false);
  const addition = { ...newer, id: "another-new-match" };
  notice.offer([addition, newer]); assert.equal($("#match-notice-dialog").open, true);
  $("#match-notice-close").click();
  notice.offer([newer, addition]); assert.equal($("#match-notice-dialog").open, false, "ordering does not create another release");
  notice.offer([addition]); assert.equal($("#match-notice-dialog").open, false, "removing a match does not create a release");
});

test("the CTA closes, focuses the match heading, and respects reduced motion", t => {
  const { notice, $, window } = setup(t);
  const scrolls = [];
  $(".matches-section").scrollIntoView = options => scrolls.push(options);
  window.matchMedia = () => ({ matches: false });
  notice.offer([first]); $("#match-notice-jump").click();
  assert.equal($("#match-notice-dialog").open, false);
  assert.equal(window.document.activeElement, $("#matches-title"));
  assert.deepEqual(scrolls, [{ block: "start", behavior: "smooth" }]);
  window.matchMedia = () => ({ matches: true });
  notice.offer([newer]); $("#match-notice-jump").click();
  assert.deepEqual(scrolls.at(-1), { block: "start", behavior: "instant" });
});

test("other dialogs and hidden dashboards defer the notice without consuming it", async t => {
  const { notice, $, window } = setup(t);
  const other = $("#instagram-dialog");
  other.showModal(); notice.offer([first]);
  assert.equal($("#match-notice-dialog").open, false);
  assert.equal(window.localStorage.length, 0);
  other.close(); await tick();
  assert.equal($("#match-notice-dialog").open, true);
  $("#match-notice-close").click();
  $("#dashboard-view").hidden = true; notice.offer([newer]);
  assert.equal($("#match-notice-dialog").open, false);
  $("#dashboard-view").hidden = false; await tick();
  assert.equal($("#match-notice-dialog").open, true);
});

test("account changes cancel pending notices and isolate release history", async t => {
  const { notice, $, account } = setup(t);
  notice.offer([first]); notice.reset(); account("account-b");
  assert.equal($("#match-notice-dialog").open, false);
  notice.offer([first]); assert.equal($("#match-notice-dialog").open, true, "same release is still new for another account");
  notice.reset(); account("account-a"); notice.offer([first]);
  assert.equal($("#match-notice-dialog").open, false);
  $("#invite-dialog").showModal(); notice.offer([newer]);
  notice.reset(); account(null); $("#invite-dialog").close(); await tick();
  assert.equal($("#match-notice-dialog").open, false, "queued account-a release cannot appear signed out");
});

test("blocked or malformed storage never breaks the page or repeatedly nags this visit", t => {
  const { notice, $, window } = setup(t);
  window.localStorage.setItem("zebra-match-notice:v1:account-a", "broken json");
  notice.offer([first]); $("#match-notice-close").click();
  Object.defineProperty(window, "localStorage", { get() { throw new Error("Storage blocked"); } });
  notice.offer([newer]); assert.equal($("#match-notice-dialog").open, true);
  $("#match-notice-close").click(); notice.reset(); notice.offer([newer]);
  assert.equal($("#match-notice-dialog").open, false);
});
