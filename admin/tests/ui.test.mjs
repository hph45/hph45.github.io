import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { createAdminApp } from "../src/ui.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const sample = {
  generated_at: "2026-10-22T12:00:00Z", total_members: 20, active_members: 17, median_age: 31.5,
  city_count: 14, country_count: 2,
  age_groups: [{ label: "18–24", member_count: 5 }, { label: "25–34", member_count: 15 }],
  genders: [{ key: "woman", label: "Woman", member_count: 12 }, { key: "not_provided", label: "Not provided", member_count: 8 }],
  connection_types: [{ key: "romance", label: "Romance", member_count: 12 }, { key: "friends", label: "Friends", member_count: 15 }, { key: "business_partners", label: "Business partners", member_count: 8 }],
  countries: [{ country: "United States", member_count: 19 }, { country: "Brazil", member_count: 1 }],
  cities: Array.from({ length: 14 }, (_, i) => ({ id: i + 1, name: i === 13 ? "São Paulo" : `City ${i + 1}`, region: "Region", country: i === 13 ? "Brazil" : "United States", latitude: 35, longitude: -120 + i * 10, member_count: i === 0 ? 7 : 1 })),
};
const success = () => ({ data: structuredClone(sample), error: null });
const sampleProfile = {
  display_name: "Example reader", age: 31, city: "Oakland", region: "California", country: "United States",
  intents: ["romance", "friends", "business_partners"], is_active: true, email_matches: false, location_preference: "same_city",
  favorite_books: [{ title: "Favorite one", author: "First author" }, { title: "Favorite two", author: "Second author" }, { title: "Favorite three", author: "Third author" }],
  gender: "other", interested_in: ["woman", "other"], age_min: 25, age_max: 120, romance_ideal_match: "A thoughtful reader.",
  friendship_interests: "Bookshops and coffee.", business_about: "A bookshop.", business_skills: "Events and community.", business_seeking: "An operations partner.", business_linkedin_url: "https://www.linkedin.com/in/reader",
};
const membersSuccess = () => ({ data: { total_count: 1, page: 1, page_size: 20, profiles: [structuredClone(sampleProfile)] }, error: null });
const forbidden = { data: null, error: { code: "42501", message: "ADMIN_ONLY" } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };

async function setup(t, { signedIn = true, response = success(), profileResponse = membersSuccess(), autoStart = true } = {}) {
  const window = new Window({ url: "https://zebrabookclub.com/admin/", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false } });
  window.document.write(html);
  const state = { session: signedIn ? { user: { id: "owner" } } : null, response, profileResponse, calls: [], requests: [], unsubscribed: false };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      onAuthStateChange(callback) { state.onAuth = callback; return { data: { subscription: { unsubscribe() { state.unsubscribed = true; } } } }; },
    },
    rpc: async (name, args) => { state.calls.push(name); state.requests.push({ name, args }); return name === "get_matchmaking_admin_profiles" ? state.profileResponse : state.response; },
  };
  const app = createAdminApp({ client, document: window.document, window });
  const $ = selector => window.document.querySelector(selector);
  const event = async (selector, type = "click") => { $(selector).dispatchEvent(new window.Event(type, { bubbles: true })); await app.settled(); };
  const auth = (event, id = null) => { state.session = id ? { user: { id } } : null; state.onAuth(event, state.session); };
  t.after(async () => { app.destroy(); await window.happyDOM.close(); });
  if (autoStart) await app.start();
  return { app, window, state, $, event, auth };
}

test("signed-out visitors redirect without making a statistics request", async t => {
  const { $, state, window } = await setup(t, { signedIn: false });
  assert.equal(window.location.pathname, "/matchmaking/");
  assert.equal($("#admin-view").hidden, true);
  assert.deepEqual(state.calls, []);
});

test("signed-in non-admins and expired sessions redirect without rendering data", async t => {
  for (const error of [forbidden.error, { code: "PGRST301" }, { status: 401 }]) {
    const { $, window, state } = await setup(t, { response: { data: sample, error } });
    assert.equal(window.location.pathname, "/matchmaking/");
    assert.equal($("#admin-view").hidden, true);
    assert.equal($("#summary-total").textContent, "—");
    assert.deepEqual(state.calls, ["get_matchmaking_admin_stats"]);
  }
});

test("authorized aggregates render clear counts, shares, and a zoomable map", async t => {
  const { $, window, event } = await setup(t);
  assert.equal($("#admin-view").hidden, false);
  assert.equal($("#loading-view").hidden, true);
  assert.equal($("#summary-total").textContent, "20");
  assert.equal($("#summary-age").textContent, "31.5");
  assert.equal($("#population-note").textContent, "20 profiles · 17 active · 3 paused");
  assert.equal($("#age-chart li .bar-value").textContent, "525%");
  assert.equal($("#age-chart li .bar-fill").style.width, "25%");
  assert.match($("#gender-chart").textContent, /Not provided840%/);
  assert.match($("#connection-chart").textContent, /Friends1575%/);
  assert.equal(window.document.querySelectorAll(".map-marker").length, 14);
  await event("#map-zoom-in");
  assert.match($("#map-content").getAttribute("transform"), /scale\(1.5\)/);
  assert.equal(window.localStorage.length, 0, "no demographic data is persisted");
});

test("location modes, pagination, and accent-insensitive search retain the full-population shares", async t => {
  const { $, event, window } = await setup(t);
  assert.equal($("#location-status").textContent, "1–2 of 2");
  assert.match($("#location-rows").textContent, /United States1995%/);
  await event('[data-location-mode="cities"]');
  assert.equal($("#location-status").textContent, "1–12 of 14");
  assert.equal(window.document.querySelectorAll("#location-rows tr").length, 12);
  await event("#next-locations");
  assert.equal($("#location-status").textContent, "13–14 of 14");
  assert.equal($("#next-locations").disabled, true);
  $("#location-search").value = "sao"; await event("#location-search", "input");
  assert.equal($("#location-status").textContent, "1–1 of 1");
  assert.match($("#location-rows").textContent, /São PauloRegion, Brazil15%/);
  assert.equal($("#previous-locations").disabled, true);
  $("#location-search").value = "nowhere"; await event("#location-search", "input");
  assert.equal($("#location-empty").hidden, false);
  assert.equal($("#location-rows").children.length, 0);
});

test("server labels render as text and an empty community has no false counts", async t => {
  const data = structuredClone(sample);
  data.countries[0].country = '<img src=x onerror="alert(1)">';
  const { $, window } = await setup(t, { response: { data, error: null } });
  assert.equal($("#location-rows img"), null);
  assert.match($("#location-rows").textContent, /<img/);
  assert.equal(window.document.querySelectorAll("script").length, 1);
  const empty = { ...sample, total_members: 0, active_members: 0, median_age: null, city_count: 0, country_count: 0, cities: [], countries: [], age_groups: [], genders: [] };
  const zero = await setup(t, { response: { data: empty, error: null } });
  assert.equal(zero.$("#summary-total").textContent, "0");
  assert.equal(zero.$("#summary-age").textContent, "—");
  assert.equal(zero.$("#location-empty").hidden, false);
});

test("a failed refresh clears old data, supports retry, and checks revocation again", async t => {
  const { $, state, event, window } = await setup(t);
  state.response = { data: null, error: new Error("Network unavailable") };
  await event("#refresh");
  assert.equal($("#error-view").hidden, false);
  assert.equal($("#admin-view").hidden, true);
  assert.equal($("#age-chart").children.length, 0);
  assert.equal($("#map-markers").children.length, 0);
  assert.equal($("#member-list").children.length, 0);
  assert.equal($("#summary-total").textContent, "—");
  state.response = success(); await event("#retry");
  assert.equal($("#admin-view").hidden, false);
  state.response = forbidden; await event("#refresh");
  assert.equal(window.location.pathname, "/matchmaking/");
  assert.equal($("#admin-view").hidden, true);
});

test("a late authorized response cannot restore data after sign-out, account switch, or destruction", async t => {
  for (const action of ["sign-out", "switch", "destroy"]) {
    const delayed = deferred();
    const { $, app, state, auth, window } = await setup(t, { response: delayed.promise, autoStart: false });
    const loading = app.start();
    await Promise.resolve();
    assert.equal(state.calls.length, 1);
    if (action === "destroy") app.destroy();
    else if (action === "sign-out") auth("SIGNED_OUT");
    else { state.response = forbidden; auth("SIGNED_IN", "another-member"); }
    delayed.resolve(success()); await loading; await app.settled();
    assert.equal($("#admin-view").hidden, true);
    assert.equal($("#age-chart").children.length, 0);
    assert.equal($("#summary-total").textContent, "—");
    if (action !== "destroy") assert.equal(window.location.pathname, "/matchmaking/");
  }
});

test("back-forward cache clears data and requires fresh authorization on return", async t => {
  const { $, window, app, state } = await setup(t);
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal($("#admin-view").hidden, true);
  assert.equal($("#map-markers").children.length, 0);
  assert.equal($("#member-list").children.length, 0);
  state.response = forbidden;
  const returned = new window.Event("pageshow"); returned.persisted = true;
  window.dispatchEvent(returned); await app.settled();
  assert.equal(window.location.pathname, "/matchmaking/");
  assert.equal($("#admin-view").hidden, true);
});

test("the directory shows favorite books and answers for every selected type", async t => {
  const { $, window } = await setup(t);
  assert.equal($("#member-list").children.length, 1);
  assert.equal($("#member-list details").open, false);
  assert.match($("#member-list summary").textContent, /Example reader31 · Oakland, California, United States/);
  assert.match($("#member-list summary").textContent, /Romance · Friends · Business partners/);
  assert.equal(window.document.querySelectorAll(".member-book").length, 3);
  $("#member-list details").open = true;
  const answers = $(".member-answers").textContent;
  for (const value of ["25–80+", "Woman, Other", "A thoughtful reader.", "Bookshops and coffee.", "A bookshop.", "Events and community.", "An operations partner."]) assert.ok(answers.includes(value), value);
  assert.equal($(".member-answers a").href, "https://www.linkedin.com/in/reader");
  assert.equal($(".member-answers a").rel, "noopener noreferrer");
  assert.equal($("#member-status").textContent, "1–1 of 1 reader");
});

test("directory searches, type filters, and page changes call the protected endpoint", async t => {
  const { $, event, state } = await setup(t);
  state.profileResponse = { data: { total_count: 25, page: 1, page_size: 20, profiles: Array.from({ length: 20 }, () => structuredClone(sampleProfile)) }, error: null };
  $("#member-search").value = "  Reader.0+club@Example.invalid  "; await event("#member-search", "input");
  assert.deepEqual(state.requests.at(-1).args, { p_search: "Reader.0+club@Example.invalid", p_intent: null, p_page: 1, p_page_size: 20, p_min_age: null, p_max_age: null, p_gender: null });
  assert.equal($("#next-members").disabled, false);
  state.profileResponse.data.page = 2; state.profileResponse.data.profiles.length = 5;
  await event("#next-members");
  assert.equal(state.requests.at(-1).args.p_page, 2);
  assert.equal($("#member-status").textContent, "21–25 of 25 readers");
  state.profileResponse = membersSuccess();
  $("#member-intent").value = "friends"; await event("#member-intent", "change");
  assert.equal(state.requests.at(-1).args.p_page, 1);
  assert.equal(state.requests.at(-1).args.p_intent, "friends");
  state.profileResponse = { data: { total_count: 0, page: 1, page_size: 20, profiles: [] }, error: null };
  $("#member-search").value = "Nobody"; await event("#member-search", "input");
  assert.equal($("#members-empty").hidden, false);
  assert.equal($("#member-list").children.length, 0);
});

test("age and gender combine with existing filters, reset pagination, and persist through refresh", async t => {
  const { $, event, state } = await setup(t);
  state.profileResponse = { data: { total_count: 25, page: 1, page_size: 20, profiles: Array.from({ length: 20 }, () => structuredClone(sampleProfile)) }, error: null };
  $("#member-search").value = " @example.invalid ";
  $("#member-intent").value = "friends";
  $("#member-min-age").value = "25"; $("#member-max-age").value = "40";
  $("#member-gender").value = "other"; await event("#member-gender", "change");
  const args = { p_search: "@example.invalid", p_intent: "friends", p_min_age: 25, p_max_age: 40, p_gender: "other", p_page: 1, p_page_size: 20 };
  assert.deepEqual(state.requests.at(-1).args, args);
  state.profileResponse.data.page = 2; state.profileResponse.data.profiles.length = 5;
  await event("#next-members");
  assert.deepEqual(state.requests.at(-1).args, { ...args, p_page: 2 });
  state.profileResponse = membersSuccess();
  $("#member-min-age").value = "30"; await event("#member-min-age", "input");
  assert.deepEqual(state.requests.at(-1).args, { ...args, p_min_age: 30 });
  await event("#refresh");
  assert.deepEqual(state.requests.at(-1).args, { ...args, p_min_age: 30 });
  $("#member-min-age").value = ""; $("#member-max-age").value = "";
  $("#member-gender").value = ""; await event("#member-gender", "change");
  assert.deepEqual(state.requests.at(-1).args, { ...args, p_min_age: null, p_max_age: null, p_gender: null });
  $("#member-gender").value = "not_provided"; await event("#member-gender", "change");
  assert.equal(state.requests.at(-1).args.p_gender, "not_provided");
});

test("invalid ages show an inline error without a request, and corrected or open bounds recover", async t => {
  const { $, event, state } = await setup(t);
  const requests = state.requests.length;
  for (const [min, max] of [["17", ""], ["", "121"], ["25.5", ""], ["40", "30"]]) {
    $("#member-min-age").value = min; $("#member-max-age").value = max;
    await event("#member-max-age", "input");
    assert.equal(state.requests.length, requests);
    assert.equal($("#member-filter-error").hidden, false);
    assert.equal($("#member-list").children.length, 0);
    assert.equal($("#members-loading").hidden, true);
    assert.equal($("#next-members").disabled, true);
  }
  assert.match($("#member-filter-error").textContent, /Minimum age/);
  assert.equal($("#member-min-age").getAttribute("aria-invalid"), "true");
  $("#member-min-age").value = ""; await event("#member-min-age", "input");
  assert.equal($("#member-filter-error").hidden, true);
  assert.equal($("#member-min-age").hasAttribute("aria-invalid"), false);
  assert.equal(state.requests.at(-1).args.p_min_age, null);
  assert.equal(state.requests.at(-1).args.p_max_age, 30);
  assert.equal($("#member-list").children.length, 1);
  $("#member-min-age").value = "80"; $("#member-max-age").value = "";
  await event("#member-max-age", "input");
  assert.equal(state.requests.at(-1).args.p_min_age, 80);
  assert.equal(state.requests.at(-1).args.p_max_age, null);
});

test("changing demographics cancels stale results and sign-out disables all filters", async t => {
  const { $, app, event, state, auth, window } = await setup(t);
  const old = deferred(); state.profileResponse = old.promise;
  $("#member-gender").value = "woman";
  $("#member-gender").dispatchEvent(new window.Event("change"));
  $("#member-min-age").value = "40"; $("#member-max-age").value = "30";
  $("#member-min-age").dispatchEvent(new window.Event("input"));
  old.resolve(membersSuccess()); await app.settled();
  assert.equal($("#member-list").children.length, 0);
  assert.equal($("#member-filter-error").hidden, false);
  state.profileResponse = membersSuccess();
  $("#member-max-age").value = ""; await event("#member-max-age", "input");
  assert.equal($("#member-list").children.length, 1);
  auth("SIGNED_OUT"); await app.settled();
  for (const id of ["member-search", "member-intent", "member-min-age", "member-max-age", "member-gender"]) assert.equal($(`#${id}`).disabled, true);
  assert.equal($("#member-list").children.length, 0);
});

test("profile text cannot inject HTML and unsafe LinkedIn links stay plain text", async t => {
  const response = membersSuccess();
  response.data.profiles[0].display_name = '<img src=x onerror="alert(1)">';
  response.data.profiles[0].romance_ideal_match = "<script>alert(1)</script>";
  response.data.profiles[0].business_linkedin_url = "javascript:alert(1)";
  response.data.profiles[0].current_book = '<img src=x onerror="alert(1)">';
  response.data.profiles[0].current_author = "Current author";
  const { $ } = await setup(t, { profileResponse: response });
  assert.equal($("#member-list img"), null); assert.equal($("#member-list script"), null);
  assert.equal($("#member-list a"), null);
  assert.match($("#member-list").textContent, /<script>/);
  assert.match($("#member-list").textContent, /Currently reading.*Current author/);
});

test("directory errors clear profiles, retry recovers, and revoked access clears the entire dashboard", async t => {
  const { $, state, event, window } = await setup(t);
  state.profileResponse = { data: null, error: new Error("Offline") };
  await event("#member-intent", "change");
  assert.equal($("#members-error").hidden, false);
  assert.equal($("#member-list").children.length, 0);
  state.profileResponse = membersSuccess(); await event("#retry-members");
  assert.equal($("#member-list").children.length, 1);
  state.profileResponse = forbidden; await event("#member-intent", "change");
  assert.equal(window.location.pathname, "/matchmaking/");
  assert.equal($("#admin-view").hidden, true);
  assert.equal($("#member-list").children.length, 0);
  assert.equal($("#age-chart").children.length, 0);
});

test("a late profile response cannot restore private answers after sign-out or a newer search", async t => {
  const { $, app, state, auth, window } = await setup(t);
  const old = deferred(); state.profileResponse = old.promise;
  $("#member-intent").dispatchEvent(new window.Event("change"));
  state.profileResponse = membersSuccess();
  state.profileResponse.data.profiles[0].display_name = "Newest result";
  $("#member-intent").dispatchEvent(new window.Event("change"));
  await Promise.resolve(); await Promise.resolve();
  old.resolve(membersSuccess()); await app.settled();
  assert.equal($(".member-name").textContent, "Newest result");
  const later = deferred(); state.profileResponse = later.promise;
  $("#member-intent").dispatchEvent(new window.Event("change"));
  auth("SIGNED_OUT");
  later.resolve(membersSuccess()); await app.settled();
  assert.equal($("#member-list").children.length, 0);
  assert.equal($("#admin-view").hidden, true);
});
