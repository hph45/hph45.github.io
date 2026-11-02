export function createMatchReview({ client, document }) {
  const dialog = document.querySelector("#match-review-dialog");
  const form = document.querySelector("#match-review-form");
  const fields = [...form.querySelectorAll("fieldset")];
  const submit = document.querySelector("#match-review-save");
  const message = document.querySelector("#match-review-message");
  const error = document.querySelector("#match-review-error");
  const retry = document.querySelector("#match-review-retry");
  const cache = new Map(), cleanups = [];
  let generation = 0, active = null, trigger = null, onSaved = null, ready = false, busy = false;
  const on = (node, event, handler) => {
    node.addEventListener(event, handler);
    cleanups.push(() => node.removeEventListener(event, handler));
  };
  const rating = name => Number(form.querySelector(`input[name="${name}"]:checked`)?.value) || null;
  const key = match => `${match.id}:${match.recommended_book?.work_id || ""}`;
  const valid = value => Number.isInteger(value) && value >= 1 && value <= 5;
  for (const field of fields) {
    const stars = field.querySelector(".review-stars");
    for (let value = 1; value <= 5; value++) {
      const label = document.createElement("label"), input = document.createElement("input");
      input.type = "radio"; input.name = field.dataset.rating; input.value = String(value); input.required = true;
      input.setAttribute("aria-label", `${value} out of 5 stars`);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", "m12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91Z");
      svg.append(path); label.append(input, svg); stars.append(label);
    }
  }
  function update() {
    for (const field of fields) {
      const selected = rating(field.dataset.rating);
      field.disabled = !ready || busy || field.hidden;
      for (const input of field.querySelectorAll("input")) {
        input.required = !field.hidden;
        input.parentElement.dataset.filled = String(Number(input.value) <= selected);
      }
      field.querySelector("output").textContent = selected ? `${selected} / 5` : "Not rated";
    }
    submit.disabled = !ready || busy || !valid(rating("compatibility_rating"))
      || (Boolean(active?.recommended_book) && !valid(rating("book_rating")));
    submit.textContent = busy ? "Saving…" : "Save review";
  }
  function fill(review) {
    for (const name of ["compatibility_rating", "book_rating"]) {
      let value = review?.[name];
      if (name === "book_rating" && review?.recommended_book_id !== (active?.recommended_book?.work_id || null)) value = null;
      if (valid(value)) form.querySelector(`input[name="${name}"][value="${value}"]`).checked = true;
    }
  }
  function cleanup() {
    generation++; active = null; ready = false; busy = false; onSaved = null;
    const previous = trigger; trigger = null;
    form.reset(); message.textContent = ""; error.hidden = true; error.textContent = ""; retry.hidden = true;
    document.querySelector("#match-review-context").textContent = "";
    document.querySelector("#match-review-book").textContent = "";
    update();
    if (previous?.isConnected && previous.closest("dialog")?.open) previous.focus({ preventScroll: true });
  }
  function close() {
    if (dialog.open) dialog.close();
    cleanup();
  }
  async function load() {
    if (!active) return;
    const current = ++generation, match = active;
    ready = false; error.hidden = true; retry.hidden = true; message.textContent = "Loading your review…"; update();
    try {
      let review;
      if (cache.has(key(match))) review = cache.get(key(match));
      else {
        const { data, error: failure } = await client.rpc("get_my_matchmaking_match_review", { p_match_id: match.id });
        if (failure) throw failure;
        review = data;
      }
      if (current !== generation || !dialog.open) return;
      cache.set(key(match), review); fill(review); ready = true; message.textContent = "";
    } catch {
      if (current !== generation || !dialog.open) return;
      message.textContent = ""; error.textContent = "We couldn’t load your review. Please try again."; error.hidden = false; retry.hidden = false;
    } finally { if (current === generation) update(); }
  }
  async function open(match, button, saved) {
    close(); active = match; trigger = button; onSaved = saved;
    document.querySelector("#match-review-context").textContent = `Your introduction to ${match.display_name}`;
    document.querySelector("#match-review-book").textContent = match.recommended_book?.title || "";
    fields.find(field => field.dataset.rating === "book_rating").hidden = !match.recommended_book;
    update(); dialog.showModal(); await load();
  }
  async function save(event) {
    event.preventDefault();
    if (!ready || busy || !active || submit.disabled) return;
    const current = generation, match = active, saved = onSaved;
    const values = { p_match_id: match.id, p_compatibility_rating: rating("compatibility_rating"),
      p_book_rating: match.recommended_book ? rating("book_rating") : null,
      p_recommended_book_id: match.recommended_book?.work_id || null };
    busy = true; error.hidden = true; message.textContent = ""; update();
    try {
      const { data, error: failure } = await client.rpc("save_matchmaking_match_review", values);
      if (current !== generation || !dialog.open) return;
      if (failure || !data) throw failure || new Error("Review not saved");
      cache.set(key(match), data); close(); saved?.();
    } catch {
      if (current !== generation || !dialog.open) return;
      error.textContent = "We couldn’t save your review. Your ratings are still here—please try again."; error.hidden = false;
    } finally { if (current === generation) { busy = false; update(); } }
  }
  on(form, "change", update); on(form, "submit", save); on(retry, "click", load);
  on(document.querySelector("#match-review-close"), "click", close);
  on(document.querySelector("#match-review-cancel"), "click", close);
  on(dialog, "close", () => { if (!dialog.open) cleanup(); });
  on(dialog, "click", event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  return { open, close, reset() { close(); cache.clear(); }, destroy() { close(); cache.clear(); cleanups.forEach(fn => fn()); } };
}
