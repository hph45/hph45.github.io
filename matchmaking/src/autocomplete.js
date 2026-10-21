// Small keyboard-accessible combobox. Each selection carries a canonical ID;
// typing again clears that ID so arbitrary text cannot be saved as a selection.
export function attachAutocomplete(input, { search, describe, onSelect, onClear, document, window, delay = 450, emptyMessage = "No results. Try another title or author." }) {
  const wrapper = document.createElement("div");
  const label = input.closest("label");
  const labelText = label && [...label.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join("").trim();
  if (labelText) input.setAttribute("aria-label", labelText);
  wrapper.className = "autocomplete";
  input.parentNode.insertBefore(wrapper, input);
  wrapper.append(input);
  const list = document.createElement("div");
  list.id = `${input.name}-suggestions`; list.className = "suggestions";
  list.setAttribute("role", "listbox"); list.hidden = true;
  const status = document.createElement("span"); status.className = "field-help"; status.setAttribute("role", "status");
  wrapper.append(list, status);
  input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id); input.setAttribute("aria-expanded", "false"); input.autocomplete = "off";
  let timer, version = 0, options = [], active = -1;
  function close() {
    version++; window.clearTimeout(timer); list.hidden = true; status.textContent = "";
    input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1;
  }
  function choose(index) {
    if (!options[index]) return;
    version++; window.clearTimeout(timer); onSelect(options[index]); close(); status.textContent = ""; input.focus();
  }
  async function run() {
    const requestVersion = ++version;
    status.textContent = "Searching…";
    try {
      const found = await search(input.value.trim());
      if (requestVersion !== version) return;
      options = found; active = -1; list.replaceChildren();
      status.textContent = found.length ? "Choose a suggestion below." : emptyMessage;
      found.forEach((item, index) => {
        const option = document.createElement("div"); option.id = `${list.id}-${index}`;
        option.setAttribute("role", "option"); option.setAttribute("aria-selected", "false");
        const [title, subtitle] = describe(item);
        const strong = document.createElement("strong"); strong.textContent = title;
        const small = document.createElement("span"); small.textContent = subtitle;
        option.append(strong, small);
        option.addEventListener("mousedown", event => event.preventDefault());
        option.addEventListener("click", () => choose(index)); list.append(option);
      });
      list.hidden = !found.length; input.setAttribute("aria-expanded", String(Boolean(found.length)));
    } catch {
      if (requestVersion === version) { close(); status.textContent = "Search is unavailable. Please try typing again in a moment."; }
    }
  }
  input.addEventListener("input", () => {
    version++; window.clearTimeout(timer); close(); onClear(); status.textContent = "";
    if (input.value.trim().length >= 2) timer = window.setTimeout(run, delay);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") { version++; window.clearTimeout(timer); close(); status.textContent = ""; }
    if (list.hidden) return;
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      [...list.children].forEach((option, index) => option.setAttribute("aria-selected", String(index === active)));
      input.setAttribute("aria-activedescendant", list.children[active].id);
    }
    if (event.key === "Enter" && active >= 0) { event.preventDefault(); choose(active); }
  });
  input.addEventListener("blur", () => { version++; window.clearTimeout(timer); close(); });
  return { close, destroy() { version++; window.clearTimeout(timer); } };
}
