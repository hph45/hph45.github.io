import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { createReviewCatalog } from "../src/review-catalog.js";
import { renderRisingBooks } from "../src/rising-books.js";

const catalog = createReviewCatalog(...await Promise.all(["reviews.csv", "book_club_current.csv", "assets/review-covers/sources.csv", "matchmaking/books.csv"].map(file => readFile(new URL(`../../${file}`, import.meta.url), "utf8"))));
function setup(t) {
  const window = new Window({ url: "http://localhost:8080/matchmaking/" });
  t.after(() => window.happyDOM.close());
  window.document.body.innerHTML = '<ol id="rising-books-list"></ol><p id="rising-books-status"></p>';
  return window.document;
}
test("two rising favorites reuse affiliate covers, exclude Top Ten, and display ranks beside SVG flames", async t => {
  const document = setup(t);
  const books = [
    { work_id: "OL100672W", title: "Candide", author: "Voltaire" },
    { work_id: "OL42543873W", title: "Alchemised", author: "SenLinYu" },
    { work_id: "OL42543873W", title: "A duplicate", author: "SenLinYu" },
    { work_id: "OL1W", title: "<script>A new book</script>", author: "An author" },
    { work_id: "OL2W", title: "Third candidate", author: "An author" },
  ];
  await renderRisingBooks(document, books, [books[0]], catalog);
  const links = [...document.querySelectorAll("li a")];
  assert.equal(links.length, 2);
  assert.equal(links[0].href, "https://link.amazon/B03RDERzW");
  assert.equal(links[0].rel, "sponsored noopener noreferrer");
  assert.equal(links[0].querySelector("img").getAttribute("src"), "/assets/matchmaking-covers/alchemised.jpg");
  assert.equal(links[0].querySelector(".rising-book-rank").textContent, "Rising favorite 1");
  assert.equal(links[1].querySelector(".rising-book-rank").textContent, "Rising favorite 2");
  assert.match(links[1].href, /^https:\/\/www.amazon.com\/s\?/);
  assert.equal(links[1].querySelector("img").hidden, true);
  assert.equal(document.querySelector("script"), null);
  assert.equal(links[1].querySelector("img").getAttribute("src"), null);
  for (const link of links) {
    assert.match(link.querySelector("svg use").getAttribute("href"), /#flame$/);
    assert.equal(link.querySelector("svg").getAttribute("aria-hidden"), "true");
    assert.doesNotMatch(link.textContent, /new favorites|\p{Extended_Pictographic}/u);
  }
  assert.equal(document.querySelector("#rising-books-status").hidden, true);
});
test("empty results are honest and refresh removes stale rising rows", async t => {
  const document = setup(t);
  renderRisingBooks(document, [{ work_id: "OL1W", title: "A book", author: "An author" }], [], catalog);
  const image = document.querySelector("img");
  renderRisingBooks(document, [], [], catalog);
  assert.equal(document.querySelectorAll("li").length, 0);
  assert.equal(image.getAttribute("src"), null);
  assert.equal(document.querySelector("#rising-books-status").hidden, false);
});
