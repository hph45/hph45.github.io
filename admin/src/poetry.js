// Poems are private database content, never part of the public site bundle.
// One authorized fetch per visit; opening and closing poems is entirely local.
export function createPoetryLibrary({ client, document, onDenied, isDenied }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $("#poem-dialog"), list = $("#poetry-list");
  let poems = null, generation = 0, loading = null;
  const pending = new Set();

  function clearReader() {
    if (dialog.open) dialog.close();
    for (const id of ["poem-title", "poem-author", "poem-context", "poem-body", "poem-translation", "poem-translation-note", "poem-source"]) $(`#${id}`).replaceChildren();
    $("#poem-translation-section").hidden = true;
  }
  function clear() {
    generation++; poems = null; loading = null;
    clearReader(); list.replaceChildren(); list.removeAttribute("aria-busy");
    for (const id of ["poetry-loading", "poetry-error", "poetry-empty"]) $(`#${id}`).hidden = true;
  }
  function open(poem) {
    if (!poem) return;
    $("#poem-title").textContent = poem.title;
    $("#poem-author").textContent = poem.author;
    $("#poem-context").textContent = poem.context || "";
    $("#poem-context").hidden = !poem.context;
    $("#poem-body").textContent = poem.body;
    $("#poem-body").lang = poem.language === "es" ? "es" : "en";
    $("#poem-translation-section").hidden = !poem.translation;
    $("#poem-translation").textContent = poem.translation || "";
    $("#poem-translation-note").textContent = poem.translation_note || "";
    const source = $("#poem-source"); source.replaceChildren();
    if (poem.source_label) {
      let url;
      try { url = new URL(poem.source_url); } catch { /* A supplied text need not have a source link. */ }
      if (url?.protocol === "https:" && !url.username && !url.password) {
        const link = document.createElement("a"); link.href = url.href;
        link.textContent = poem.source_label; link.target = "_blank"; link.rel = "noopener noreferrer";
        link.setAttribute("aria-label", `${poem.source_label} (opens in a new tab)`); source.append(link);
      } else source.textContent = poem.source_label;
    }
    dialog.showModal(); dialog.scrollTop = 0;
  }
  function render() {
    const fragment = document.createDocumentFragment();
    for (const [index, poem] of poems.entries()) {
      const item = document.createElement("li"), button = document.createElement("button");
      button.type = "button"; button.dataset.poem = poem.slug;
      button.setAttribute("aria-haspopup", "dialog"); button.setAttribute("aria-controls", "poem-dialog");
      const number = document.createElement("span"); number.className = "poem-number"; number.textContent = String(index + 1).padStart(2, "0"); number.setAttribute("aria-hidden", "true");
      const label = document.createElement("span"); label.className = "poem-label";
      const title = document.createElement("span"); title.className = "poem-list-title"; title.textContent = poem.title;
      const author = document.createElement("span"); author.className = "poem-list-author"; author.textContent = poem.author;
      label.append(title, author);
      const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      arrow.setAttribute("viewBox", "0 0 24 24"); arrow.setAttribute("aria-hidden", "true"); arrow.setAttribute("focusable", "false");
      const path = document.createElementNS(arrow.namespaceURI, "path"); path.setAttribute("d", "M4 12h15m-6-6 6 6-6 6"); arrow.append(path);
      button.append(number, label, arrow); item.append(button); fragment.append(item);
    }
    list.replaceChildren(fragment); $("#poetry-empty").hidden = poems.length > 0;
  }
  function load() {
    if (poems !== null) return Promise.resolve();
    if (loading) return loading;
    const request = generation;
    $("#poetry-loading").hidden = false; $("#poetry-error").hidden = true;
    list.setAttribute("aria-busy", "true");
    const work = (async () => {
      try {
        const { data, error } = await client.rpc("get_admin_poetry");
        if (request !== generation) return;
        if (error) throw error;
        if (!Array.isArray(data) || !data.every(poem => ["slug", "title", "author", "body"].every(key => typeof poem[key] === "string"))) throw new Error("Invalid poems response");
        poems = data; render();
      } catch (error) {
        if (request !== generation) return;
        if (isDenied(error)) onDenied();
        else $("#poetry-error").hidden = false;
      } finally {
        if (request === generation) { loading = null; $("#poetry-loading").hidden = true; list.removeAttribute("aria-busy"); }
      }
    })();
    loading = work; pending.add(work); void work.finally(() => pending.delete(work));
    return work;
  }
  const choose = event => {
    const button = event.target.closest("button[data-poem]");
    if (button && list.contains(button)) open(poems?.find(poem => poem.slug === button.dataset.poem));
  };
  const close = () => dialog.close();
  const retry = () => { void load(); };
  list.addEventListener("click", choose);
  $("#close-poem").addEventListener("click", close);
  $("#retry-poetry").addEventListener("click", retry);
  return {
    load, clear,
    async settled() { while (pending.size) await Promise.all([...pending]); },
    destroy() { clear(); list.removeEventListener("click", choose); $("#close-poem").removeEventListener("click", close); $("#retry-poetry").removeEventListener("click", retry); },
  };
}
