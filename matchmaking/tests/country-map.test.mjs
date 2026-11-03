import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { renderCountryMap, clearCountryMap, cityCountrySummaries } from "../src/country-map.js";
import { renderCommunityMap } from "../src/map.js";
import { attachMapZoom } from "../src/map-zoom.js";
import { COUNTRY_SHAPES } from "../src/country-shapes.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const community = { total_members: 4, cities: [{ id: 1, name: "Oakland", region: "California", country: "United States", latitude: 37.8, longitude: -122.27, member_count: 4 }],
  countries: [{ country: "United States", member_count: 4, top_book: { title: "A shared favorite", author: "An author", votes: 3 } }] };
async function setup(t) {
  const window = new Window({ settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false } });
  const { document } = window; document.write(html);
  const $ = selector => document.querySelector(selector);
  renderCommunityMap(document, community); renderCountryMap(document, community.countries);
  const zoom = attachMapZoom(document);
  t.after(async () => { zoom.destroy(); await window.happyDOM.close(); });
  return { window, document, $, zoom };
}

test("country hover, focus, and tap show totals and favorite while city dots retain priority", async t => {
  const { window, $, document } = await setup(t);
  const country = $('[data-country="United States"]');
  for (const type of ["mouseenter", "focus", "click"]) {
    country.dispatchEvent(new window.Event(type, { bubbles: true }));
    assert.equal($("#map-selection").textContent, "United States · 4 readers");
    $(".map-marker").dispatchEvent(new window.Event(type, { bubbles: true }));
    assert.equal($("#map-selection").textContent, "Oakland, California, United States · 4 readers");
  }
  assert.match(country.getAttribute("aria-label"), /Top book: A shared favorite by An author/);
  assert.equal(country.querySelector("title"), null, "the native tooltip does not duplicate the popup");
  assert.equal(country.getAttribute("tabindex"), "0");
  assert.equal($("#map-countries").nextElementSibling, $("#map-markers"));
  assert.equal($("#map-countries").parentElement, $("#map-markers").parentElement);
  $('[data-country="Brazil"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal($("#map-selection").textContent, "Brazil · 0 readers");
  renderCountryMap(document, undefined);
  assert.equal($("#map-countries").children.length, 0, "an older response cannot invent zero country counts");
  assert.equal($("#map-markers").children.length, 1);
});

test("country summaries use text, replace previous data, and clear on demand", async t => {
  const { $, document, window } = await setup(t);
  renderCountryMap(document, [{ country: "United States", member_count: 1, top_book: { title: '<img src=x onerror="unsafe()">', author: "<script>unsafe()</script>" } }]);
  const path = $('[data-country="United States"]');
  path.dispatchEvent(new window.Event("click"));
  assert.match($("#country-popup").textContent, /1 reader.*Top book<img/);
  assert.equal($("#map-countries img"), null); assert.equal($("#map-countries script"), null);
  assert.equal($("#map-selection img"), null);
  assert.equal($("#country-popup script"), null);
  assert.equal($("#country-popup img[src=x]"), null);
  assert.equal($("#map-countries").children.length, COUNTRY_SHAPES.length);
  clearCountryMap(document);
  assert.equal($("#map-countries").children.length, 0);
});

test("Palestine keeps its counts and favorite when geographic data uses the original country key", async t => {
  const { $, document, window } = await setup(t);
  const country = "Palestinian Territories";
  const data = { total_members: 4, cities: [{ ...community.cities[0], name: "Ramallah", region: "West Bank", country }],
    countries: [{ ...community.countries[0], country }] };
  renderCommunityMap(document, data); renderCountryMap(document, data.countries);
  const path = $('[data-country="Palestinian Territories"]');
  path.dispatchEvent(new window.Event("mouseenter"));
  assert.equal($("#map-selection").textContent, "Palestine · 4 readers");
  assert.match(path.getAttribute("aria-label"), /Palestine · 4 readers · Top book: A shared favorite/);
  assert.equal($(".country-popup-flag").getAttribute("src"), "/assets/flags/ps.svg");
  $(".map-marker").dispatchEvent(new window.Event("mouseenter"));
  assert.equal($("#map-selection").textContent, "Ramallah, West Bank, Palestine · 4 readers");
  renderCommunityMap(document, data, { showCounts: false, hoverOnly: true });
  assert.equal($(".map-marker title").textContent, "Ramallah, West Bank, Palestine");
});

test("zoom and dragging preserve country/city alignment without accidental selection", async t => {
  const { $, document, window } = await setup(t);
  $("#map-zoom-in").click();
  assert.match($("#map-content").getAttribute("transform"), /scale\(1.5\)/);
  const svg = $("#world-map"); svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 });
  const path = $('[data-country="United States"]');
  for (const [type, x] of [["pointerdown", 200], ["pointermove", 250], ["pointerup", 250]]) path.dispatchEvent(new window.PointerEvent(type, { pointerType: "mouse", pointerId: 1, button: 0, clientX: x, clientY: 200, bubbles: true }));
  const click = new window.Event("click", { bubbles: true, cancelable: true }); path.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.doesNotMatch($("#map-selection").textContent, /Top book/);
  path.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  assert.equal($(".country-popup-layer").hidden, false);
  assert.match($("#country-popup").textContent, /Top book/);
});

test("static shapes keep distinct country identities and valid projected geometry", () => {
  for (const name of ["China", "Taiwan", "Kosovo", "France", "French Guiana", "Norway", "Svalbard & Jan Mayen", "United States"]) assert.ok(COUNTRY_SHAPES.some(row => row.country === name), name);
  for (const shape of COUNTRY_SHAPES) {
    assert.match(shape.path, /^M[\d.,MLZ-]+$/);
    assert.equal(shape.center.length, 2);
    assert.ok(shape.center.every(Number.isFinite));
  }
});

test("small countries omitted by the outline have labeled city-dot summaries, while public dots stay city-only", async t => {
  const { document, $, window } = await setup(t);
  const data = { total_members: 7, cities: [{ ...community.cities[0], name: "Singapore", region: "", country: "Singapore", member_count: 7 }],
    countries: [{ country: "Singapore", member_count: 7, top_book: { title: "A shared favorite", author: "An author" } }] };
  const countrySummaries = cityCountrySummaries([...community.countries, ...data.countries]);
  assert.equal(countrySummaries.has("United States"), false);
  renderCommunityMap(document, data, { countrySummaries });
  $(".map-marker").dispatchEvent(new window.Event("click"));
  assert.match($("#map-selection").textContent, /^Singapore, Singapore · 7 readers · Country: Singapore · 7 readers · Top book: A shared favorite/);
  renderCommunityMap(document, data, { showCounts: false, hoverOnly: true, countrySummaries });
  $(".map-marker").dispatchEvent(new window.Event("mouseenter"));
  assert.equal($("#map-selection").textContent, "Singapore, Singapore");
  assert.equal($(".map-marker title").textContent, "Singapore, Singapore");
});
