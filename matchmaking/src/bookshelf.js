import { attachAutocomplete } from "./autocomplete.js";
import { createBookCover } from "./book-cover.js";
import { bookPresentation } from "./review-catalog.js";

const pageSize = 24;

export function createBookshelf({ client, document, window, action, search, getCatalog, getUserId }) {
  const $ = selector => document.querySelector(selector);
  const view = $("#bookshelf-view"), dialog = $("#bookshelf-dialog"), form = $("#bookshelf-form");
  const list = $("#bookshelf-list"), more = $("#bookshelf-more"), status = $("#bookshelf-status");
  const title = $("#bookshelf-book"), author = $("#bookshelf-author"), submit = $("#bookshelf-submit");
  const stars = $("#bookshelf-stars"), cancel = $("#bookshelf-cancel"), remove = $("#bookshelf-remove");
  const entries = new Map();
  let offset = 0, hasMore = false, appendNext = false, loading = false, listVersion = 0;
  let chosenBook = null, book = null, existing = false, initialRating = null, rating = null;
  let busy = false, editorVersion = 0;

  const autocomplete = attachAutocomplete(title, {
    document, window, delay: 150, search: search.books, describe: item => [item.title, item.author],
    emptyMessage: "You can add the title you typed.", failureMessage: "You can still enter a title and author.",
    suggestionMessage: "Choose a book or keep the title you typed.",
    onSelect(item) { chosenBook = item; title.value = item.title; author.value = item.author; },
    onClear() { if (chosenBook) author.value = ""; chosenBook = null; },
  });
  author.addEventListener("input", () => { chosenBook = null; });

  function renderRating() {
    for (const button of stars.children) {
      const value = Number(button.value);
      const fraction = Math.min(1, Math.max(0, (rating ?? 0) - value + 1));
      button.style.setProperty("--star-fill", `${fraction * 100}%`);
      button.setAttribute("aria-label", `Star ${value}, ${fraction * 100}% filled`);
    }
    $("#bookshelf-rating").textContent = rating ? `${rating} out of 5 stars` : "Unrated";
    $("#bookshelf-clear").hidden = !rating;
  }
  for (let value = 1; value <= 5; value++) {
    const button = document.createElement("button");
    button.type = "button"; button.value = String(value);
    const star = document.createElement("span"); star.textContent = "★"; star.setAttribute("aria-hidden", "true");
    button.append(star);
    button.addEventListener("click", () => {
      const filled = Math.min(1, Math.max(0, (rating ?? 0) - value + 1));
      rating = (value - 1 + (filled === 1 ? 0 : filled + 0.25)) || null;
      renderRating();
    });
    stars.append(button);
  }
  $("#bookshelf-clear").addEventListener("click", () => { rating = null; renderRating(); stars.firstElementChild.focus(); });

  function appendBook(entry, catalog) {
    const row = document.createElement("li"), button = document.createElement("button");
    button.type = "button"; button.className = "bookshelf-row"; button.dataset.workId = entry.work_id;
    const info = document.createElement("span"), name = document.createElement("strong"), by = document.createElement("small");
    name.textContent = entry.title; by.textContent = entry.author; info.append(name, by);
    const score = document.createElement("span"); score.className = "bookshelf-score";
    score.textContent = entry.rating == null ? "Unrated" : `★ ${Number(entry.rating)} / 5`;
    button.setAttribute("aria-label", `Edit ${entry.title} by ${entry.author}, ${entry.rating == null ? "unrated" : entry.rating + " out of 5 stars"}`);
    button.append(createBookCover(document, bookPresentation(entry, catalog)), info, score);
    row.append(button); list.append(row);
  }

  async function load(append = false) {
    if (view.hidden || !getUserId() || (append && (loading || !hasMore))) return;
    const version = ++listVersion;
    loading = true; more.disabled = true;
    status.textContent = "Loading books…";
    try {
      const [{ data, error }, catalog] = await Promise.all([
        client.rpc("get_my_matchmaking_library", { p_offset: append ? offset : 0, p_limit: pageSize + 1 }),
        getCatalog().catch(() => []),
      ]);
      if (version !== listVersion) return;
      if (error || !Array.isArray(data)) throw error || new Error("Unavailable");
      if (!append) { entries.clear(); list.replaceChildren(); offset = 0; }
      for (const entry of data.slice(0, pageSize)) {
        if (!entries.has(entry.work_id)) { entries.set(entry.work_id, entry); appendBook(entry, catalog); }
      }
      offset += Math.min(pageSize, data.length);
      hasMore = data.length > pageSize;
      appendNext = hasMore;
      more.hidden = !hasMore; more.textContent = "Load more books";
      status.textContent = entries.size ? "" : "Add your first book to start your shelf.";
    } catch {
      if (version !== listVersion) return;
      status.textContent = "Your books couldn’t load. Please try again.";
      appendNext = append;
      more.hidden = false; more.textContent = "Try again";
    } finally { if (version === listVersion) { loading = false; more.disabled = false; } }
  }

  function closeEditor() {
    editorVersion++; busy = false; book = chosenBook = null; rating = initialRating = null; existing = false;
    if (dialog.open) dialog.close();
    autocomplete.close(); form.reset(); form.inert = false; form.hidden = false;
    $("#bookshelf-rating-fields").hidden = true;
    $("#bookshelf-book-fields").hidden = $("#bookshelf-book-fields").disabled = false;
    for (const id of ["#bookshelf-selected-title", "#bookshelf-selected-author", "#bookshelf-remove-title", "#bookshelf-error", "#bookshelf-remove-error"]) $(id).textContent = "";
    $("#bookshelf-error").hidden = $("#bookshelf-remove-error").hidden = $("#bookshelf-removal").hidden = remove.hidden = true;
    $("#bookshelf-confirm-remove").disabled = $("#bookshelf-keep").disabled = false;
    submit.textContent = "Continue"; $("#bookshelf-editor-title").textContent = "Add a book"; renderRating();
  }
  function editRating(item, saved) {
    book = item; existing = Boolean(saved); rating = initialRating = saved?.rating == null ? null : Number(saved.rating);
    $("#bookshelf-book-fields").hidden = $("#bookshelf-book-fields").disabled = true;
    $("#bookshelf-rating-fields").hidden = false;
    $("#bookshelf-editor-title").textContent = existing ? "Edit rating" : "Rate this book";
    $("#bookshelf-selected-title").textContent = item.title; $("#bookshelf-selected-author").textContent = item.author;
    remove.hidden = !existing; submit.textContent = existing ? "Save changes" : "Save book";
    renderRating(); stars.firstElementChild.focus();
  }
  function openEditor(entry) {
    if (!getUserId() || view.hidden) return;
    closeEditor(); dialog.showModal();
    if (entry) editRating(entry, entry); else title.focus();
  }
  $("#bookshelf-add").addEventListener("click", () => openEditor());
  list.addEventListener("click", event => {
    const entry = entries.get(event.target.closest("button[data-work-id]")?.dataset.workId);
    if (entry) openEditor(entry);
  });
  cancel.addEventListener("click", () => { if (!busy) closeEditor(); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); if (!busy) closeEditor(); });
  action(more, "click", () => load(appendNext));

  action(form, "submit", async () => {
    if (!dialog.open || busy || !getUserId()) return;
    const version = editorVersion, picking = !book;
    const errorBox = $("#bookshelf-error"); errorBox.hidden = true;
    if (picking && !title.value.trim()) { title.focus(); return; }
    busy = true; form.inert = true;
    submit.textContent = picking ? "Loading…" : "Saving…";
    try {
      if (picking) {
        const item = chosenBook || { work_id: "manual", title: title.value.trim(), author: author.value.trim() };
        let saved = null;
        if (item.work_id !== "manual") {
          const result = await client.from("matchmaking_library_books").select("rating").eq("user_id", getUserId()).eq("work_id", item.work_id).maybeSingle();
          if (result.error) throw result.error;
          saved = result.data;
        }
        if (version === editorVersion) { form.inert = false; editRating(item, saved); }
        return;
      }
      if (existing && rating === initialRating) { closeEditor(); return; }
      const values = { p_work_id: book.work_id, p_title: book.title, p_author: book.author };
      const result = !existing && rating === null
        ? await client.rpc("add_my_unrated_matchmaking_library_book", values)
        : await client.rpc("save_my_matchmaking_library_book", { ...values, p_rating: rating });
      if (version !== editorVersion) return;
      if (result.error) throw result.error;
      closeEditor(); await load();
    } catch {
      if (version !== editorVersion) return;
      errorBox.textContent = picking ? "Your saved rating couldn’t load. Please try again." : "Your book couldn’t be saved. Please try again.";
      errorBox.hidden = false; submit.textContent = picking ? "Continue" : existing ? "Save changes" : "Save book";
    } finally { if (version === editorVersion) { busy = false; form.inert = false; } }
  });
  remove.addEventListener("click", () => {
    if (!existing || busy) return;
    form.hidden = true; $("#bookshelf-removal").hidden = false;
    $("#bookshelf-editor-title").textContent = "Remove this book?";
    $("#bookshelf-remove-title").textContent = book.title; $("#bookshelf-keep").focus();
  });
  $("#bookshelf-keep").addEventListener("click", () => {
    if (busy) return;
    $("#bookshelf-removal").hidden = $("#bookshelf-remove-error").hidden = true; form.hidden = false;
    $("#bookshelf-editor-title").textContent = "Edit rating"; remove.focus();
  });
  action($("#bookshelf-confirm-remove"), "click", async () => {
    if (!dialog.open || !existing || !getUserId() || busy) return;
    const version = editorVersion; busy = true;
    $("#bookshelf-confirm-remove").disabled = $("#bookshelf-keep").disabled = true;
    try {
      const { error } = await client.rpc("remove_my_matchmaking_library_book", { p_work_id: book.work_id });
      if (version !== editorVersion) return;
      if (error) throw error;
      closeEditor(); await load();
    } catch {
      if (version !== editorVersion) return;
      $("#bookshelf-remove-error").textContent = "This book couldn’t be removed. Please try again.";
      $("#bookshelf-remove-error").hidden = false; busy = false;
      $("#bookshelf-confirm-remove").disabled = $("#bookshelf-keep").disabled = false;
    }
  });

  function reset() {
    listVersion++; closeEditor(); entries.clear(); list.replaceChildren(); offset = 0; hasMore = appendNext = loading = false;
    more.hidden = true; more.disabled = false; more.textContent = "Load more books"; status.textContent = "";
  }
  return { load, reset, destroy() { reset(); autocomplete.destroy(); } };
}
