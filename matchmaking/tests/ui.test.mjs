import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { createMatchmakingApp } from "../src/ui.js";
import { makeProfile } from "../src/profile.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const member = { id: "00000000-0000-4000-8000-000000000001", email: "reader@example.invalid", user_metadata: { given_name: "Reader" } };
const profile = { ...makeProfile({ display_name: "Reader", birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States", intent: "friends", favorite_book_id: "OL1W", favorite_book: "A book", favorite_author: "An author", location_preference: "same_city", friendship_interests: "Afternoons in bookshops" }), user_id: member.id };

function mockClient({ signedIn = true, initialProfile = null, matches = [] } = {}) {
  const state = { profile: initialProfile ? structuredClone(initialProfile) : null, calls: [], failNext: false, matches, session: signedIn ? { user: member } : null };
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
          if (state.failNext) { state.failNext = false; return { data: null, error: new Error("Network failure") }; }
          state.profile = { ...state.profile, ...call.values, books_updated_at: new Date().toISOString() };
          return { data: structuredClone(state.profile), error: null };
        },
      };
      return query;
    },
    rpc: async name => ({ data: name === "get_matchmaking_community" ? { total_members: 1, cities: [{ id: 5378538, name: "Oakland", region: "California", country: "United States", latitude: 37.8, longitude: -122.27, member_count: 1 }], top_books: [{ work_id: "OL1W", title: "A book", author: "An author", votes: 1 }] } : state.matches, error: null }),
    functions: { invoke: async () => ({ data: { deleted: true }, error: null }) },
  };
  return { client, state };
}

async function setup(t, options = {}) {
  const window = new Window({ url: "http://127.0.0.1:8080/matchmaking/", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false } });
  window.document.write(html);
  if (options.intent) window.localStorage.setItem("zebra-matchmaking-intent", options.intent);
  const mock = mockClient(options);
  const app = createMatchmakingApp({ ...mock, document: window.document, window, fetch: async () => ({ ok: true, json: async () => ({ external: { google: options.googleEnabled ?? true } }) }) });
  await app.start();
  t.after(async () => { app.destroy(); await window.happyDOM.close(); });
  const $ = selector => window.document.querySelector(selector);
  const set = (name, value) => { const input = $(`[name="${name}"]`); if (input.type === "checkbox") input.checked = value; else input.value = value; };
  const event = async (selector, name = "click") => { $(selector).dispatchEvent(new window.Event(name, { bubbles: true, cancelable: true })); await app.settled(); };
  return { ...mock, app, window, $, set, event };
}

test("a new member can finish all three steps with one book and no explanation", async t => {
  const { $, set, event, state } = await setup(t, { intent: "friends" });
  assert.equal($("#onboarding-view").hidden, false);
  assert.equal($('[name="intent"]').value, "friends");
  assert.equal($('[name="display_name"]').value, "Reader");
  for (const [key, value] of Object.entries({ birth_date: "1994-06-15", city_id: 5378538, city: "Oakland", country: "United States" })) set(key, value);
  await event("#profile-form", "submit");
  assert.equal($('[data-step="1"]').hidden, false);
  assert.equal($('[data-step="0"]').disabled, true);
  assert.equal($('[name="book_reason"]'), null);
  assert.equal($('[name="favorite_book_2"]').required, false);
  assert.equal($('[name="favorite_book_3"]').required, false);
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
  assert.ok(!("book_reason" in state.profile));
  assert.equal(state.profile.intent, "friends");
  assert.equal(state.profile.email_matches, false);
  assert.equal(state.profile.user_id, member.id);
  assert.equal(state.calls.at(-1).action, "insert");
});

test("editing intent clears old preferences, preserves a pause, and writes only the owner row", async t => {
  const romance = { ...profile, intent: "romance", gender: "man", interested_in: ["woman"], age_min: 25, age_max: 40, romance_ideal_match: "Someone curious and kind", is_active: false };
  const { $, set, event, state } = await setup(t, { initialProfile: romance });
  await event("#edit-profile");
  set("intent", "business_partners");
  await event("#profile-intent", "change");
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
  const romance = { ...profile, intent: "romance", gender: "other", interested_in: ["woman", "other"], age_min: 25, age_max: 40 };
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
  assert.match($("#top-books-list").textContent, /1 reader/);
});

test("books stay locked for 24 hours while other profile details remain editable", async t => {
  const { $, set, event, state } = await setup(t, { initialProfile: { ...profile, books_updated_at: new Date().toISOString() } });
  await event("#edit-profile");
  set("display_name", "A new name");
  await event("#profile-form", "submit");
  assert.equal($('[data-step="1"]').hidden, false);
  assert.equal($('[data-step="1"]').disabled, true);
  assert.equal($("#books-lock-note").hidden, false);
  await event("#profile-form", "submit");
  await event("#profile-form", "submit");
  assert.equal(state.profile.display_name, "A new name");
  assert.equal(state.profile.favorite_book_id, "OL1W");
});
