import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { createMatchmakingApp } from "../src/ui.js";
import { makeProfile } from "../src/profile.js";
import { COMMUNITY_CACHE_KEY } from "../src/community-cache.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const member = { id: "00000000-0000-4000-8000-000000000001", email: "reader@example.invalid", user_metadata: { given_name: "Reader" } };
const profile = { ...makeProfile({ display_name: "Reader", instagram_handle: "reader.books", birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States", intent: "friends", favorite_book_id: "OL1W", favorite_book: "A book", favorite_author: "An author", location_preference: "same_city", friendship_interests: "Afternoons in bookshops" }), user_id: member.id };

function mockClient({ signedIn = true, initialProfile = null, matches = [], risingBooks = [], communityError = false, matchesError = false } = {}) {
  const state = { profile: initialProfile ? structuredClone(initialProfile) : null, calls: [], tables: [], requests: [], functionCalls: [], rpcCalls: [], failNext: false, matches: matches.map((match, i) => ({ id: `match-${i}`, ...match })), communityError, matchesError, session: signedIn ? { user: member } : null };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      onAuthStateChange: callback => { state.onAuth = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithOAuth: async options => { state.oauth = options; return { data: null, error: new Error("Provider unavailable") }; },
      signOut: async () => { state.session = null; state.onAuth("SIGNED_OUT", null); return { error: null }; },
    },
    from(table) {
      state.tables.push(table);
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
    rpc: async (name, args) => {
      state.rpcCalls.push({ name, args });
      if (name === "suggest_matchmaking_friends") return { data: true, error: null };
      if (name === "get_my_matchmaking_introductions") {
        if (state.matchesError) return { data: null, error: new Error("Matches unavailable") };
        const start = args.p_before_id ? state.matches.findIndex(match => match.id === args.p_before_id) + 1 : 0;
        const items = state.matches.slice(start, start + args.p_limit);
        return { data: { items: structuredClone(items), total_count: state.matches.length,
          next_cursor: start + items.length < state.matches.length ? { id: items.at(-1).id, released_at: "2026-10-26T00:00:00Z" } : null }, error: null };
      }
      if (name === "reveal_matchmaking_match") {
        const match = state.matches.find(match => match.id === args.p_match_id);
        if (match) match.revealed_at ||= new Date().toISOString();
        return { data: match?.revealed_at, error: null };
      }
      return ({ data: name === "get_matchmaking_community" ? { total_members: 1, cities: [{ id: 5378538, name: "Oakland", region: "California", country: "United States", latitude: 37.8, longitude: -122.27, member_count: 1 }], countries: [{ country: "United States", member_count: 1, top_book: { work_id: "OL1W", title: "A book", author: "An author", votes: 1 } }], top_books: [{ work_id: "OL1W", title: "A book", author: "An author", votes: 1 }], rising_books: risingBooks } : state.matches, error: name === "get_matchmaking_community" && state.communityError ? new Error("Unavailable") : null });
    },
    functions: { invoke: async name => { state.functionCalls.push(name); return { data: { deleted: true }, error: null }; } },
  };
  return { client, state };
}

async function setup(t, options = {}) {
  const window = new Window({ url: options.url || "http://127.0.0.1:8080/matchmaking/", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false } });
  window.document.write(html);
  for (const [key, value] of Object.entries(options.stored || {})) window.localStorage.setItem(key, value);
  if (options.intent) window.localStorage.setItem("zebra-matchmaking-intent", options.intent);
  if (options.intents) window.localStorage.setItem("zebra-matchmaking-intents", JSON.stringify(options.intents));
  const mock = mockClient(options);
  const app = createMatchmakingApp({ ...mock, document: window.document, window, fetch: async url => {
    mock.state.requests.push(url);
    if (url.startsWith("/matchmaking/data/books.")) {
      if (options.catalogUnavailable) throw new Error("Offline");
      return { ok: true, json: async () => ({ version: 1, books: [["OL4W", "A current read", "Current author"], ["OL1W", "A favorite", "Favorite author"]] }) };
    }
    if (url.startsWith("/matchmaking/data/cities.")) return { ok: true, json: async () => ({ version: 1, cities: [[2964574, "Dublin", "dublin", "Leinster", "Ireland", 1024027]] }) };
    if (options.manifests?.[url]) return { ok: true, text: async () => options.manifests[url] };
    return { ok: true, text: async () => "", json: async () => ({ external: { google: options.googleEnabled ?? true } }) };
  } });
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

test("a new member can finish all three steps with one book and no Instagram", async t => {
  const { $, set, event, state } = await setup(t, { intent: "friends" });
  assert.equal($("#onboarding-view").hidden, false);
  assert.equal($('[name="intents"][value="friends"]').checked, true);
  assert.equal($('[name="display_name"]').value, "Reader");
  assert.equal($('[name="instagram_handle"]').required, false);
  assert.match($("#instagram-help").textContent, /only be able to contact your matches by email/);
  for (const [key, value] of Object.entries({ birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States" })) set(key, value);
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
  assert.equal(state.profile.instagram_handle, null);
  assert.equal($("#instagram-dialog").open, false, "skipping Instagram at signup does not immediately prompt again");
  assert.equal($("#participation-description").textContent, "Active");
  assert.equal(state.profile.share_email_with_matches, true);
  assert.equal(state.calls.at(-1).action, "insert");
});

test("signup still validates Instagram when supplied on the first step", async t => {
  const { $, set, event, state } = await setup(t, { intent: "friends" });
  for (const [key, value] of Object.entries({ birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States" })) set(key, value);
  assert.equal($('[name="instagram_handle"]').required, false);
  assert.equal($("#instagram-dialog").open, false);
  for (const value of ["two words", "https://evil.test/reader"]) {
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
  assert.match($("#instagram-description").textContent, /only be able to contact your matches by email/);
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

test("members can remove or update Instagram without losing matching eligibility", async t => {
  const { $, set, event, state } = await setup(t, { initialProfile: profile });
  await event("#edit-profile");
  assert.equal($('[name="instagram_handle"]').required, false);
  set("instagram_handle", "");
  for (let i = 0; i < 3; i++) await event("#profile-form", "submit");
  assert.equal(state.profile.instagram_handle, null);
  assert.equal($("#profile-instagram a"), null);
  assert.equal($("#instagram-dialog").open, false);
  assert.equal($("#participation-description").textContent, "Active");
  await event("#edit-profile");
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
  const { $, event } = await setup(t, { initialProfile: profile, matches: [
    ...["romance", "friends", "business_partners"].map(intent => ({ ...match, intent, instagram_handle: "other.reader" })),
    { ...match, intent: "friends", instagram_handle: "javascript:alert(1)" },
  ] });
  assert.equal($("#matches-list a"), null, "contact is hidden until opening a card");
  for (let i = 0; i < 4; i++) {
    await event(`.match-reveal-card:nth-child(${i + 1})`);
    const contact = $("#reveal-contact a");
    if (i < 3) {
      assert.equal(contact.href, "https://www.instagram.com/other.reader/");
      assert.equal(contact.target, "_blank"); assert.equal(contact.rel, "noopener noreferrer");
    } else assert.equal(contact, null);
    assert.ok(!$("#reveal-contact").textContent.includes("javascript:"));
    await event(".reveal-close");
  }
});

test("signup uses the shared book search for an optional current read and preserves it after a failed save", async t => {
  const { $, set, event, state, window } = await setup(t, { intent: "friends" });
  for (const [key, value] of Object.entries({ instagram_handle: "reader.books", birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States", favorite_book_id: "OL1W", favorite_book: "A favorite", favorite_author: "Favorite author" })) set(key, value);
  await event("#profile-form", "submit");
  set("current_book", "A current"); await event('[name="current_book"]', "input");
  await new Promise(resolve => window.setTimeout(resolve, 500));
  assert.equal(state.requests.filter(url => url.startsWith("/matchmaking/data/books.")).length, 1);
  assert.deepEqual(state.functionCalls, [], "suggestions use no Edge Functions");
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
    const { $, set, event, state, window } = await setup(t, { intent: "friends", catalogUnavailable: unavailable });
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

test("profile editing searches both static catalogs without database/Edge calls or per-keystroke downloads", async t => {
  const { $, set, event, state, client, window } = await setup(t, { initialProfile: profile });
  assert.deepEqual(state.functionCalls, [], "an uncurated dashboard cover does not invoke a lookup");
  assert.equal(state.requests.filter(url => url.startsWith("/matchmaking/data/")).length, 0, "dashboard visitors need no autocomplete catalogs");
  const rpcCalls = [];
  const originalRPC = client.rpc;
  client.rpc = (name, args) => { rpcCalls.push(name); return originalRPC(name, args); };
  await event("#edit-profile");
  await event('[name="city"]', "focus");
  for (const query of ["Du", "Dublin Ireland"]) {
    set("city", query); await event('[name="city"]', "input");
    await new Promise(resolve => window.setTimeout(resolve, 200));
  }
  await event("#city-suggestions-0");
  assert.equal($('[name="city_id"]').value, "2964574");
  assert.equal($('[name="country"]').value, "Ireland");
  await event("#profile-form", "submit");
  for (const [name, query, id] of [["favorite_book", "A fav", "OL1W"], ["current_book", "A current", "OL4W"]]) {
    await event(`[name="${name}"]`, "focus");
    set(name, query); await event(`[name="${name}"]`, "input");
    await new Promise(resolve => window.setTimeout(resolve, 200));
    await event(`#${name}-suggestions-0`);
    assert.equal($(`[name="${name}_id"]`).value, id);
  }
  for (const name of ["favorite_book_2", "favorite_book_3"]) await event(`[name="${name}"]`, "focus");
  assert.deepEqual(rpcCalls, []);
  assert.deepEqual(state.functionCalls, []);
  assert.equal(state.requests.filter(url => url.startsWith("/matchmaking/data/books.")).length, 1);
  assert.equal(state.requests.filter(url => url.startsWith("/matchmaking/data/cities.")).length, 1);
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
  const { $, event } = await setup(t, { initialProfile: { ...profile, current_book_id: "OL4W", current_book: title, current_author: "An author" }, matches: [{ ...profile, age: 32, intent: "friends", week_start: "2026-10-19", reason: "Shared interests", current_book: title, current_author: "An author" }] });
  assert.equal($("#profile-current-reading img"), null);
  assert.ok($("#profile-current-reading").textContent.includes(title));
  assert.equal($("#matches-list img"), null);
  await event(".match-reveal-card");
  assert.equal($("#reveal-content img"), null);
  assert.ok($("#reveal-content").textContent.includes(`Currently reading${title} · An author`));
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
  const { $, event } = await setup(t, { initialProfile: profile, matches: [
    { ...match, business_linkedin_url: "https://www.linkedin.com/in/reader" },
    { ...match, business_linkedin_url: "javascript:alert(1)" },
    { ...match, intent: "friends", business_linkedin_url: "https://www.linkedin.com/in/reader" },
  ] });
  for (let i = 0; i < 3; i++) {
    await event(`.match-reveal-card:nth-child(${i + 1})`);
    const linkedin = $("#reveal-content .reveal-linkedin");
    if (i === 0) {
      assert.equal(linkedin.href, "https://www.linkedin.com/in/reader");
      assert.equal(linkedin.rel, "noopener noreferrer"); assert.equal(linkedin.target, "_blank");
    } else assert.equal(linkedin, null);
    assert.ok(!$("#reveal-content").textContent.includes("A private preference"));
    await event(".reveal-close");
  }
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
  $("#profile-more").open = true;
  await event("#sign-out");
  assert.equal($("#profile-more").open, false);
  assert.equal($("#profile-more-label").textContent, "View more");
  assert.ok($("#profile-more #profile-book"), "sign-out preserves the reusable details structure");
  assert.equal($("#profile-book").textContent, "");
  assert.equal($("#welcome-view").hidden, false);
  assert.equal($("#account-tools").hidden, true);
  assert.equal($("#profile-name").textContent, "");
  assert.equal($("#account-email").textContent, "");
  assert.equal($('[name="city_id"]').value, "");
  assert.equal($('[name="favorite_book_id"]').value, "");
});

test("match content is rendered as text and no directory or private birthday is displayed", async t => {
  const { $, event } = await setup(t, { initialProfile: profile, matches: [{ id: "match", week_start: "2026-10-19", intent: "friends", display_name: '<img src=x onerror="alert(1)">', age: 30, city: "Oakland", country: "United States", favorite_book: "<script>unsafe()</script>", favorite_author: "An author", book_reason: "A good story", reason: "Shared interests", friendship_interests: "Long walks" }] });
  assert.equal($("#matches-list img"), null);
  assert.equal($("#matches-list script"), null);
  assert.ok(!$("#matches-list").textContent.includes("<img src=x"));
  await event(".match-reveal-card");
  assert.match($("#reveal-content").textContent, /<img src=x/);
  assert.equal($("#reveal-content img"), null);
  assert.equal($("#reveal-content script"), null);
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
  const { $, event, state } = await setup(t, { initialProfile: profile });
  assert.equal($("#member-count").textContent, "1");
  assert.equal($("#map-markers").children.length, 1);
  assert.match($("#map-markers circle").getAttribute("aria-label"), /Oakland/);
  assert.match($("#top-books-list").textContent, /A book/);
  assert.match($("#top-books-list").textContent, /1 favorite/);
  const calls = state.rpcCalls.length;
  await event('[data-country="United States"]', "mouseenter");
  assert.equal($("#map-selection").textContent, "United States · 1 reader");
  await event(".map-marker", "mouseenter");
  assert.match($("#map-selection").textContent, /Oakland.*1 reader/);
  assert.equal(state.rpcCalls.length, calls, "hover does not fetch from Supabase");
  await event("#sign-out");
  assert.equal($("#map-countries").children.length, 0);
});

test("signed-in visits skip provider requests and reuse only aggregates while profiles and matches stay fresh", async t => {
  const first = await setup(t, { initialProfile: profile });
  assert.equal(first.state.requests.filter(url => url.endsWith("/auth/v1/settings")).length, 0);
  const cached = first.window.localStorage.getItem(COMMUNITY_CACHE_KEY);
  const next = await setup(t, { initialProfile: profile, stored: { [COMMUNITY_CACHE_KEY]: cached } });
  assert.equal(next.state.rpcCalls.filter(call => call.name === "get_matchmaking_community").length, 0);
  assert.equal(next.state.rpcCalls.filter(call => call.name === "get_my_matchmaking_introductions").length, 1);
  assert.equal(next.state.tables.filter(table => table === "matchmaking_profiles").length, 1);
  assert.equal(next.$("#member-count").textContent, "1");
  await next.event("#sign-out");
  assert.equal(next.window.localStorage.getItem(COMMUNITY_CACHE_KEY), null);
  assert.equal(next.state.requests.filter(url => url.endsWith("/auth/v1/settings")).length, 1);
  assert.equal(next.$("#google-sign-in").disabled, false);
});

test("profile edits preserve the community cache unless city or favorites changed", async t => {
  const { state, set, event } = await setup(t, { initialProfile: profile });
  const count = () => state.rpcCalls.filter(call => call.name === "get_matchmaking_community").length;
  assert.equal(count(), 1);
  await event("#edit-profile"); set("display_name", "Changed name");
  for (let i = 0; i < 3; i++) await event("#profile-form", "submit");
  assert.equal(count(), 1);
  await event("#edit-profile"); set("city_id", 2964574); set("city", "Dublin"); set("country", "Ireland");
  for (let i = 0; i < 3; i++) await event("#profile-form", "submit");
  assert.equal(count(), 2, "a changed city refreshes counts immediately");
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

const introduction = {
  id: "first-match", week_start: "2026-10-26", intent: "friends", display_name: "A new reader", age: 29,
  city: "Oakland", region: "California", country: "United States", reason: "A shared love of books", friendship_interests: "Bookshop afternoons",
  favorite_book_id: "OL1W", favorite_book: "A book", favorite_author: "An author", instagram_handle: "new.reader",
  recommended_book: { work_id: "OL3W", title: "Our next read", author: "Another author", reason: "Something to discover together" },
};

test("an unrevealed card opens the shared read, saves once, and becomes a persistent personal card", async t => {
  const { $, event, state } = await setup(t, { initialProfile: profile, matches: [introduction] });
  assert.equal($(".match-reveal-card").textContent, "FriendClick to reveal");
  assert.ok(!$("#matches-list").textContent.includes(introduction.display_name));
  await event(".match-reveal-card");
  assert.equal($("#match-reveal-dialog").open, true);
  assert.equal($(".reveal-shared").textContent, "A shared favorite");
  assert.match($(".reveal-recommendation").textContent, /Read together nextRecommended by Zebra Book ClubOur next read/);
  assert.match($(".match-reveal-card").textContent, /A new reader, 29Oakland, California, United StatesOur next read/);
  assert.ok(!$(".match-reveal-card").textContent.includes("Click to reveal"));
  assert.ok(!$(".match-reveal-card").textContent.includes("Friend"));
  await event(".reveal-close"); await event(".match-reveal-card");
  assert.equal(state.rpcCalls.filter(call => call.name === "reveal_matchmaking_match").length, 1);
  const reloaded = await setup(t, { initialProfile: profile, matches: state.matches });
  assert.equal(reloaded.$(".match-reveal-card").classList.contains("has-revealed"), true);
  assert.ok(!reloaded.$(".match-reveal-card").textContent.includes("Click to reveal"));
});

test("email fallback uses an authorized address and Instagram always takes priority", async t => {
  const { $, event } = await setup(t, { initialProfile: profile, matches: [
    { ...introduction, id: "both", contact_email: "reader@example.invalid" },
    { ...introduction, id: "email", instagram_handle: null, contact_email: "reader+books@example.invalid" },
    { ...introduction, id: "unsafe", instagram_handle: null, contact_email: "reader@example.invalid?bcc=private@example.invalid" },
  ] });
  await event('.match-reveal-card[data-match-id="both"]');
  assert.equal($("#reveal-contact a").href, "https://www.instagram.com/new.reader/");
  assert.ok(!$("#reveal-contact").textContent.includes("reader@example.invalid"));
  await event(".reveal-close");
  await event('.match-reveal-card[data-match-id="email"]');
  assert.equal($("#reveal-contact a").textContent, "Send them an email!");
  assert.equal($("#reveal-contact a").getAttribute("href"), "mailto:reader%2Bbooks@example.invalid");
  await event(".reveal-close");
  await event('.match-reveal-card[data-match-id="unsafe"]');
  assert.equal($("#reveal-contact a"), null);
  assert.match($("#reveal-contact").textContent, /haven’t shared contact details/);
});

test("reveal failures offer retry without pretending the server saved it", async t => {
  const { $, event, client } = await setup(t, { initialProfile: profile, matches: [introduction] });
  const original = client.rpc; let fail = true;
  client.rpc = async (name, args) => name === "reveal_matchmaking_match" && fail
    ? { data: null, error: new Error("Offline") } : original(name, args);
  await event(".match-reveal-card");
  assert.equal($("#match-reveal-dialog").open, true);
  assert.match($("#reveal-status").textContent, /couldn’t save its reveal/);
  assert.equal($(".match-reveal-card").textContent, "FriendClick to reveal");
  fail = false; await event("#reveal-status button");
  assert.equal($("#reveal-status").textContent, "");
  assert.equal($(".match-reveal-card").classList.contains("has-revealed"), true);
});

test("older pages append to the carousel, preserve reveals, and stop after the last page", async t => {
  const { $, event, window } = await setup(t, { initialProfile: profile, matches: Array.from({ length: 65 }, (_, i) => ({ ...introduction, id: `history-${i}` })) });
  assert.equal(window.document.querySelectorAll(".match-reveal-card").length, 24);
  await event(".match-reveal-card"); await event(".reveal-close");
  await event(".reveal-load-older");
  assert.equal(window.document.querySelectorAll(".match-reveal-card").length, 48);
  assert.equal($(".match-reveal-card").classList.contains("has-revealed"), true);
  await event(".reveal-load-older");
  assert.equal(window.document.querySelectorAll(".match-reveal-card").length, 65);
  assert.equal($(".reveal-load-older").hidden, true);
  assert.match($(".reveal-carousel-range").textContent, /of 65/);
});

test("sign-out clears the open introduction and a late reveal cannot restore it", async t => {
  const { $, event, client, window, app } = await setup(t, { initialProfile: profile, matches: [introduction] });
  const original = client.rpc; let finish;
  client.rpc = (name, args) => name === "reveal_matchmaking_match" ? new Promise(resolve => { finish = resolve; }) : original(name, args);
  $(".match-reveal-card").dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal($("#match-reveal-dialog").open, true);
  const signingOut = event("#sign-out");
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal($("#match-reveal-dialog").open, false);
  assert.equal($("#reveal-content").textContent, "");
  assert.equal($("#reveal-contact").textContent, "");
  finish({ data: new Date().toISOString(), error: null }); await signingOut; await app.settled();
  assert.equal($("#matches-list").textContent, "");
  assert.equal($("#reveal-content").textContent, "");
  assert.equal(window.document.body.style.overflow, "");
  assert.deepEqual(Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)).sort(),
    ["zbc.google-provider.v1", "zebra-matchmaking-intents"], "only non-personal welcome preferences remain");
});

test("members without matches retain the original empty state without carousel controls", async t => {
  const { $ } = await setup(t, { initialProfile: profile });
  assert.equal($(".empty-matches h3").textContent, "Your next chapter is still being written.");
  assert.equal($(".empty-matches p").textContent, "Weekly introductions are coming soon. When you have a match, you’ll find them here.");
  assert.equal($(".reveal-carousel-controls"), null);
  assert.equal($("#match-reveal-dialog").open, false);
  assert.equal($("#match-notice-dialog").open, false);
});

test("successful released-match loads notify once and token refreshes neither reload nor re-notify", async t => {
  const { $, state, window } = await setup(t, { initialProfile: profile, matches: [{ ...introduction, released_at: "2026-01-01T00:00:00Z" }] });
  assert.equal($("#match-notice-dialog").open, true);
  $("#match-notice-close").click();
  const requests = state.rpcCalls.length;
  state.onAuth("TOKEN_REFRESHED", state.session);
  state.onAuth("SIGNED_IN", state.session);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state.rpcCalls.length, requests);
  assert.equal($("#match-notice-dialog").open, false);
  assert.equal(state.rpcCalls.some(call => call.name === "reveal_matchmaking_match"), false, "the notice does not reveal a card or write to the backend");
  assert.ok(window.localStorage.getItem(`zebra-match-notice:v1:${member.id}`));
});

test("failed match fetches stay quiet; successful retry waits for the existing Instagram dialog", async t => {
  const { $, state, event } = await setup(t, { initialProfile: { ...profile, instagram_handle: null }, matchesError: true,
    matches: [{ ...introduction, released_at: "2026-01-01T00:00:00Z" }] });
  assert.equal($("#instagram-dialog").open, true);
  assert.equal($("#match-notice-dialog").open, false);
  state.matchesError = false; await event("#matches-list button");
  assert.equal($("#match-notice-dialog").open, false);
  await event("#instagram-later");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal($("#match-notice-dialog").open, true);
});

test("sign-out closes the notice and another signed-in account has its own release marker", async t => {
  const { $, state, event, window } = await setup(t, { initialProfile: profile,
    matches: [{ ...introduction, released_at: "2026-01-01T00:00:00Z" }] });
  assert.equal($("#match-notice-dialog").open, true);
  await event("#sign-out"); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal($("#match-notice-dialog").open, false);
  const other = { ...member, id: "00000000-0000-4000-8000-000000000002" };
  state.profile = { ...profile, user_id: other.id };
  state.session = { user: other }; state.onAuth("SIGNED_IN", state.session);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal($("#match-notice-dialog").open, true);
  assert.ok(window.localStorage.getItem(`zebra-match-notice:v1:${other.id}`));
});

test("shared recommendations reuse the real review affiliate URL and static cover", async t => {
  const files = ["reviews.csv", "book_club_current.csv", "assets/review-covers/sources.csv", "matchmaking/books.csv"];
  const manifests = Object.fromEntries(await Promise.all(files.map(async file => [`/${file}`, await readFile(new URL(`../../${file}`, import.meta.url), "utf8")])));
  const { $, event, state } = await setup(t, { initialProfile: profile, manifests, matches: [{ ...introduction,
    recommended_book: { work_id: "OL24593432W", title: "Dungeon Crawler Carl", author: "Matt Dinniman", reason: "A new adventure" } }] });
  await event(".match-reveal-card");
  const link = $(".reveal-book-link");
  assert.equal(link.href, "https://amzn.to/4hIrXe9");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "sponsored noopener noreferrer");
  assert.equal($(".reveal-recommended-book img").getAttribute("src"), "/assets/review-covers/review-54.jpg");
  assert.deepEqual([...new Set(state.tables)], ["matchmaking_profiles"], "recommendations never query Supabase books or cover tables");
  assert.equal(state.functionCalls.length, 0);
});

test("uncatalogued shared recommendations use a normal safely encoded Amazon search", async t => {
  const book = { work_id: "OL99999999W", title: 'An unknown <book> & title', author: 'Author / Name' };
  const { $, event } = await setup(t, { initialProfile: profile, matches: [{ ...introduction, recommended_book: book }] });
  await event(".match-reveal-card");
  const link = $(".reveal-book-link"), url = new URL(link.href);
  assert.equal(url.origin, "https://www.amazon.com");
  assert.equal(url.pathname, "/s");
  assert.equal(url.searchParams.get("k"), `${book.title} ${book.author}`);
  assert.equal(url.searchParams.has("tag"), false);
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(link.textContent, book.title);
  assert.equal($(".reveal-recommended-book img"), null);
});

test("email contact defaults on while explicit opt-outs survive edits and later logins", async t => {
  const { $, event, state } = await setup(t, { initialProfile: profile });
  assert.equal($("#share-contact-email").checked, true);
  $("#share-contact-email").checked = false; await event("#share-contact-email", "change");
  assert.equal(state.profile.share_email_with_matches, false);
  assert.equal(state.profile.email_matches, false);
  await event("#edit-profile");
  assert.equal($('[name="share_email_with_matches"]').checked, false);
  assert.equal($('[name="share_email_with_matches"]').required, false);
  for (let i = 0; i < 3; i++) await event("#profile-form", "submit");
  assert.equal(state.profile.share_email_with_matches, false);
  assert.equal($("#share-contact-email").checked, false);
  const reloaded = await setup(t, { initialProfile: state.profile });
  assert.equal(reloaded.$("#share-contact-email").checked, false);
  state.failNext = true;
  $("#share-contact-email").checked = true; await event("#share-contact-email", "change");
  assert.equal($("#share-contact-email").checked, false, "a failed save restores the saved choice");
});

test("members can submit a romance suggestion using two normalized Instagram handles", async t => {
  const { $, event, state } = await setup(t, { initialProfile: profile });
  assert.equal($("#matchmake-friends").hidden, false);
  await event("#matchmake-friends");
  assert.equal($("#friend-match-dialog").open, true);
  assert.match($("#friend-match-form").textContent, /romantic match/);
  $("#friend-instagram-first").value = "https://www.instagram.com/First.Friend/?igsh=tracking";
  $("#friend-instagram-second").value = " @Second.Friend ";
  await event("#friend-match-form", "submit");
  const sent = state.rpcCalls.filter(call => call.name === "suggest_matchmaking_friends");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args, { p_first_instagram: "first.friend", p_second_instagram: "second.friend" });
  assert.equal($("#friend-match-form").hidden, true);
  assert.equal($("#friend-match-success").hidden, false);
  assert.match($("#friend-match-success").textContent, /If they both have accounts, we’ll see what we can do/);
  assert.equal($("#friend-instagram-first").value, "");
  await event("#friend-match-done"); await event("#matchmake-friends");
  assert.equal($("#friend-match-form").hidden, false);
  assert.equal($("#friend-match-success").hidden, true);
  assert.equal($("#friend-instagram-second").value, "");
});

test("friend suggestions validate both handles, reject duplicates, and retain answers for retry", async t => {
  const { $, event, state, client } = await setup(t, { initialProfile: profile });
  await event("#matchmake-friends"); await event("#friend-match-form", "submit");
  assert.match($("#friend-match-error").textContent, /valid Instagram/);
  $("#friend-instagram-first").value = "@same.friend"; $("#friend-instagram-second").value = "SAME.FRIEND";
  await event("#friend-match-form", "submit");
  assert.match($("#friend-match-error").textContent, /two different/);
  assert.equal(state.rpcCalls.filter(call => call.name === "suggest_matchmaking_friends").length, 0);
  $("#friend-instagram-second").value = "other.friend";
  const original = client.rpc;
  client.rpc = async (name, args) => name === "suggest_matchmaking_friends" ? { data: null, error: { message: "FRIEND_SUGGESTION_LIMIT" } } : original(name, args);
  await event("#friend-match-form", "submit");
  assert.match($("#friend-match-error").textContent, /five matches in 24 hours/);
  assert.equal($("#friend-instagram-first").value, "@same.friend");
  assert.equal($("#friend-match-success").hidden, true);
  client.rpc = original; await event("#friend-match-form", "submit");
  assert.equal($("#friend-match-success").hidden, false);
});

test("friend suggestions require a member profile and stale submissions cannot reopen after sign-out", async t => {
  const visitor = await setup(t, { signedIn: false });
  assert.equal(visitor.$("#matchmake-friends").hidden, true);
  const onboarding = await setup(t);
  assert.equal(onboarding.$("#matchmake-friends").hidden, true);
  const { $, event, client, window, app } = await setup(t, { initialProfile: profile });
  const original = client.rpc; let finish;
  client.rpc = (name, args) => name === "suggest_matchmaking_friends" ? new Promise(resolve => { finish = resolve; }) : original(name, args);
  await event("#matchmake-friends");
  $("#friend-instagram-first").value = "first.friend"; $("#friend-instagram-second").value = "second.friend";
  $("#friend-match-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal($("#submit-friend-match").disabled, true);
  const signingOut = event("#sign-out");
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal($("#friend-match-dialog").open, false);
  assert.equal($("#friend-instagram-first").value, "");
  assert.equal($("#matchmake-friends").hidden, true);
  finish({ data: true, error: null }); await signingOut; await app.settled();
  assert.equal($("#friend-match-success").hidden, true);
  assert.equal(window.document.body.style.overflow, "");
});

test("new referrals prefill the inviter, not the new reader's Instagram, and only submit on creation", async t => {
  const { $, set, event, state } = await setup(t, { intent: 'friends', url: 'http://127.0.0.1:8080/matchmaking/?ref=Some.Friend' });
  assert.equal($('[name="referred_by_instagram"]').value, 'some.friend');
  assert.equal($('[name="instagram_handle"]').value, '');
  for (const [key, value] of Object.entries({ birth_date: '1994-06-15', city_id: 5378538, city: 'Oakland', country: 'United States' })) set(key, value);
  await event('#profile-form', 'submit');
  set('favorite_book_id', 'OL1W'); set('favorite_book', 'A book'); set('favorite_author', 'An author');
  await event('#profile-form', 'submit');
  set('friendship_interests', 'Afternoons in bookshops'); set('profile_consent', true);
  await event('#profile-form', 'submit');
  assert.equal(state.calls.at(-1).values.referred_by_instagram, 'some.friend');
  assert.equal(state.profile.instagram_handle, null);
  await event('#edit-profile'); assert.equal($('#referral-field').hidden, true);
  await event('#profile-form', 'submit'); await event('#profile-form', 'submit'); await event('#profile-form', 'submit');
  assert.equal(Object.hasOwn(state.calls.at(-1).values, 'referred_by_instagram'), false);
});


test("the compact raffle popup saves an optional preference and keeps only Invite friends below the pieces", async t => {
  const { $, state, event, window } = await setup(t, { initialProfile: profile });
  const callsBefore = state.tables.length;
  await event('[data-invite-friends]');
  assert.equal($('#invite-dialog').open, true);
  assert.equal(state.tables.length, callsBefore, 'opening invites adds no lookup');
  assert.match($('#invite-title').textContent, /Get a chance to win merch\./);
  assert.equal($('.raffle-choices legend').textContent, 'Do you have a preferred piece?');
  assert.equal($('.raffle-choices').nextElementSibling.id, 'share-invite-link');
  assert.equal($('#invite-form').lastElementChild.id, 'share-invite-link');
  for (const selector of ['#invite-instagram', '#invite-url', '#copy-invite-link', '#save-invite-choice', '.invite-footnote', '#invite-dialog .eyebrow']) assert.equal($(selector), null);
  await event('[data-raffle-prize="hoodie"]');
  assert.deepEqual(state.calls.at(-1).values, { merch_raffle_prize: 'hoodie' });
  assert.equal($('[data-raffle-prize="hoodie"]').getAttribute('aria-pressed'), 'true');
  let copied, shared;
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
  await event('#invite-form', 'submit');
  assert.equal(copied, 'https://zebrabookclub.com/matchmaking/?ref=reader.books');
  assert.equal($('#invite-action-label').textContent, 'Link copied!');
  Object.defineProperty(window.navigator, 'share', { configurable: true, value: async data => { shared = data; } });
  await event('#invite-form', 'submit');
  assert.equal(shared.url, copied);
  assert.ok(!JSON.stringify(shared).includes(member.email));
  assert.equal(state.calls.length, 1, 'sharing adds no database request');
  await event('#sign-out');
  assert.equal($('#invite-dialog').open, false);
});

test("front and back previews keep the raffle preference without database requests", async t => {
  const { $, state, event } = await setup(t, { initialProfile: profile });
  await event('[data-invite-friends]');
  await event('[data-raffle-prize="hoodie"]');
  const callsBefore = state.calls.length;
  const tablesBefore = state.tables.length;
  await event('#invite-dialog [data-product-view="back"]');
  for (const piece of ['hoodie', 't_shirt', 'cap']) {
    const image = $(`[data-raffle-prize="${piece}"] img`);
    assert.equal(image.getAttribute('src'), image.dataset.backSrc);
    assert.equal(image.alt, image.dataset.backAlt);
  }
  assert.equal($('#invite-dialog [data-product-view="back"]').getAttribute('aria-pressed'), 'true');
  assert.equal($('#invite-dialog [data-product-view="front"]').getAttribute('aria-pressed'), 'false');
  assert.equal($('[data-raffle-prize="hoodie"]').getAttribute('aria-pressed'), 'true');
  assert.equal($('#invite-dialog').open, true);
  assert.equal(state.calls.length, callsBefore);
  assert.equal(state.tables.length, tablesBefore);
  await event('#invite-close');
  await event('[data-invite-friends]');
  const image = $('[data-raffle-prize="hoodie"] img');
  assert.equal(image.getAttribute('src'), image.dataset.frontSrc);
  assert.equal($('[data-raffle-prize="hoodie"]').getAttribute('aria-pressed'), 'true');
});

test("members can invite without a preferred piece and clear an existing preference", async t => {
  const { $, state, event, window } = await setup(t, { initialProfile: profile });
  let shared;
  Object.defineProperty(window.navigator, 'share', { configurable: true, value: async data => { shared = data; } });
  await event('[data-invite-friends]');
  await event('#invite-form', 'submit');
  assert.match(shared.url, /ref=reader.books$/); assert.equal(state.calls.length, 0);
  await event('[data-raffle-prize="cap"]');
  assert.equal(state.profile.merch_raffle_prize, 'cap');
  await event('[data-raffle-prize="cap"]');
  assert.equal(state.profile.merch_raffle_prize, null);
  assert.equal($('[data-raffle-prize="cap"]').getAttribute('aria-pressed'), 'false');
});

test("a failed preference save restores the saved selection and can be retried", async t => {
  const { $, state, event } = await setup(t, { initialProfile: { ...profile, merch_raffle_prize: 'hoodie' } });
  await event('[data-invite-friends]');
  state.failNext = true; await event('[data-raffle-prize="cap"]');
  assert.match($('#invite-error').textContent, /couldn’t save/);
  assert.equal($('[data-raffle-prize="hoodie"]').getAttribute('aria-pressed'), 'true');
  assert.equal($('[data-raffle-prize="cap"]').getAttribute('aria-pressed'), 'false');
  assert.equal($('#share-invite-link').disabled, false);
  await event('[data-raffle-prize="cap"]');
  assert.equal(state.profile.merch_raffle_prize, 'cap');
});

test("unsigned visitors keep an optional choice for Google sign-in without database writes", async t => {
  const { $, state, event, window } = await setup(t, { signedIn: false, url: 'http://127.0.0.1:8080/matchmaking/?raffle=t_shirt' });
  assert.equal($('#invite-dialog').open, true);
  assert.equal($('[data-raffle-prize="t_shirt"]').getAttribute('aria-pressed'), 'true');
  await event('#invite-form', 'submit');
  assert.equal($('#invite-dialog').open, false);
  assert.equal(window.document.activeElement.id, 'google-sign-in');
  assert.equal(state.calls.length, 0);
  assert.equal(JSON.parse(window.localStorage.getItem('zebra-referral-signup')).prize, 't_shirt');
});

test("a stale raffle save cannot restore information after sign-out", async t => {
  const { $, client, event, app, window } = await setup(t, { initialProfile: profile });
  await event('[data-invite-friends]');
  let complete;
  const from = client.from;
  client.from = table => { const query = from(table); query.single = () => new Promise(resolve => { complete = resolve; }); return query; };
  $('[data-raffle-prize="hoodie"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal($('#share-invite-link').disabled, true);
  await client.auth.signOut(); await new Promise(resolve => setTimeout(resolve, 10));
  complete({ data: { ...profile, merch_raffle_prize: 'hoodie' }, error: null }); await app.settled();
  assert.equal($('#invite-dialog').open, false); assert.equal($('#welcome-view').hidden, false);
  assert.equal($('[data-raffle-prize="hoodie"]').getAttribute('aria-pressed'), 'false');
});

test("choosing merch midway through signup or profile editing preserves the form", async t => {
  for (const existing of [null, profile]) {
    const { $, set, event, state } = await setup(t, { intent: 'friends', initialProfile: existing });
    if (existing) await event('#edit-profile');
    set('display_name', 'Draft name'); set('instagram_handle', 'draft.handle');
    await event('[data-invite-friends]'); await event('[data-raffle-prize="cap"]');
    if (existing) await event('#invite-close'); else await event('#invite-form', 'submit');
    assert.equal($('#invite-dialog').open, false); assert.equal($('#onboarding-view').hidden, false);
    assert.equal($('[name="display_name"]').value, 'Draft name');
    assert.equal($('[name="instagram_handle"]').value, 'draft.handle');
    assert.equal(state.calls.length, existing ? 1 : 0);
  }
});

test("members without Instagram use the existing separate prompt before returning to Invite friends", async t => {
  const { $, event, state, window } = await setup(t, { initialProfile: { ...profile, instagram_handle: null } });
  await event('#instagram-later');
  await event('[data-invite-friends]'); await event('[data-raffle-prize="cap"]');
  await event('#invite-form', 'submit');
  assert.equal($('#invite-dialog').open, false); assert.equal($('#instagram-dialog').open, true);
  $('#instagram-prompt-input').value = 'new.reader';
  await event('#instagram-form', 'submit');
  assert.equal($('#instagram-dialog').open, false); assert.equal($('#invite-dialog').open, true);
  assert.equal(state.profile.merch_raffle_prize, 'cap');
  let shared;
  Object.defineProperty(window.navigator, 'share', { configurable: true, value: async data => { shared = data; } });
  await event('#invite-form', 'submit'); assert.match(shared.url, /ref=new.reader$/);
});

test("manual copying remains available if native share and clipboard are blocked", async t => {
  const { window, event } = await setup(t, { initialProfile: profile });
  let fallback;
  Object.defineProperty(window.navigator, 'share', { configurable: true, value: async () => { throw new Error('Unavailable'); } });
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } });
  window.prompt = (message, url) => { fallback = url; return null; };
  await event('[data-invite-friends]'); await event('#invite-form', 'submit');
  assert.equal(fallback, 'https://zebrabookclub.com/matchmaking/?ref=reader.books');
});
