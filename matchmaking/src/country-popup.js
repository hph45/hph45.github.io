import { displayCountry } from "./country-names.js";
import { COUNTRY_FLAGS } from "./country-flags.js";
import { bookPresentation } from "./review-catalog.js";
import { createBookCover } from "./book-cover.js";

const NS = "http://www.w3.org/2000/svg";
const clamp = (value, min, max) => Math.min(Math.max(min, max), Math.max(min, value));

// One local popup per map. No hover handler fetches statistics or looks up a
// cover: images come from the same static catalog as the member bookshelves.
export function createCountryPopup(document, catalog) {
  const window = document.defaultView;
  const svg = document.querySelector("#world-map");
  const viewport = svg.closest(".map-viewport");
  const removers = [];
  let active, leaveTimer;
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  };
  const node = (tag, className, text) => {
    const element = document.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const layer = node("div", "country-popup-layer"); layer.hidden = true;
  const connector = document.createElementNS(NS, "svg");
  connector.setAttribute("class", "country-popup-connector"); connector.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(NS, "line");
  const dot = document.createElementNS(NS, "circle"); dot.setAttribute("r", "2.5");
  connector.append(line, dot);
  const card = node("div", "country-popup"); card.id = "country-popup"; card.setAttribute("role", "tooltip");
  layer.append(connector, card); viewport.append(layer);

  function keepOpen() { window.clearTimeout(leaveTimer); }
  function hide() {
    keepOpen(); layer.hidden = true;
    active?.target.removeAttribute("aria-describedby");
    active?.target.classList.remove("is-country-selected");
    active = null;
  }
  function leave() { keepOpen(); leaveTimer = window.setTimeout(hide, 160); }
  function anchorFor(target, event, rect) {
    if (event && event.type !== "focus" && event.type !== "focusin"
      && Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX || event.clientY)) {
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }
    const x = Number(target.dataset.mapX ?? target.getAttribute("cx"));
    const y = Number(target.dataset.mapY ?? target.getAttribute("cy"));
    const matrix = target.getScreenCTM?.();
    if (matrix) return { x: matrix.a * x + matrix.c * y + matrix.e - rect.left, y: matrix.b * x + matrix.d * y + matrix.f - rect.top };
    const fit = Math.min(rect.width / 1000, rect.height / 500);
    return { x: (rect.width - 1000 * fit) / 2 + x * fit, y: (rect.height - 500 * fit) / 2 + y * fit };
  }
  function position(event) {
    if (!active) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const point = anchorFor(active.target, event, rect);
    const x = clamp(point.x, 6, rect.width - 6), y = clamp(point.y, 6, rect.height - 6);
    const width = Math.min(232, rect.width - 16);
    card.style.width = `${width}px`;
    const height = card.getBoundingClientRect().height;
    const left = clamp(x < rect.width / 2 ? x + 32 : x - width - 32, 8, rect.width - width - 8);
    // Small maps can use the space immediately above/below the outline. Keep
    // the card inside the screen, rather than shrinking its type on a phone.
    const minY = rect.width < 460 ? Math.max(-height - 24, 8 - rect.top) : 8;
    const maxY = rect.width < 460 ? Math.min(rect.height + 24, window.innerHeight - rect.top - height - 8) : rect.height - height - 8;
    const above = y > rect.height / 2;
    const top = clamp(above ? y - height - 26 : y + 26, minY, maxY);
    card.style.left = `${left}px`; card.style.top = `${top}px`;
    const endX = x < left ? left : x > left + width ? left + width : clamp(x + (x < rect.width / 2 ? 24 : -24), left + 12, left + width - 12);
    const endY = y < top ? top : y > top + height ? top + height : clamp(y + (above ? -20 : 20), top + 10, top + height - 10);
    connector.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    connector.style.height = `${rect.height}px`;
    line.setAttribute("x1", x); line.setAttribute("y1", y); line.setAttribute("x2", endX); line.setAttribute("y2", endY);
    dot.setAttribute("cx", x); dot.setAttribute("cy", y);
  }
  function show(info, target, event) {
    keepOpen();
    if (active?.target !== target) {
      hide(); active = { target, info };
      const country = displayCountry(info.country), count = info.member_count || 0;
      const heading = node("div", "country-popup-heading");
      const flag = COUNTRY_FLAGS[info.country];
      if (flag) {
        const image = node("img", "country-popup-flag"); image.src = `/assets/flags/${flag}.svg`;
        image.alt = ""; image.width = 24; image.height = 18;
        image.addEventListener("error", () => { image.hidden = true; });
        heading.append(image);
      }
      const identity = node("div", "country-popup-identity");
      identity.append(node("strong", "country-popup-name", country), node("span", "country-popup-count", `${count.toLocaleString()} ${count === 1 ? "reader" : "readers"}`));
      heading.append(identity);
      const body = node("div", "country-popup-book");
      if (info.top_book) {
        const book = info.top_book;
        const cover = createBookCover(document, bookPresentation(book, catalog), { width: 44, height: 66, className: "country-popup-cover" });
        const details = node("div", "country-popup-book-details");
        details.append(node("span", "country-popup-kicker", "Top book"), node("span", "country-popup-title", book.title), node("span", "country-popup-author", book.author));
        body.append(cover, details);
      } else body.append(node("span", "country-popup-empty", count ? "Top book unavailable." : "No favorites yet."));
      card.replaceChildren(heading, body);
      target.setAttribute("aria-describedby", card.id); target.classList.add("is-country-selected");
    }
    layer.hidden = false; position(event);
  }
  listen(card, "mouseenter", keepOpen); listen(card, "mouseleave", leave);
  listen(document, "keydown", event => { if (event.key === "Escape") hide(); });
  listen(document, "pointerdown", event => { if (!card.contains(event.target)) hide(); }, true);
  listen(window, "resize", hide);
  listen(svg, "map-view-change", () => {
    if (active?.target === document.activeElement && active.target.matches(":focus-visible")) position();
    else hide();
  });
  // Keep the card reachable across its short connector gap. A normal city dot
  // replaces country details; tiny countries use their city as the anchor.
  function bind(target, info, { city = false } = {}) {
    for (const type of ["mouseenter", "focus", "click"]) listen(target, type, event => {
      if (!info) { hide(); return; }
      if (!city) document.querySelector("#map-selection").textContent = `${displayCountry(info.country)} · ${(info.member_count || 0).toLocaleString()} ${info.member_count === 1 ? "reader" : "readers"}`;
      show(info, target, event);
    });
    listen(target, "mouseleave", leave); listen(target, "blur", leave);
  }
  return { bind, hide, destroy() { hide(); removers.forEach(remove => remove()); layer.remove(); } };
}
