import { COUNTRY_SHAPES } from "./country-shapes.js";
import { displayCountry } from "./country-names.js";
import { createCountryPopup } from "./country-popup.js";

const NS = "http://www.w3.org/2000/svg";
const outlinedCountries = new Set(COUNTRY_SHAPES.map(shape => shape.country));
const popups = new WeakMap();
const countryLabel = info => {
  const count = info.member_count || 0, book = info.top_book;
  const favorite = book ? `Top book: ${book.title}${book.author ? ` by ${book.author}` : ""}`
    : count ? "Top book unavailable." : "No favorites yet.";
  return `${displayCountry(info.country)} · ${count.toLocaleString()} ${count === 1 ? "reader" : "readers"} · ${favorite}`;
};

// Very small islands/territories omitted by the existing world outline remain
// reachable through their city dots, with both city and country counts labeled.
export function cityCountrySummaries(countries) {
  return new Map((countries || []).filter(row => !outlinedCountries.has(row.country))
    .map(row => [row.country, `Country: ${countryLabel(row)}`]));
}

// Country geometry is bundled with the site; all statistics arrive in the
// existing authorized dashboard response. Pointer/focus/tap events are local.
export function renderCountryMap(document, countries, catalog = []) {
  clearCountryMap(document);
  if (!Array.isArray(countries)) return;
  const group = document.querySelector("#map-countries");
  const message = document.querySelector("#map-selection");
  if (!group || !message) return;
  const byCountry = new Map(countries.map(country => [country.country, country]));
  const popup = createCountryPopup(document, catalog); popups.set(document, popup);
  for (const shape of COUNTRY_SHAPES) {
    const info = byCountry.get(shape.country) || { country: shape.country, member_count: 0 };
    const count = info.member_count;
    const label = countryLabel(info);
    const element = document.createElementNS(NS, "path");
    element.setAttribute("d", shape.path);
    element.setAttribute("class", "map-country");
    element.setAttribute("data-country", shape.country);
    element.dataset.mapX = shape.center[0]; element.dataset.mapY = shape.center[1];
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", label);
    // Keep keyboard navigation to countries with members; empty countries are
    // still hoverable/tappable. City markers stay above the country shapes.
    element.setAttribute("tabindex", count ? "0" : "-1");
    popup.bind(element, info);
    group.append(element);
  }
  for (const marker of document.querySelectorAll(".map-marker")) {
    const country = marker.dataset.country;
    popup.bind(marker, outlinedCountries.has(country) ? null : byCountry.get(country), { city: true });
  }
}

export function clearCountryMap(document) {
  popups.get(document)?.destroy(); popups.delete(document);
  document.querySelector("#map-countries")?.replaceChildren();
}
