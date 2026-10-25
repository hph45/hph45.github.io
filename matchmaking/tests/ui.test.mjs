import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { createMatchmakingApp } from "../src/ui.js";
import { makeProfile } from "../src/profile.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const member = { id: "00000000-0000-4000-8000-000000000001", email: "reader@example.invalid", user_metadata: { given_name: "Reader" } };
const profile = { ...makeProfile({ display_name: "Reader", instagram_handle: "reader.books", birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States", intent: "friends", favorite_book_id: "OL1W", favorite_book: "A book", favorite_author: "An author", location_preference: "same_city", friendship_interests: "Afternoons in bookshops" }), user_id: member.id };

function mockClient({ signedIn = true, initialProfile = null, matches = [], risingBooks = [], communityError = false } = {}) {
  const state = { profile: initialProfile ? structuredClone(initialProfile) : null, calls: [], failNext: false, matches, communityError, session: signedIn ? { user: member } : null };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      onAuthStateChange: callback => { state.onAuth = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithOAuth: async options => { state.oauth = options; return { data: null, error: new Error("Provider unavailable") }; },
      signOut: async () => { state.session = null; state.onAuth("SIGNED_OUT", null); return { error: null }; },
    },
    from(table) {
      const call = { table, action: "select" };
      const query = {
        select() { return query; },
        eq(column, value) { call.filter = [column, value]; return query; },
        insert(values) { call.action = "insert"; call.values = values; return query; },
        update(values) { call.action = "update"; call.values = values; return query; },
        maybeSingle: async () => ({ data: state.profile, error: null }),
        async single() {
          state.calls.push(call);
          if (state.failNext) { const error = state.failNext === true ? new Error("Network failure") : state.failNext; state.failNext = false; return { data: null, error }; }
          const now = new Date().toISOString();
          const favoritesChanged = call.action === "insert" || ["favorite_book_id", "favorite_book_2_id", "favorite_book_3_id"].some(key => Object.hasOwn(call.values, key) && call.values[key] !== state.profile?.[key]);
          const currentChanged = Object.hasOwn(call.values, "current_book_id") && call.values.current_book_id !== (state.profile?.current_book_id ?? null);
          state.profile = { ...state.profile, ...call.values,
            books_updated_at: favoritesChanged ? now : state.profile?.books_updated_at,
            current_book_updated_at: currentChanged ? now : state.profile?.current_book_updated_at ?? null,
          };
          return { data: structuredClone(state.profile), error: null };
        },
      };
      return query;
    },
    rpc: async name => ({ data: name === "get_matchmaking_community" ? { total_members: 1, cities: [{ id: 5378538, name: "Oakland", region: "California", country: "United States", latitude: 37.8, longitude: -122.27, member_count: 1 }], top_books: [{ work_id: "OL1W", title: "A book", author: "An author", votes: 1 }], rising_books: risingBooks } : state.matches, error: name === "get_matchmaking_community" && state.communityError ? new Error("Unavailable") : null }),
    functions: { invoke: async () => ({ data: { deleted: true }, error: null }) },
  };
  return { client, state };
}

async function setup(t, options = {}) {
  const window = new Window({ url: "http://127.0.0.1:8080/matchmaking/", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false } });
  window.document.write(html);
  if (options.intent) window.localStorage.setItem("zebra-matchmaking-intent", options.intent);
  if (options.intents) window.localStorage.setItem("zebra-matchmaking-intents", JSON.stringify(options.intents));
  const mock = mockClient(options);
  const app = createMatchmakingApp({ ...mock, document: window.document, window, fetch: async () => ({ ok: true, json: async () => ({ external: { google: options.googleEnabled ?? true } }) }) });
  await app.start();
  t.after(async () => { app.destroy(); await window.happyDOM.close(); });
  const $ = selector => window.document.querySelector(selector);
  const set = (name, value) => {
    if (Array.isArray(value)) {
      window.document.querySelectorAll(`[name="${name}"]`).forEach(input => { input.checked = value.includes(input.value); });
    } else {
      const input = $(`[name="${name}"]`);
      if (input.type === "checkbox") input.checked = value; else input.value = value;
    }
  };
  const event = async (selector, name = "click") => { $(selector).dispatchEvent(new window.Event(name, { bubbles: true, cancelable: true })); await app.settled(); };
  return { ...mock, app, window, $, set, event };
}

test("a new member can finish all three steps with one book and no explanation", async t => {
  const { $, set, event, state } = await setup(t, { intent: "friends" });
  assert.equal($("#onboarding-view").hidden, false);
  assert.equal($('[name="intents"][value="friends"]').checked, true);
  assert.equal($('[name="display_name"]').value, "Reader");
  for (const [key, value] of Object.entries({ instagram_handle: "reader.books", birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States" })) set(key, value);
  await event("#profile-form", "submit");
  assert.equal($('[data-step="1"]').hidden, false);
  assert.equal($('[data-step="0"]').disabled, true);
  assert.equal($('[name="book_reason"]'), null);
  assert.equal($('[name="favorite_book_2"]').required, false);
  assert.equal($('[name="favorite_book_3"]').required, false);
  assert.equal($('[name="current_book"]').required, false);
  set("favorite_book_id", "OL1W"); set("favorite_book", "Parable of the Sower"); set("favorite_author", "Octavia Butler");
  await event("#profile-form", "submit");
  assert.equal($('[data-step="2"]').hidden, false);
  set("friendship_interests", "Bookshop afternoons and coffee");
  await event("#profile-form", "submit");
  assert.equal(state.calls.length, 0, "consent is required");
  set("profile_consent", true);
  state.failNext = true;
  await event("#profile-form", "submit");
  assert.equal($("#dashboard-view").hidden, true, "a failed save must not show success");
  assert.equal($('[name="favorite_book"]').value, "Parable of the Sower", "answers survive a failed save");
  assert.match($("#form-error").textContent, /couldn’t save/);
  await event("#profile-form", "submit");
  assert.equal($("#dashboard-view").hidden, false);
  assert.equal(state.profile.city, "Oakland");
  assert.equal(state.profile.favorite_book, "Parable of the Sower");
  assert.equal(state.profile.favorite_book_2_id, null);
  assert.equal(state.profile.favorite_book_3_id, null);
  assert.equal(state.profile.current_book_id, null);
  assert.equal($("#profile-current-reading").hidden, true);
  assert.ok(!("book_reason" in state.profile));
  assert.deepEqual(state.profile.intents, ["friends"]);
  assert.equal(state.profile.email_matches, false);
  assert.equal(state.profile.user_id, member.id);
  assert.equal(state.profile.instagram_handle, "reader.books");
  assert.equal($("#instagram-dialog").open, false);
  assert.equal(state.calls.at(-1).action, "insert");
});

test("signup asks for a valid Instagram on the first step", async t => {
  const { $, set, event, state } = await setup(t, { intent: "friends" });
  for (const [key, value] of Object.entries({ birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States" })) set(key, value);
  assert.equal($('[name="instagram_handle"]').required, true);
  assert.equal($("#instagram-dialog").open, false);
  for (const value of ["", "two words", "https://evil.test/reader"]) {
    set("instagram_handle", value); await event("#profile-form", "submit");
    assert.equal($('[data-step="0"]').hidden, false);
    assert.match($("#form-error").textContent, /Instagram/);
    assert.equal(state.calls.length, 0);
  }
  set("instagram_handle", "https://www.instagram.com/Reader.Books/?igsh=tracking");
  await event("#profile-form", "submit");
  assert.equal($('[data-step="1"]').hidden, false);
});

test("existing members can choose Not now, edit other answers, and return to the prompt from their profile", async t => {
  const { $, set, event, state } = await setup(t, { initialProfile: { ...profile, instagram_handle: null } });
  assert.equal($("#instagram-dialog").open, true);
  assert.match($("#instagram-description").textContent, /before you can be matched/);
  assert.equal($("#dashboard-view").hidden, false);
  await event("#instagram-later");
  assert.equal($("#instagram-dialog").open, false);
  assert.equal(state.calls.length, 0);
  await event("#edit-profile");
  assert.equal($('[name="instagram_handle"]').required, false);
  set("display_name", "Updated reader");
  for (let i = 0; i < 3; i++) await event("#profile-form", "submit");
  assert.equal(state.profile.display_name, "Updated reader");
  assert.equal(state.profile.instagram_handle, null);
  assert.equal($("#instagram-dialog").open, false, "ordinary dashboard rerenders do not nag after Not now");
  await event("#add-instagram"); assert.equal($("#instagram-dialog").open, true);
  await event("#instagram-dialog", "cancel"); assert.equal($("#instagram-dialog").open, false);
  await event("#pause-matching"); assert.equal($("#instagram-dialog").open, false);
  const nextVisit = await setup(t, { initialProfile: state.profile });
  assert.equal(nextVisit.$("#instagram-dialog").open, true, "the next visit asks again, even with a restored sign-in");
});

test("the Instagram popup validates, retains failed drafts, and saves only the owner's contact without changing book clocks", async t => {
  const time = new Date().toISOString();
  const { $, event, state } = await setup(t, { initialProfile: { ...profile, instagram_handle: null, books_updated_at: time, current_book_updated_at: time } });
  $("#instagram-prompt-input").value = "https://evil.test/reader";
  await event("#instagram-form", "submit");
  assert.equal(state.calls.length, 0);
  assert.equal($("#instagram-prompt-input").getAttribute("aria-invalid"), "true");
  const input = "https://www.instagram.com/Reader.Books/?igsh=tracking";
  $("#instagram-prompt-input").value = input;
  state.failNext = true; await event("#instagram-form", "submit");
  assert.equal($("#instagram-dialog").open, true);
  assert.equal($("#instagram-prompt-input").value, input);
  assert.equal($("#instagram-error").hidden, false);
  assert.equal($("#save-instagram").disabled, false);
  await event("#instagram-form", "submit");
  assert.deepEqual(state.calls.at(-1).values, { instagram_handle: "reader.books" });
  assert.deepEqual(state.calls.at(-1).filter, ["user_id", member.id]);
  assert.equal(state.profile.books_updated_at, time);
  assert.equal(state.profile.current_book_updated_at, time);
  assert.equal($("#instagram-dialog").open, false);
  assert.equal($("#profile-instagram a").href, "https://www.instagram.com/reader.books/");
  assert.equal($("#profile-instagram a").rel, "noopener noreferrer");
  const nextVisit = await setup(t, { initialProfile: state.profile });
  assert.equal(nextVisit.$("#instagram-dialog").open, false);
});

test("members can update their Instagram from the profile editor but cannot clear it after supplying it", async t => {
  const { $, set, event, state } = await setup(t, { initialProfile: profile });
  await event("#edit-profile");
  assert.equal($('[name="instagram_handle"]').required, true);
  set("instagram_handle", ""); await event("#profile-form", "submit");
  assert.match($("#form-error").textContent, /Instagram/);
  set("instagram_handle", "@New.Handle");
  for (let i = 0; i < 3; i++) await event("#profile-form", "submit");
  assert.equal(state.profile.instagram_handle, "new.handle");
  assert.equal($("#profile-instagram a").href, "https://www.instagram.com/new.handle/");
});

test("a delayed Instagram save cannot restore private content or block the next signed-in account", async t => {
  const { $, app, state, client, window } = await setup(t, { initialProfile: { ...profile, instagram_handle: null } });
  let finish;
  const originalFrom = client.from;
  client.from = table => { const query = originalFrom(table); query.single = () => new Promise(resolve => { finish = resolve; }); return query; };
  $("#instagram-prompt-input").value = "@old.account";
  $("#instagram-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise(resolve => window.setTimeout(resolve, 0));
  assert.equal($("#save-instagram").disabled, true);
  state.onAuth("SIGNED_OUT", null);
  await new Promise(resolve => window.setTimeout(resolve, 10));
  assert.equal($("#instagram-dialog").open, false);
  assert.equal($("#instagram-prompt-input").value, "");
  const next = { ...member, id: "00000000-0000-4000-8000-000000000002" };
  state.profile = { ...profile, user_id: next.id, display_name: "Next reader", instagram_handle: null };
  state.onAuth("SIGNED_IN", { user: next });
  await new Promise(resolve => window.setTimeout(resolve, 10));
  assert.equal($("#instagram-dialog").open, true);
  assert.equal($("#save-instagram").disabled, false);
  $("#instagram-prompt-input").value = "next.account";
  finish({ data: { ...profile, instagram_handle: "old.account" }, error: null });
  await app.settled();
  assert.equal($("#instagram-prompt-input").value, "next.account");
  assert.equal($("#instagram-dialog").open, true);
  assert.match($("#profile-name").textContent, /Next reader/);
  assert.equal($("#profile-instagram a"), null);
});

test("released matches offer safe Instagram contact links for every connection type", async t => {
  const match = { week_start: "2026-10-19", display_name: "Reader", age: 30, city: "Oakland", country: "United States" };
  const { $ } = await setup(t, { initialProfile: profile, matches: [
    ...["romance", "friends", "business_partners"].map(intent => ({ ...match, intent, instagram_handle: "other.reader" })),
    { ...match, intent: "friends", instagram_handle: "javascript:alert(1)" },
  ] });
  const links = $("#matches-list").querySelectorAll("a.instagram-link");
  assert.equal(links.length, 3);
  for (const link of links) {
    assert.equal(link.href, "https://www.instagram.com/other.reader/");
    assert.equal(link.target, "_blank"); assert.equal(link.rel, "noopener noreferrer");
  }
  assert.ok(!$("#matches-list").textContent.includes("javascript:"));
});

test("signup uses the shared book search for an optional current read and preserves it after a failed save", async t => {
  const { $, set, event, state, client, window } = await setup(t, { intent: "friends" });
  const queries = [];
  client.functions.invoke = async (name, { body }) => {
    queries.push({ name, body });
    return { data: { books: [{ work_id: "OL4W", title: "A current read", author: "Current author" }] }, error: null };
  };
  for (const [key, value] of Object.entries({ instagram_handle: "reader.books", birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States", favorite_book_id: "OL1W", favorite_book: "A favorite", favorite_author: "Favorite author" })) set(key, value);
  await event("#profile-form", "submit");
  set("current_book", "A current"); await event('[name="current_book"]', "input");
  await new Promise(resolve => window.setTimeout(resolve, 500));
  assert.deepEqual(queries[0], { name: "search-books", body: { query: "A current" } });
  assert.equal($("#current_book-suggestions").hidden, false);
  await event("#current_book-suggestions-0");
  assert.equal($('[name="current_book_id"]').value, "OL4W");
  assert.equal($('[name="current_author"]').value, "Current author");
  await event("#profile-form", "submit");
  set("friendship_interests", "Afternoons in bookshops"); set("profile_consent", true);
  state.failNext = true; await event("#profile-form", "submit");
  assert.equal($('[name="current_book"]').value, "A current read");
  await event("#profile-form", "submit");
  assert.equal(state.profile.current_book_id, "OL4W");
  assert.equal($("#profile-current-reading").hidden, false);
  assert.match($("#profile-current-reading").textContent, /Currently reading.*A current read.*Current author/);
  assert.equal(state.profile.favorite_book_2_id, null);
  await event("#edit-profile"); await event("#profile-form", "submit");
  assert.equal($("#current-reading-fields").disabled, true);
  assert.match($("#current-reading-lock-note").textContent, /change your current read again/);
});

test("signup can save typed favorites and a current read when suggestions fail or find nothing", async t => {
  for (const unavailable of [true, false]) await t.test(unavailable ? "search outage" : "book not listed", async t => {
    const { $, set, event, state, client, window } = await setup(t, { intent: "friends" });
    client.functions.invoke = async () => ({ data: { books: [] }, error: unavailable ? new Error("Offline") : null });
    const originalRPC = client.rpc;
    client.rpc = (name, args) => {
      if (name !== "search_matchmaking_books") return originalRPC(name, args);
      const response = Promise.resolve({ data: [], error: unavailable ? new Error("Offline") : null });
      response.abortSignal = () => response;
      return response;
    };
    for (const [key, value] of Object.entries({ instagram_handle: "reader.books", birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States" })) set(key, value);
    await event("#profile-form", "submit");
    set("favorite_book", "A book outside the catalog"); await event('[name="favorite_book"]', "input");
    set("favorite_author", "An author"); await event('[name="favorite_author"]', "input");
    set("favorite_book_2", "Another unlisted favorite");
    set("current_book", "My current read"); await event('[name="current_book"]', "input");
    await new Promise(resolve => window.setTimeout(resolve, 500));
    assert.match($('[name="favorite_book"]').closest(".autocomplete").textContent, unavailable ? /can still enter your book/ : /use the title you typed/);
    assert.equal($('[name="favorite_author"]').readOnly, false);
    assert.equal($('[name="current_author"]').required, false);
    await event("#profile-form", "submit");
    assert.equal($('[data-step="2"]').hidden, false, "suggestions are optional");
    set("friendship_interests", "Bookshop afternoons"); set("profile_consent", true);
    state.failNext = true; await event("#profile-form", "submit");
    assert.equal($('[name="favorite_book"]').value, "A book outside the catalog");
    await event("#profile-form", "submit");
    assert.equal($("#dashboard-view").hidden, false);
    const submitted = state.calls.at(-1).values;
    assert.equal(submitted.favorite_book_id, "manual");
    assert.equal(submitted.favorite_book_2_id, "manual");
    assert.equal(submitted.current_book_id, "manual");
    assert.equal(submitted.favorite_author, "An author");
    assert.equal(submitted.current_author, "");
  });
});

test("editing an autofilled author switches to free text and title edits preserve a typed author", async t => {
  const { $, set, event } = await setup(t, { initialProfile: profile });
  await event("#edit-profile"); await event("#profile-form", "submit");
  set("favorite_author", "Corrected author"); await event('[name="favorite_author"]', "input");
  assert.equal($('[name="favorite_book_id"]').value, "");
  set("favorite_book", "Corrected title"); await event('[name="favorite_book"]', "input");
  assert.equal($('[name="favorite_author"]').value, "Corrected author");
  set("favorite_book", ""); await event('[name="favorite_book"]', "input");
  assert.equal($('[name="favorite_author"]').value, "");
});

test("current reads can change when their own clock allows it, and cleared reads stay locked", async t => {
  const saved = { ...profile, current_book_id: "OL4W", current_book: "A current read", current_author: "Current author", books_updated_at: new Date().toISOString() };
  const { $, set, event, state, window } = await setup(t, { initialProfile: saved });
  await event("#edit-profile"); await event("#profile-form", "submit");
  assert.equal($('#favorite-book-fields').disabled, true);
  assert.equal($('[name="current_book"]').closest('fieldset[disabled]'), null);
  assert.equal($('[name="current_book"]').value, "A current read");
  set("current_book_id", "OL5W"); set("current_book", "The next read"); set("current_author", "Another author");
  await event("#profile-form", "submit"); await event("#profile-form", "submit");
  assert.equal(state.profile.current_book, "The next read");
  assert.equal(state.profile.favorite_book_id, "OL1W");
  assert.equal(state.profile.books_updated_at, saved.books_updated_at);
  assert.match($("#profile-current-reading-status").textContent, /change your current read again/);
  await event("#edit-profile"); await event("#profile-form", "submit");
  assert.equal($("#current-reading-fields").disabled, true);
  await event("#cancel-edit");
  // Simulate the server's clock after the full interval, then reload the profile.
  state.profile.current_book_updated_at = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000).toISOString();
  await event("#retry-profile");
  await event("#edit-profile"); await event("#profile-form", "submit");
  assert.equal($("#current-reading-fields").disabled, false);
  set("current_book", ""); await event('[name="current_book"]', "input");
  assert.equal($('[name="current_book_id"]').value, "");
  assert.equal($('[name="current_author"]').value, "");
  await event("#profile-form", "submit"); await event("#profile-form", "submit");
  assert.equal(state.profile.current_book_id, null);
  assert.equal($("#profile-current-reading").hidden, true);
  assert.equal($("#profile-current-reading-status").hidden, false);
  await event("#edit-profile"); await event("#profile-form", "submit");
  assert.equal($("#current-reading-fields").disabled, true);
  await event("#cancel-edit");
  await event("#edit-profile"); set("current_book", "An unsaved read"); set("current_book_id", "OL6W");
  await event("#cancel-edit"); await event("#edit-profile");
  assert.equal($('[name="current_book"]').value, "");
  set("current_book", "An unsaved read"); set("current_book_id", "OL6W");
  await event("#sign-out");
  assert.equal($('[name="current_book"]').value, "");
  assert.equal($('[name="current_book_id"]').value, "");
  assert.equal($("#profile-current-reading").textContent, "");
});

test("a current-read lock leaves favorites and other profile answers editable", async t => {
  const readingTime = new Date().toISOString();
  const { $, set, event, state } = await setup(t, { initialProfile: { ...profile, current_book_id: "OL4W", current_book: "A current read", current_author: "Current author", current_book_updated_at: readingTime, books_updated_at: "2000-01-01T00:00:00Z" } });
  await event("#edit-profile"); set("display_name", "A new name"); await event("#profile-form", "submit");
  assert.equal($("#favorite-book-fields").disabled, false);
  assert.equal($("#current-reading-fields").disabled, true);
  assert.equal($("#current-reading-lock-note").hidden, false);
  set("favorite_book_id", "OL5W"); set("favorite_book", "A new favorite");
  await event("#profile-form", "submit"); await event("#profile-form", "submit");
  assert.equal(state.profile.display_name, "A new name");
  assert.equal(state.profile.favorite_book_id, "OL5W");
  assert.equal(state.profile.current_book_id, "OL4W");
  assert.equal(state.profile.current_book_updated_at, readingTime);
});

test("the current-read field unlocks automatically when its interval ends", async t => {
  const { $, event, window } = await setup(t, { initialProfile: { ...profile, current_book_updated_at: new Date(Date.now() - 24 * 60 * 60 * 1000 + 600).toISOString() } });
  await event("#edit-profile"); await event("#profile-form", "submit");
  assert.equal($("#current-reading-fields").disabled, true);
  await new Promise(resolve => window.setTimeout(resolve, 700));
  assert.equal($("#current-reading-fields").disabled, false);
  assert.equal($("#current-reading-lock-note").hidden, true);
  assert.equal($("#profile-current-reading-status").hidden, true);
});

test("a stale tab shows the server's current-read lock without losing the draft", async t => {
  const { $, set, event, state } = await setup(t, { initialProfile: profile });
  await event("#edit-profile"); await event("#profile-form", "submit");
  set("current_book_id", "OL4W"); set("current_book", "A current read"); set("current_author", "Current author");
  await event("#profile-form", "submit");
  state.failNext = { message: "CURRENT_READING_LOCKED" };
  await event("#profile-form", "submit");
  assert.match($("#form-error").textContent, /current read.*once every 24 hours/);
  assert.equal($('[name="current_book"]').value, "A current read");
  assert.equal($("#dashboard-view").hidden, true);
});

test("current-read titles render as plain text in profiles and released introductions", async t => {
  const title = '<img src=x onerror="alert(1)">';
  const { $ } = await setup(t, { initialProfile: { ...profile, current_book_id: "OL4W", current_book: title, current_author: "An author" }, matches: [{ ...profile, age: 32, intent: "friends", week_start: "2026-10-19", reason: "Shared interests", current_book: title, current_author: "An author" }] });
  assert.equal($("#profile-current-reading img"), null);
  assert.ok($("#profile-current-reading").textContent.includes(title));
  assert.equal($("#matches-list img"), null);
  assert.ok($("#matches-list").textContent.includes(`Currently reading${title} — An author`));
});

test("signup stays three steps and requires the questions for every selected type", async t => {
  const types = ["romance", "friends", "business_partners"];
  const { $, set, event, state, window } = await setup(t, { intents: types });
  assert.equal(window.document.querySelectorAll("[data-progress]").length, 3);
  for (const type of types) assert.equal($(`[name="intents"][value="${type}"]`).checked, true);
  set("intents", []);
  await event("#profile-form", "submit");
  assert.match($("#form-error").textContent, /at least one/);
  assert.equal(window.document.activeElement, $('[name="intents"]'));
  assert.equal($('[name="intents"]').getAttribute("aria-invalid"), "true");
  set("intents", types);
  for (const [key, value] of Object.entries({ instagram_handle: "reader.books", birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States" })) set(key, value);
  await event("#profile-form", "submit");
  set("favorite_book_id", "OL1W"); set("favorite_book", "A book"); set("favorite_author", "An author");
  await event("#profile-form", "submit");
  for (const type of types) {
    assert.equal($(`[data-preferences="${type}"]`).hidden, false);
    assert.equal($(`[data-preferences="${type}"]`).disabled, false);
  }
  set("profile_consent", true);
  await event("#profile-form", "submit");
  assert.equal(window.document.activeElement, $('[name="gender"]'));
  set("gender", "other"); set("interested_in", ["woman", "other"]);
  await event("#profile-form", "submit");
  assert.equal(window.document.activeElement, $('[name="friendship_interests"]'));
  set("friendship_interests", "Afternoons in bookshops");
  await event("#profile-form", "submit");
  assert.equal(window.document.activeElement, $('[name="business_about"]'));
  set("business_about", "A community bookstore"); set("business_skills", "Planning great events");
  await event("#profile-form", "submit");
  assert.equal(window.document.activeElement, $('[name="business_seeking"]'));
  assert.equal(state.calls.length, 0, "no partially completed multi-type profile is submitted");
  set("business_seeking", "An operations partner");
  // Going back to adjust choices never clears in-progress answers.
  await event("#previous-step"); await event("#previous-step");
  set("intents", ["romance", "friends"]); await event('[name="intents"]', "change");
  set("intents", types); await event('[name="intents"]', "change");
  await event("#profile-form", "submit"); await event("#profile-form", "submit");
  assert.equal($('[name="business_seeking"]').value, "An operations partner");
  await event("#profile-form", "submit");
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.profile.intents, types);
  assert.equal(state.profile.romance_ideal_match, "", "existing optional answers remain optional");
  assert.equal(state.profile.business_linkedin_url, "");
  assert.equal(state.profile.favorite_book_2_id, null, "shared books are only entered once");
  assert.equal($("#dashboard-view").hidden, false);
  assert.equal($("#profile-category").textContent, "Romance · Friends · Business partners");
  assert.match($("#profile-preferences").textContent, /Afternoons in bookshops/);
  assert.match($("#profile-preferences").textContent, /An operations partner/);
  await event("#edit-profile");
  for (const type of types) assert.equal($(`[name="intents"][value="${type}"]`).checked, true);
});

test("editing a legacy profile can add a type without losing its existing answers or book lock", async t => {
  const legacy = { ...profile, intent: "friends", books_updated_at: new Date().toISOString() };
  delete legacy.intents;
  const { $, set, event, state } = await setup(t, { initialProfile: legacy, intents: ["business_partners"] });
  await event("#edit-profile");
  assert.equal($('[name="intents"][value="friends"]').checked, true, "the saved profile wins over welcome selections");
  assert.equal($('[name="intents"][value="business_partners"]').checked, false);
  set("intents", ["romance", "friends"]);
  await event("#profile-form", "submit");
  assert.equal($('[data-step="1"]').disabled, false);
  assert.equal($('#favorite-book-fields').disabled, true);
  await event("#profile-form", "submit");
  assert.equal($('[name="friendship_interests"]').value, profile.friendship_interests);
  set("gender", "man"); set("interested_in", ["woman"]);
  set("romance_ideal_match", "Someone who loves stories");
  await event("#profile-form", "submit");
  assert.deepEqual(state.profile.intents, ["romance", "friends"]);
  assert.equal(state.profile.friendship_interests, profile.friendship_interests);
  assert.equal(state.profile.favorite_book_id, profile.favorite_book_id);
  await event("#edit-profile");
  set("intents", ["friends"]);
  await event("#cancel-edit");
  assert.deepEqual(state.profile.intents, ["romance", "friends"], "cancel discards the draft");
  await event("#edit-profile");
  assert.equal($('[name="intents"][value="romance"]').checked, true);
  set("intents", ["friends"]);
  await event("#profile-form", "submit"); await event("#profile-form", "submit");
  assert.equal($('[data-preferences="romance"]').disabled, true);
  assert.equal($('[data-preferences="romance"]').hidden, true);
  await event("#profile-form", "submit");
  assert.deepEqual(state.profile.intents, ["friends"]);
  assert.equal(state.profile.gender, null);
  assert.equal(state.profile.romance_ideal_match, "");
  assert.equal(state.profile.friendship_interests, profile.friendship_interests);
});

test("welcome choices toggle independently and survive the Google sign-in redirect", async t => {
  const { $, event, window } = await setup(t, { signedIn: false });
  await event('[data-intent="romance"]'); await event('[data-intent="friends"]');
  await event('[data-intent="business_partners"]'); await event('[data-intent="friends"]');
  assert.equal($('[data-intent="romance"]').getAttribute("aria-pressed"), "true");
  assert.equal($('[data-intent="friends"]').getAttribute("aria-pressed"), "false");
  assert.equal($('[data-intent="business_partners"]').getAttribute("aria-pressed"), "true");
  const intents = JSON.parse(window.localStorage.getItem("zebra-matchmaking-intents"));
  assert.deepEqual(intents, ["romance", "business_partners"]);
  const returned = await setup(t, { intents });
  assert.equal(returned.$('[name="intents"][value="romance"]').checked, true);
  assert.equal(returned.$('[name="intents"][value="business_partners"]').checked, true);
  assert.equal(returned.$('[name="intents"][value="friends"]').checked, false);
});

test("editing intent clears old preferences, preserves a pause, and writes only the owner row", async t => {
  const romance = { ...profile, intents: ["romance"], gender: "man", interested_in: ["woman"], age_min: 25, age_max: 40, romance_ideal_match: "Someone curious and kind", is_active: false };
  const { $, set, event, state } = await setup(t, { initialProfile: romance });
  await event("#edit-profile");
  set("intents", ["business_partners"]);
  await event('[name="intents"]', "change");
  await event("#profile-form", "submit");
  await event("#profile-form", "submit");
  assert.equal($('[data-preferences="romance"]').disabled, true);
  assert.equal($('[data-preferences="business_partners"]').disabled, false);
  set("business_about", "Building a community bookstore");
  set("business_skills", "Book buying and event planning");
  set("business_seeking", "Someone who enjoys running operations");
  set("business_linkedin_url", "https://untrusted.example/in/reader");
  await event("#profile-form", "submit");
  assert.equal(state.calls.length, 0, "an invalid LinkedIn URL cannot be saved");
  assert.match($("#form-error").textContent, /LinkedIn/);
  set("business_linkedin_url", "linkedin.com/in/reader/?trk=profile");
  await event("#profile-form", "submit");
  assert.equal($("#dashboard-view").hidden, false);
  const call = state.calls.at(-1);
  assert.equal(call.action, "update");
  assert.deepEqual(call.filter, ["user_id", member.id]);
  assert.equal(call.values.is_active, false);
  assert.equal(call.values.gender, null);
  assert.deepEqual(call.values.interested_in, []);
  assert.equal(call.values.friendship_interests, "");
  assert.equal(call.values.romance_ideal_match, "");
  assert.equal(call.values.business_linkedin_url, "https://www.linkedin.com/in/reader");
  assert.equal($("#profile-preferences a").href, "https://www.linkedin.com/in/reader");
  assert.ok(!("user_id" in call.values), "ownership is immutable");
});

test("romance sliders restore saved ages, cannot cross, and save the private open answer", async t => {
  const romance = { ...profile, intents: ["romance"], gender: "other", interested_in: ["woman", "other"], age_min: 25, age_max: 40 };
  const { $, set, event, state } = await setup(t, { initialProfile: romance });
  await event("#edit-profile");
  await event("#profile-form", "submit");
  await event("#profile-form", "submit");
  assert.deepEqual([...$('#gender').options].map(option => option.value), ["", "woman", "man", "other"]);
  assert.deepEqual([...$("#profile-form").querySelectorAll('[name="interested_in"]')].map(input => input.value), ["woman", "man", "other"]);
  assert.equal($('[name="gender_description"]'), null);
  assert.equal($("#age-min").type, "range");
  assert.equal($("#age-max").type, "range");
  assert.equal($("#age-min").max, "80");
  assert.equal($("#age-max").max, "80");
  assert.equal($("#age-range-value").value, "25–40");
  set("age_min", 80);
  await event("#age-min", "input");
  assert.equal($("#age-range-value").value, "40–40");
  set("age_max", 30);
  await event("#age-max", "input");
  assert.equal($("#age-max").value, "40");
  set("age_max", 65); await event("#age-max", "input");
  set("age_min", 28); await event("#age-min", "input");
  assert.equal($("#age-min").getAttribute("aria-valuemax"), "65");
  assert.equal($("#age-max").getAttribute("aria-valuemin"), "28");
  set("age_max", 80); await event("#age-max", "input");
  assert.equal($("#age-range-value").value, "28–80+");
  assert.equal($("#age-max").getAttribute("aria-valuetext"), "80 years and over");
  set("age_min", 80); await event("#age-min", "input");
  assert.equal($("#age-range-value").value, "80+");
  set("age_min", 28); await event("#age-min", "input");
  const answer = 'Kind, curious, and loves <script>stories</script>.';
  set("romance_ideal_match", answer);
  await event("#profile-form", "submit");
  assert.equal(state.profile.age_min, 28);
  assert.equal(state.profile.age_max, 120, "80+ includes all older members");
  assert.equal(state.profile.romance_ideal_match, answer);
  assert.ok($("#profile-preferences").textContent.includes(answer));
  assert.equal($("#profile-preferences script"), null);
  await event("#edit-profile");
  assert.equal($("#age-range-value").value, "28–80+");
  assert.equal($("#age-max").value, "80");
  assert.equal($('[name="romance_ideal_match"]').value, answer);
});

test("business matches get safe LinkedIn links without exposing private ideal-match answers", async t => {
  const match = { week_start: "2026-10-19", intent: "business_partners", display_name: "Reader", age: 30, city: "Oakland", country: "United States", business_about: "A bookshop", business_skills: "Events", business_seeking: "An operator", romance_ideal_match: "A private preference" };
  const { $ } = await setup(t, { initialProfile: profile, matches: [
    { ...match, business_linkedin_url: "https://www.linkedin.com/in/reader" },
    { ...match, business_linkedin_url: "javascript:alert(1)" },
    { ...match, intent: "friends", business_linkedin_url: "https://www.linkedin.com/in/reader" },
  ] });
  const links = $("#matches-list").querySelectorAll("a");
  assert.equal(links.length, 1);
  assert.equal(links[0].href, "https://www.linkedin.com/in/reader");
  assert.equal(links[0].rel, "noopener noreferrer");
  assert.equal(links[0].target, "_blank");
  assert.ok(!$("#matches-list").textContent.includes("A private preference"));
});

test("settings roll back on failure and sign-out removes profile answers", async t => {
  const { $, set, event, state } = await setup(t, { initialProfile: profile });
  state.failNext = true;
  $("#email-preference").checked = true;
  await event("#email-preference", "change");
  assert.equal($("#email-preference").checked, false);
  assert.equal(state.profile.email_matches, false);
  await event("#pause-matching");
  assert.equal(state.profile.is_active, false);
  await event("#sign-out");
  assert.equal($("#welcome-view").hidden, false);
  assert.equal($("#account-tools").hidden, true);
  assert.equal($("#profile-name").textContent, "");
  assert.equal($("#account-email").textContent, "");
  assert.equal($('[name="city_id"]').value, "");
  assert.equal($('[name="favorite_book_id"]').value, "");
});

test("match content is rendered as text and no directory or private birthday is displayed", async t => {
  const { $ } = await setup(t, { initialProfile: profile, matches: [{ id: "match", week_start: "2026-10-19", intent: "friends", display_name: '<img src=x onerror="alert(1)">', age: 30, city: "Oakland", country: "United States", favorite_book: "<script>unsafe()</script>", favorite_author: "An author", book_reason: "A good story", reason: "Shared interests", friendship_interests: "Long walks" }] });
  assert.equal($("#matches-list img"), null);
  assert.equal($("#matches-list script"), null);
  assert.match($("#matches-list").textContent, /<img src=x/);
  assert.ok(!$("#matches-list").textContent.includes(profile.birth_date));
  assert.ok(!$("#matches-list").textContent.includes(member.email));
});

test("signed-out Google setup state is honest and sign-in has a fixed callback", async t => {
  const unavailable = await setup(t, { signedIn: false, googleEnabled: false });
  assert.equal(unavailable.$("#google-sign-in").disabled, true);
  assert.equal(unavailable.$("#sign-in-status").hidden, false);
  const { $, event, state } = await setup(t, { signedIn: false });
  await event('[data-intent="business_partners"]');
  assert.equal($('[data-intent="business_partners"]').getAttribute("aria-pressed"), "true");
  await event("#google-sign-in");
  assert.equal(state.oauth.provider, "google");
  assert.equal(state.oauth.options.redirectTo, "http://127.0.0.1:8080/matchmaking/");
  assert.match($("#notice").textContent, /couldn’t start Google/);
});

test("the dashboard renders the real count, city dots, and community book ranking", async t => {
  const { $ } = await setup(t, { initialProfile: profile });
  assert.equal($("#member-count").textContent, "1");
  assert.equal($("#map-markers").children.length, 1);
  assert.match($("#map-markers circle").getAttribute("aria-label"), /Oakland/);
  assert.match($("#top-books-list").textContent, /A book/);
  assert.match($("#top-books-list").textContent, /1 favorite/);
});

test("rising favorites recover after a community error, then clear on sign-out with map zoom", async t => {
  const { $, event, state } = await setup(t, { initialProfile: profile, communityError: true, risingBooks: [
    { work_id: "OL2W", title: "A rising book", author: "An author" },
  ] });
  assert.equal($("#rising-books-list").children.length, 0);
  assert.equal($("#rising-books-status").hidden, false);
  assert.match($("#rising-books-status").textContent, /temporarily unavailable/);
  state.communityError = false;
  await event("#top-books-status button");
  assert.match($("#rising-books-list").textContent, /A rising book/);
  assert.equal($("#rising-books-status").hidden, true);
  await event("#map-zoom-in");
  assert.match($("#map-content").getAttribute("transform"), /scale\(1.5\)/);
  await event("#sign-out");
  assert.equal($("#rising-books-list").children.length, 0);
  assert.match($("#map-content").getAttribute("transform"), /scale\(1\)/);
});

test("books stay locked for 24 hours while other profile details remain editable", async t => {
  const { $, set, event, state } = await setup(t, { initialProfile: { ...profile, books_updated_at: new Date().toISOString() } });
  await event("#edit-profile");
  set("display_name", "A new name");
  await event("#profile-form", "submit");
  assert.equal($('[data-step="1"]').hidden, false);
  assert.equal($('[data-step="1"]').disabled, false);
  assert.equal($('#favorite-book-fields').disabled, true);
  assert.equal($("#books-lock-note").hidden, false);
  await event("#profile-form", "submit");
  await event("#profile-form", "submit");
  assert.equal(state.profile.display_name, "A new name");
  assert.equal(state.profile.favorite_book_id, "OL1W");
});

test("opening the editor and navigating steps returns to the start of the form", async t => {
  const { window, event } = await setup(t, { initialProfile: profile });
  window.scrollTo(0, 900);
  await event("#edit-profile");
  assert.equal(window.scrollY, 0, "editing from a scrolled dashboard reveals the connection choices");
  window.scrollTo(0, 600);
  await event("#profile-form", "submit");
  assert.equal(window.scrollY, 0);
  window.scrollTo(0, 600);
  await event("#previous-step");
  assert.equal(window.scrollY, 0);
});
