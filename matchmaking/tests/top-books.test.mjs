import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { bookPresentation, createReviewCatalog, loadReviewCatalog } from "../src/review-catalog.js";
import { coverURL, createCoverLookup, renderTopBooks } from "../src/top-books.js";

const catalog = createReviewCatalog(...await Promise.all(["reviews.csv", "book_club_current.csv", "assets/review-covers/sources.csv"].map(file => readFile(new URL(`../../${file}`, import.meta.url), "utf8"))));

test("current favorites reuse their review covers and exact affiliate links, including original-language work IDs", () => {
  const examples = [
    ["OL100672W", "Candide", "Voltaire", "01", "4rPwHAq"],
    ["OL24593432W", "Dungeon Crawler Carl", "Matt Dinniman", "54", "4hIrXe9"],
    ["OL36287W", "Le Comte de Monte-Cristo", "Alexandre Dumas", "21", "3PfRXBk"],
    ["OL10263W", "Le petit prince", "Antoine de Saint-Exupéry", "03", "3OfAzwe"],
    ["OL17076473W", "Red Rising", "Pierce Brown", "33", "4xeCJ0q"],
    ["OL676009W", "Мастер и Маргарита", "Михаил Афанасьевич Булгаков", "05", "4spZqfp"],
  ];
  for (const [work_id, title, author, episode, link] of examples) {
    assert.deepEqual(bookPresentation({ work_id, title, author }, catalog), { cover: `/assets/review-covers/review-${episode}.jpg`, url: `https://amzn.to/${link}`, affiliate: true });
  }
});

test("title matching respects authors and non-Latin text; unknown books get a safely encoded Amazon search", () => {
  const reviews = createReviewCatalog('1,Автор,Первая книга,,,,https://amzn.to/example\r\n2,José Author,"A Book, with ""Quotes""",,,,https://www.amazon.com/dp/example?tag=club-20\r\n3,An Author,Unsafe link,,,,javascript:alert(1)', "", "");
  assert.equal(bookPresentation({ title: 'a book with quotes', author: 'Jose Author' }, reviews).affiliate, true);
  assert.equal(bookPresentation({ title: "Первая книга", author: "Автор" }, reviews).affiliate, true);
  for (const book of [
    { title: "Вторая книга", author: "Автор" },
    { title: 'A Book, with "Quotes"', author: 'Different Author' },
    { title: "Unsafe link", author: "An Author" },
    { title: '<script> & a title', author: 'An author / ?' },
  ]) {
    const result = bookPresentation(book, reviews), url = new URL(result.url);
    assert.equal(result.affiliate, false);
    assert.equal(url.origin, "https://www.amazon.com");
    assert.equal(url.searchParams.get("k"), `${book.title} ${book.author}`);
  }
});

test("an unavailable review file does not prevent the remaining catalog or search fallback", async () => {
  const reviews = await loadReviewCatalog(async url => {
    if (url === "/reviews.csv") return { ok: true, text: async () => '1,Voltaire,Candide,,,,https://amzn.to/example' };
    throw new Error("Unavailable");
  });
  assert.equal(bookPresentation({ title: "Candide", author: "Voltaire" }, reviews).url, "https://amzn.to/example");
  assert.equal(bookPresentation({ title: "A new book", author: "An author" }, reviews).affiliate, false);
});

test("cover lookup retries throttling, serializes requests, and reuses the exact work's result", async () => {
  const calls = [];
  let active = 0, maximumActive = 0;
  const lookup = createCoverLookup({ functions: { invoke: async (name, { body }) => {
    assert.equal(name, "search-books");
    calls.push(body.work_id); active++; maximumActive = Math.max(maximumActive, active);
    await Promise.resolve(); active--;
    if (calls.length === 1) return { error: { context: { status: 429 } } };
    return { data: { books: [{ work_id: "OL1W", cover_id: 1234 }] }, error: null };
  } } }, { setTimeout: callback => callback() });
  const one = lookup("OL1W"), repeated = lookup("OL1W"), other = lookup("OL2W");
  assert.equal(one, repeated);
  assert.deepEqual(await Promise.all([one, repeated, other, lookup("bad")]), [coverURL(1234), coverURL(1234), "", ""]);
  assert.deepEqual(calls, ["OL1W", "OL1W", "OL2W"]);
  assert.equal(maximumActive, 1);
  assert.equal(coverURL(-1), "");
});

test("ranked rows are accessible Amazon links and gracefully handle missing or failed covers", async t => {
  const window = new Window({ url: "http://localhost:8080/matchmaking/" });
  t.after(() => window.happyDOM.close());
  const { document } = window;
  document.body.innerHTML = '<ol id="top-books-list"></ol>';
  const requested = [];
  await renderTopBooks(document, [
    { work_id: "OL100672W", title: "Candide", author: "Voltaire", votes: 3 },
    { work_id: "OL1W", title: "<script>unsafe()</script>", author: "An author", votes: 1 },
    { work_id: "OL2W", title: "A book without a cover", author: "An author", votes: 1 },
  ], catalog, async id => { requested.push(id); return id === "OL2W" ? "" : coverURL(1234); });
  const links = [...document.querySelectorAll("li > a")];
  assert.equal(links.length, 3);
  assert.equal(links[0].href, "https://amzn.to/4rPwHAq");
  assert.equal(links[0].rel, "sponsored noopener noreferrer");
  assert.equal(links[0].target, "_blank");
  assert.equal(links[0].tabIndex, 0);
  assert.match(links[0].textContent, /3 readers.*opens in a new tab/);
  assert.equal(links[0].querySelector("img").getAttribute("src"), "/assets/review-covers/review-01.jpg");
  assert.equal(links[1].querySelector("img").src, coverURL(1234));
  assert.equal(links[1].querySelector("script"), null);
  assert.match(links[1].textContent, /<script>unsafe/);
  assert.equal(links[2].querySelector("img").hidden, true);
  assert.deepEqual(requested, ["OL1W", "OL2W"]);
  const failed = links[0].querySelector("img");
  failed.dispatchEvent(new window.Event("error"));
  await Promise.resolve();
  assert.equal(failed.src, coverURL(1234));
  failed.dispatchEvent(new window.Event("error"));
  assert.equal(failed.hidden, true);
  assert.deepEqual(requested, ["OL1W", "OL2W", "OL100672W"], "a missing fallback cover does not retry endlessly");
});

test("a delayed cover response cannot restore rows removed on refresh or sign-out", async t => {
  const window = new Window({ url: "http://localhost:8080/matchmaking/" });
  t.after(() => window.happyDOM.close());
  const { document } = window;
  document.body.innerHTML = '<ol id="top-books-list"></ol>';
  let resolveCover;
  const pending = renderTopBooks(document, [{ work_id: "OL1W", title: "A book", author: "An author", votes: 1 }], [], () => new Promise(resolve => { resolveCover = resolve; }));
  const image = document.querySelector("img");
  await renderTopBooks(document, [], [], () => "");
  resolveCover(coverURL(1234));
  await pending;
  assert.equal(document.querySelector("#top-books-list").children.length, 0);
  assert.equal(image.getAttribute("src"), null);
});
