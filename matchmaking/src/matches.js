import { favoriteBooks, locationLabel, instagramProfileURL, normalizeLinkedInURL } from "./profile.js";
import { bookPresentation } from "./review-catalog.js";

const kinds = { romance: "Romance", friends: "Friend", business_partners: "Business partner" };
const paths = {
  chevron: "m9 5 7 7-7 7", close: "m6 6 12 12M6 18 18 6",
  arrow: "M5 19 19 5M5 5h14v14", pin: "M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0ZM14 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  email: "M3 5h18v14H3ZM3 5l9 7 9-7",
  instagram: "M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M17 7h.01",
};
const key = text => String(text || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const sameBook = (a, b) => a.work_id && b.work_id ? a.work_id === b.work_id
  : key(a.title) === key(b.title) && key(a.author) === key(b.author);

// One page request on load, one write on the first reveal. No polling or private
// profile data in browser storage. Each lifecycle reset invalidates pending work.
export function createMatches({ client, document, window, action, getCatalog, getProfile }) {
  const container = document.querySelector("#matches-list");
  const heading = document.querySelector(".matches-section > .card-heading");
  const eyebrow = heading.querySelector(".eyebrow");
  const dialog = document.querySelector("#match-reveal-dialog");
  const content = document.querySelector("#reveal-content");
  const contact = document.querySelector("#reveal-contact");
  const status = document.querySelector("#reveal-status");
  let version = 0, history = [], catalog = [], cursor = null, total = 0;
  let loading = false, trigger = null, activeMatch = null, overflow = null;
  let observer, track, controls, range, previous, next, older, pageStatus;
  const revealing = new Map();
  const cleanups = [];
  const on = (element, event, handler, options) => {
    element.addEventListener(event, handler, options);
    cleanups.push(() => element.removeEventListener(event, handler, options));
  };
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className, label) => {
    const node = element("button", className, label); node.type = "button"; return node;
  };
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "reveal-icon");
    svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", paths[name]); svg.append(path); return svg;
  }
  function cover(book, width, height, decorative = false) {
    const src = bookPresentation(book, catalog).cover;
    if (!src) {
      const placeholder = element("span", "reveal-cover-placeholder", book.title);
      placeholder.style.width = `${width}px`; placeholder.style.height = `${height}px`;
      placeholder.setAttribute("aria-hidden", "true"); return placeholder;
    }
    const image = element("img"); image.src = src; image.alt = decorative ? "" : `Cover of ${book.title}`;
    image.width = width; image.height = height; image.loading = "lazy"; image.decoding = "async";
    image.addEventListener("error", () => { image.replaceWith(element("span", "reveal-cover-placeholder")); }, { once: true });
    return image;
  }
  function link(label, href, className) {
    const node = element("a", className, label); node.href = href;
    if (href.startsWith("https://")) { node.target = "_blank"; node.rel = "noopener noreferrer"; }
    return node;
  }
  function position() {
    const card = track?.querySelector(".match-reveal-card");
    if (!card) return null;
    const gap = parseFloat(window.getComputedStyle(track).columnGap) || 0;
    const step = Math.max(1, card.getBoundingClientRect().width + gap);
    const visible = Math.max(1, Math.floor((track.clientWidth + gap + 1) / step));
    const first = Math.min(history.length, Math.round(track.scrollLeft / step) + 1);
    return { step, visible, first };
  }
  function updatePosition() {
    const p = position(); if (!p) return;
    const last = Math.min(history.length, p.first + p.visible - 1);
    range.textContent = `${p.first === last ? p.first : `${p.first}–${last}`} of ${total}`;
    previous.disabled = track.scrollLeft < 2;
    next.disabled = loading || (!cursor && track.scrollLeft >= track.scrollWidth - track.clientWidth - 2);
  }
  async function slide(direction) {
    const p = position(); if (!p) return;
    if (direction > 0 && cursor && p.first + p.visible >= history.length) await loadOlder();
    if (!track) return;
    track.scrollBy({ left: direction * p.step * p.visible, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }
  function updateCard(card, match) {
    card.replaceChildren(); card.classList.toggle("has-revealed", Boolean(match.revealed_at));
    if (!match.revealed_at) {
      card.append(element("span", "reveal-card-kind", kinds[match.intent] || "Introduction"), element("span", "reveal-card-hint", "Click to reveal"));
      card.setAttribute("aria-label", `${kinds[match.intent] || "Introduction"}. Click to reveal`);
      return;
    }
    const name = element("span", "reveal-card-person", match.display_name);
    name.append(element("span", "", `, ${match.age}`));
    card.append(name, element("span", "reveal-card-location", locationLabel(match)));
    const book = match.recommended_book;
    if (book) {
      const reading = element("span", "reveal-card-book");
      reading.append(cover(book, 40, 60, true), element("span", "", book.title)); card.append(reading);
    }
    card.setAttribute("aria-label", `${match.display_name}, ${match.age}, ${locationLabel(match)}.${book ? ` Recommended book: ${book.title}.` : ""} Open introduction.`);
  }
  function section(className, label, text) {
    const node = element("section", className);
    node.append(element("h3", "", label), element("p", "preserve-lines", text)); return node;
  }
  function renderDetails(match) {
    content.replaceChildren(); contact.replaceChildren(); status.replaceChildren();
    const date = new Date(`${match.week_start}T00:00:00Z`);
    document.querySelector("#reveal-introduction-label").textContent = `Your introduction${Number.isNaN(date.valueOf()) ? "" : ` · ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(date)}`}`;
    const header = element("header", "reveal-person-heading");
    const name = element("h2", "", match.display_name); name.id = "reveal-name";
    name.append(element("span", "", `, ${match.age}`));
    const place = element("p", "reveal-location"); place.append(icon("pin"), document.createTextNode(locationLabel(match)));
    header.append(element("p", "reveal-kind", kinds[match.intent] || "Introduction"), name, place);
    content.append(header, section("reveal-reason", "Why you crossed paths", match.reason));
    if (match.recommended_book) {
      const book = match.recommended_book;
      const recommendation = element("section", "reveal-recommendation");
      const title = element("div", "reveal-recommendation-heading");
      title.append(element("h3", "", "Read together next"), element("span", "", "Recommended by Zebra Book Club"));
      const row = element("div", "reveal-recommended-book"), info = element("div");
      info.append(element("h4", "", book.title), element("p", "reveal-book-author", book.author));
      if (book.reason) info.append(element("p", "reveal-book-reason preserve-lines", book.reason));
      row.append(cover(book, 72, 108), info); recommendation.append(title, row); content.append(recommendation);
    }
    const shelf = element("section", "reveal-bookshelf"), books = element("div", "reveal-books");
    shelf.append(element("h3", "", `${match.display_name}’s favorite books`), books);
    const mine = favoriteBooks(getProfile() || {});
    for (const book of favoriteBooks(match)) {
      const figure = element("figure"), image = element("div", "reveal-book-cover"); image.append(cover(book, 82, 123));
      figure.append(image, element("figcaption", "", book.title), element("p", "reveal-book-author", book.author));
      if (mine.some(own => sameBook(own, book))) figure.append(element("span", "reveal-shared", "A shared favorite"));
      books.append(figure);
    }
    content.append(shelf);
    if (match.current_book) {
      const row = element("section", "reveal-current"), info = element("div");
      info.append(element("h3", "", "Currently reading"), element("p", "", `${match.current_book} · ${match.current_author}`));
      row.append(cover({ work_id: match.current_book_id, title: match.current_book, author: match.current_author }, 27, 40, true), info); content.append(row);
    }
    if (match.intent === "friends" && match.friendship_interests) content.append(section("reveal-interests", "Time well spent", match.friendship_interests));
    if (match.intent === "business_partners") {
      const details = element("dl", "reveal-business");
      for (const [label, value] of [["What I’m building", match.business_about], ["What I bring", match.business_skills], ["Who I’d like to meet", match.business_seeking]]) {
        if (!value) continue;
        const row = element("div"); row.append(element("dt", "", label), element("dd", "preserve-lines", value)); details.append(row);
      }
      content.append(details);
      const url = normalizeLinkedInURL(match.business_linkedin_url);
      if (url) { const linkedin = link("View LinkedIn ", url, "reveal-linkedin"); linkedin.append(icon("arrow")); content.append(linkedin); }
    }
    const instagram = instagramProfileURL(match.instagram_handle);
    const email = String(match.contact_email || "");
    // No user-supplied mailto parameters, headers, or alternate protocols.
    const validEmail = email.length <= 254 && /^[^\s@?&#%:]+@[^\s@?&#%:]+\.[^\s@?&#%:]+$/.test(email);
    contact.append(element("span", "reveal-contact-label", `Connect with ${match.display_name}`));
    if (instagram || validEmail) {
      const contactLink = link("", instagram || `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}`, "reveal-contact-button");
      contactLink.append(icon(instagram ? "instagram" : "email"), element("span", "", instagram ? "Say hello on Instagram" : "Send them an email!"), icon("arrow"));
      contact.append(contactLink);
    } else {
      contact.append(element("p", "reveal-contact-status", "They haven’t shared contact details yet. Check back here once they do."));
    }
  }
  async function saveReveal(match, card) {
    if (match.revealed_at || revealing.has(match.id)) return;
    const current = version;
    const work = client.rpc("reveal_matchmaking_match", { p_match_id: match.id });
    revealing.set(match.id, work);
    try {
      const { data, error } = await work;
      if (current !== version) return;
      if (error || !data) throw error || new Error("Reveal not saved");
      match.revealed_at = data; updateCard(card, match);
      if (activeMatch === match.id) status.replaceChildren();
    } catch {
      if (current !== version || activeMatch !== match.id || !dialog.open) return;
      const retry = button("text-button", "Try again");
      action(retry, "click", () => saveReveal(match, card));
      status.replaceChildren(document.createTextNode("Your introduction is open, but we couldn’t save its reveal. "), retry);
    } finally { if (current === version) revealing.delete(match.id); }
  }
  async function openMatch(match, card) {
    trigger = card; activeMatch = match.id; renderDetails(match);
    if (!dialog.open) {
      overflow = document.body.style.overflow; document.body.style.overflow = "hidden"; dialog.showModal();
    }
    content.scrollTop = 0;
    dialog.querySelector(".reveal-close").focus({ preventScroll: true });
    await saveReveal(match, card);
  }
  function appendCards(matches) {
    for (const match of matches) {
      if (history.some(item => item.id === match.id)) continue;
      history.push(match);
      const card = button("match-reveal-card"); card.dataset.matchId = match.id;
      card.setAttribute("aria-haspopup", "dialog"); card.setAttribute("aria-controls", dialog.id);
      updateCard(card, match); action(card, "click", () => openMatch(match, card)); track.append(card);
    }
    updatePosition();
  }
  function mount() {
    container.closest(".matches-section").classList.add("has-introductions");
    eyebrow.hidden = true; container.removeAttribute("aria-live");
    controls = element("div", "reveal-carousel-controls");
    range = element("span", "reveal-carousel-range"); range.setAttribute("role", "status");
    previous = button("reveal-carousel-previous"); next = button("reveal-carousel-next");
    for (const [node, label, direction] of [[previous, "See newer matches", -1], [next, "See older matches", 1]]) {
      node.setAttribute("aria-label", label); node.append(icon("chevron")); action(node, "click", () => slide(direction));
    }
    controls.append(range, previous, next); heading.append(controls);
    track = element("div", "match-reveal-grid"); track.setAttribute("role", "group"); track.setAttribute("aria-label", "Your matches, newest first");
    pageStatus = element("div", "reveal-history-status"); pageStatus.setAttribute("role", "status");
    older = button("text-button reveal-load-older", "Load older matches"); action(older, "click", loadOlder);
    container.replaceChildren(track, pageStatus, older);
    track.addEventListener("scroll", updatePosition, { passive: true });
    track.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const cards = [...track.children], index = cards.indexOf(document.activeElement); if (index < 0) return;
      const to = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : Math.max(0, Math.min(cards.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
      event.preventDefault(); cards[to].focus({ preventScroll: true }); cards[to].scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    });
    if (window.ResizeObserver) { observer = new window.ResizeObserver(updatePosition); observer.observe(track); }
  }
  async function page(before) {
    const { data, error } = await client.rpc("get_my_matchmaking_introductions", {
      p_before_released_at: before?.released_at || null, p_before_id: before?.id || null, p_limit: 24,
    });
    if (error || !Array.isArray(data?.items)) throw error || new Error("Matches unavailable");
    return data;
  }
  async function loadOlder() {
    if (loading || !cursor) return;
    const current = version; loading = true; older.disabled = true; pageStatus.textContent = "Loading older matches…"; updatePosition();
    try {
      const data = await page(cursor); if (current !== version) return;
      cursor = data.next_cursor; total = data.total_count; appendCards(data.items);
      pageStatus.textContent = ""; older.hidden = !cursor;
    } catch { if (current === version) pageStatus.textContent = "We couldn’t load older matches. Please try again."; }
    finally { if (current === version) { loading = false; older.disabled = false; updatePosition(); } }
  }
  function finishClose() {
    if (overflow !== null) { document.body.style.overflow = overflow; overflow = null; }
    activeMatch = null; content.replaceChildren(); contact.replaceChildren(); status.replaceChildren();
    trigger?.focus({ preventScroll: true }); trigger = null;
  }
  on(dialog.querySelector(".reveal-close"), "click", () => dialog.close());
  on(dialog, "close", () => { if (!dialog.open) finishClose(); });
  on(dialog, "click", event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  function reset() {
    version++; trigger = null;
    if (dialog.open) dialog.close(); finishClose();
    observer?.disconnect(); controls?.remove(); eyebrow.hidden = false;
    container.closest(".matches-section").classList.remove("has-introductions");
    container.replaceChildren(); container.setAttribute("aria-live", "polite");
    history = []; revealing.clear(); track = null; cursor = null; loading = false; total = 0;
  }
  async function load() {
    reset(); const current = version; container.textContent = "Looking for your introductions…";
    try {
      const [data, covers] = await Promise.all([page(null), getCatalog()]);
      if (current !== version) return;
      container.replaceChildren(); catalog = covers; total = data.total_count; cursor = data.next_cursor;
      if (!data.items.length) {
        const empty = element("div", "empty-matches");
        empty.append(element("h3", "", "Your next chapter is still being written."), element("p", "", "Weekly introductions are coming soon. When you have a match, you’ll find them here.")); container.append(empty); return;
      }
      mount(); appendCards(data.items); older.hidden = !cursor;
    } catch {
      if (current !== version) return;
      const retry = button("text-button", "Try again"); action(retry, "click", load);
      container.replaceChildren(document.createTextNode("We couldn’t load your matches. "), retry);
    }
  }
  return { load, reset, destroy() { reset(); cleanups.forEach(cleanup => cleanup()); } };
}
