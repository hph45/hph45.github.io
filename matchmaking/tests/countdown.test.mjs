import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { FIRST_MATCH_AT, NEXT_MATCH_AT, countdownParts, startMatchCountdown } from "../../assets/match-countdown.js";

test("the first-match countdown targets midnight UTC and rolls through every unit", () => {
  assert.equal(new Date(FIRST_MATCH_AT).toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(new Date(FIRST_MATCH_AT).getUTCDay(), 1);
  assert.deepEqual(countdownParts(FIRST_MATCH_AT - 90061000), [1, 1, 1, 1]);
  assert.deepEqual(countdownParts(FIRST_MATCH_AT - 86400000), [1, 0, 0, 0]);
  assert.deepEqual(countdownParts(FIRST_MATCH_AT - 86399000), [0, 23, 59, 59]);
  assert.deepEqual(countdownParts(FIRST_MATCH_AT - 3600000), [0, 1, 0, 0]);
  assert.deepEqual(countdownParts(FIRST_MATCH_AT - 60000), [0, 0, 1, 0]);
  assert.deepEqual(countdownParts(FIRST_MATCH_AT - 1), [0, 0, 0, 1]);
  assert.deepEqual(countdownParts(Date.parse("2026-11-01T15:00:00-08:00")), [0, 1, 0, 0]);
});

test("the next drop is November 17 UTC, fifteen days later, with no reset on reload or repeated unscheduled drops", () => {
  assert.equal(new Date(NEXT_MATCH_AT).toISOString(), "2026-11-17T00:00:00.000Z");
  assert.equal(new Date(NEXT_MATCH_AT).getUTCDay(), 2);
  assert.equal(NEXT_MATCH_AT - FIRST_MATCH_AT, 15 * 86400000);
  assert.deepEqual(countdownParts(FIRST_MATCH_AT), [15, 0, 0, 0]);
  assert.deepEqual(countdownParts(FIRST_MATCH_AT + 1000), [14, 23, 59, 59]);
  assert.deepEqual(countdownParts(FIRST_MATCH_AT + 86400000), [14, 0, 0, 0]);
  assert.deepEqual(countdownParts(Date.parse("2026-11-16T15:00:00-08:00")), [0, 1, 0, 0]);
  assert.deepEqual(countdownParts(NEXT_MATCH_AT - 1), [0, 0, 0, 1]);
  assert.deepEqual(countdownParts(NEXT_MATCH_AT), [0, 0, 0, 0]);
  assert.deepEqual(countdownParts(NEXT_MATCH_AT + 86400000), [0, 0, 0, 0]);
});

test("both pages switch without reloading, preserve animated digits, and recover after a suspended tab", async t => {
  for (const path of ["../../index.html", "../index.html"]) {
    const window = new Window({ settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false } });
    t.after(() => window.happyDOM.close());
    window.document.write(await readFile(new URL(path, import.meta.url), "utf8"));
    const timers = new Map(); let id = 0, time = FIRST_MATCH_AT - 90061000, hidden = false;
    window.setTimeout = callback => { timers.set(++id, callback); return id; };
    window.clearTimeout = timer => timers.delete(timer);
    Object.defineProperty(window.document, "hidden", { get: () => hidden });
    const countdown = startMatchCountdown({ document: window.document, window, now: () => time });
    t.after(() => countdown.destroy());
    const root = window.document.querySelector("[data-match-countdown]");
    const clock = root.querySelector("[data-countdown-clock]");
    const label = root.querySelector("[data-countdown-label]");
    const originalLabel = label.textContent;
    const parts = () => [...clock.querySelectorAll(".countdown-value")].map(node => node.textContent).join(":");
    const tick = () => { const callback = [...timers.values()][0]; assert.ok(callback); callback(); };
    assert.equal(parts(), "01:01:01:01");
    assert.equal(label.textContent, originalLabel);
    assert.equal(root.dataset.countdownPhase, "first");
    assert.equal(clock.getAttribute("aria-live"), "off", "seconds are not announced repeatedly");
    assert.match(clock.getAttribute("aria-label"), /1 day, 1 hour, 1 minute, 1 second/);
    const digits = [...clock.querySelectorAll(".countdown-digit")];
    time += 1000; tick();
    assert.equal(parts(), "01:01:01:00");
    assert.deepEqual([...clock.querySelectorAll(".countdown-digit")], digits);
    assert.equal(timers.size, 1);
    hidden = true; window.document.dispatchEvent(new window.Event("visibilitychange"));
    assert.equal(timers.size, 0);
    time += 75000;
    hidden = false; window.document.dispatchEvent(new window.Event("visibilitychange"));
    assert.equal(parts(), "01:00:59:45", "elapsed time comes from the deadline, not tick counts");
    window.dispatchEvent(new window.Event("pagehide")); assert.equal(timers.size, 0);
    time = FIRST_MATCH_AT - 1000; window.dispatchEvent(new window.Event("pageshow"));
    assert.equal(parts(), "00:00:00:01");
    time = FIRST_MATCH_AT; tick();
    assert.equal(parts(), "15:00:00:00");
    assert.equal(label.textContent, "Next match in:");
    assert.equal(root.dataset.countdownPhase, "next");
    assert.equal(root.dataset.countdownState, "running");
    assert.match(clock.getAttribute("aria-label"), /^15 days,.*until the next matches\.$/);
    assert.equal(timers.size, 1, "the timer keeps running after the first release");
    assert.deepEqual([...clock.querySelectorAll(".countdown-digit")], digits, "the release transition preserves the animation elements");
    time += 1000; tick();
    assert.equal(parts(), "14:23:59:59");
    hidden = true; window.document.dispatchEvent(new window.Event("visibilitychange"));
    time = FIRST_MATCH_AT + 3 * 86400000;
    hidden = false; window.document.dispatchEvent(new window.Event("visibilitychange"));
    assert.equal(parts(), "12:00:00:00");
    time = NEXT_MATCH_AT; tick();
    assert.equal(parts(), "00:00:00:00");
    assert.equal(root.dataset.countdownState, "complete");
    assert.equal(label.textContent, "Next match in:");
    assert.equal(clock.getAttribute("aria-label"), "The countdown to the next matches is complete.");
    assert.equal(timers.size, 0, "the countdown stops at the next scheduled drop");
    countdown.destroy();
    time -= 60000; window.dispatchEvent(new window.Event("pageshow"));
    assert.equal(timers.size, 0);
    if (path === "../index.html") assert.equal(root.closest("main > section"), null, "the banner stays visible across sign-in, onboarding, and dashboard views");
  }
});

test("fresh visits and older cached HTML start on the correct next-drop label and deadline", async t => {
  for (const path of ["../../index.html", "../index.html"]) {
    for (const time of [FIRST_MATCH_AT, FIRST_MATCH_AT + 2 * 86400000, NEXT_MATCH_AT + 1000]) {
      const window = new Window({ settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false } });
      t.after(() => window.happyDOM.close());
      window.document.write(await readFile(new URL(path, import.meta.url), "utf8"));
      const root = window.document.querySelector("[data-match-countdown]");
      const label = root.querySelector("[data-countdown-label]");
      label.removeAttribute("data-countdown-label"); // Previous HTML has the same stable class/ID.
      const countdown = startMatchCountdown({ document: window.document, window, now: () => time });
      t.after(() => countdown.destroy());
      assert.equal(label.textContent, "Next match in:");
      assert.equal(root.dataset.countdownPhase, "next");
      assert.deepEqual([...root.querySelectorAll(".countdown-value")].map(node => Number(node.textContent)), time === FIRST_MATCH_AT ? [15, 0, 0, 0] : time < NEXT_MATCH_AT ? [13, 0, 0, 0] : [0, 0, 0, 0]);
    }
  }
});
