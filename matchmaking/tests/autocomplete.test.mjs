import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { attachAutocomplete } from "../src/autocomplete.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test("autocomplete supports keyboard selection and clears the saved ID when typing resumes", async t => {
  const window = new Window();
  window.document.body.innerHTML = '<label>Book<input name="book"></label>';
  const input = window.document.querySelector("input");
  let selected = null;
  const control = attachAutocomplete(input, {
    document: window.document, window, delay: 0,
    search: async () => [{ work_id: "OL1W", title: "<b>A book</b>", author: "An author" }],
    describe: book => [book.title, book.author],
    onSelect(book) { selected = book.work_id; input.value = book.title; },
    onClear() { selected = null; },
  });
  t.after(async () => { control.destroy(); await window.happyDOM.close(); });
  input.value = "A bo"; input.dispatchEvent(new window.Event("input")); await tick();
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.equal(window.document.querySelector(".suggestions b"), null, "book titles remain text");
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
  assert.equal(input.getAttribute("aria-activedescendant"), "book-suggestions-0");
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  assert.equal(selected, "OL1W");
  assert.equal(input.getAttribute("aria-expanded"), "false");
  input.value = "Another"; input.dispatchEvent(new window.Event("input"));
  assert.equal(selected, null);
});

test("a slower previous autocomplete result cannot replace the latest query", async t => {
  const window = new Window(); window.document.body.innerHTML = '<input name="city">';
  const input = window.document.querySelector("input"); const responses = new Map();
  const control = attachAutocomplete(input, { document: window.document, window, delay: 0,
    search: query => new Promise(resolve => responses.set(query, resolve)),
    describe: city => [city.name, city.country], onSelect() {}, onClear() {},
  });
  t.after(async () => { control.destroy(); await window.happyDOM.close(); });
  input.value = "old"; input.dispatchEvent(new window.Event("input")); await tick();
  input.value = "new"; input.dispatchEvent(new window.Event("input")); await tick();
  responses.get("new")([{ name: "New result", country: "Somewhere" }]); await tick();
  responses.get("old")([{ name: "Old result", country: "Elsewhere" }]); await tick();
  assert.match(window.document.querySelector(".suggestions").textContent, /New result/);
  assert.doesNotMatch(window.document.querySelector(".suggestions").textContent, /Old result/);
});
