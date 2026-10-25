import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { bookPresentation, createReviewCatalog, loadReviewCatalog, parseCsv } from "../src/review-catalog.js";
import { renderTopBooks } from "../src/top-books.js";

const catalog = createReviewCatalog(...await Promise.all(["reviews.csv", "book_club_current.csv", "assets/review-covers/sources.csv", "matchmaking/books.csv"].map(file => readFile(new URL(`../../${file}`, import.meta.url), "utf8"))));
const curatedWorkIDs = new Set(parseCsv(await readFile(new URL("../books.csv", import.meta.url), "utf8")).slice(1).map(row => row[0]));

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

test("curated favorites use the supplied Amazon short links and local covers", () => {
  for (const [work_id, title, author, slug, link] of [
    ["OL1095427W", "Jane Eyre", "Charlotte Brontë", "jane-eyre", "B095C7mY1"],
    ["OL42543873W", "Alchemised", "SenLinYu", "alchemised", "B03RDERzW"],
  ]) {
    assert.deepEqual(bookPresentation({ work_id, title, author }, catalog), { cover: `/assets/matchmaking-covers/${slug}.jpg`, url: `https://link.amazon/${link}`, affiliate: true });
  }
});

test("a curated link can reuse a review cover, while invalid destinations keep the fallback", () => {
  const reviews = createReviewCatalog('51,Pierce Brown,Iron Gold,,,,', "", "", [
    'work_id,title,author,amazon_url,cover',
    'OL19726995W,Iron Gold,Pierce Brown,https://link.amazon/example,',
    'OL1W,Unreviewed book,An author,https://link.amazon.evil.example/book,https://untrusted.example/cover.jpg',
  ].join('\n'));
  assert.equal(reviews.length, 2, "the reviewed work is enriched instead of duplicated");
  const book = { work_id: 'OL19726995W', title: 'Iron Gold', author: 'Pierce Brown' };
  assert.deepEqual(bookPresentation(book, reviews), { cover: '/assets/review-covers/review-51.jpg', url: 'https://link.amazon/example', affiliate: true });
  assert.equal(bookPresentation({ ...book, work_id: 'OL2W' }, reviews).affiliate, true, "title-and-author matching still works");
  const unknown = bookPresentation({ work_id: 'OL1W', title: 'Unreviewed book', author: 'An author' }, reviews);
  assert.equal(unknown.affiliate, false);
  assert.equal(unknown.cover, '');
  assert.equal(new URL(unknown.url).origin, 'https://www.amazon.com');
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

test("every curated book has a downloaded JPEG and an affiliate destination, including the Top 20 additions", async () => {
  for (const entry of catalog.filter(entry => entry.workIDs.some(id => curatedWorkIDs.has(id)))) {
    assert.ok(entry.amazon, entry.title);
    const cover = await readFile(new URL(`../..${entry.cover.split("?")[0]}`, import.meta.url));
    assert.equal(cover.subarray(0, 3).toString("hex"), "ffd8ff", entry.title);
  }
  for (const [work_id, asin] of [["OL23166W", "0142004235"], ["OL29983W", "0140390693"], ["OL20150260W", "1984822187"], ["OL18203673W", "1501161938"], ["OL16821606W", "1501173219"], ["OL17332479W", "125007696X"], ["OL16509148W", "0062060627"]]) {
    const presentation = bookPresentation({ work_id }, catalog);
    assert.equal(presentation.affiliate, true);
    assert.equal(new URL(presentation.url).searchParams.get("tag"), "zebrabookclub-20");
    assert.ok(new URL(presentation.url).pathname.startsWith(`/dp/${asin}/`));
    assert.ok(presentation.cover.startsWith("/assets/matchmaking-covers/"));
  }
});

test("ranked rows are accessible Amazon links and gracefully handle missing or failed covers", async t => {
  const window = new Window({ url: "http://localhost:8080/matchmaking/" });
  t.after(() => window.happyDOM.close());
  const { document } = window;
  document.body.innerHTML = '<ol id="top-books-list"></ol>';
  await renderTopBooks(document, [
    { work_id: "OL100672W", title: "Candide", author: "Voltaire", votes: 3 },
    { work_id: "OL1W", title: "<script>unsafe()</script>", author: "An author", votes: 1 },
    { work_id: "OL2W", title: "A book without a cover", author: "An author", votes: 1 },
  ], catalog);
  const links = [...document.querySelectorAll("li > a")];
  assert.equal(links.length, 3);
  assert.equal(links[0].href, "https://amzn.to/4rPwHAq");
  assert.equal(links[0].rel, "sponsored noopener noreferrer");
  assert.equal(links[0].target, "_blank");
  assert.equal(links[0].tabIndex, 0);
  assert.match(links[0].textContent, /3 favorites.*opens in a new tab/);
  assert.equal(links[1].querySelector(".book-votes").textContent, "1 favorite");
  assert.equal(links[0].querySelector("img").getAttribute("src"), "/assets/review-covers/review-01.jpg");
  assert.equal(links[1].querySelector("img").getAttribute("src"), null);
  assert.equal(links[1].querySelector("script"), null);
  assert.match(links[1].textContent, /<script>unsafe/);
  assert.equal(links[2].querySelector("img").hidden, true);
  const failed = links[0].querySelector("img");
  failed.dispatchEvent(new window.Event("error"));
  assert.equal(failed.hidden, true);
  assert.equal(failed.getAttribute("src"), "/assets/review-covers/review-01.jpg", "a failed image never switches to an external cover provider");
});

test("refresh replaces the shelf, keeps only ten rows, and clears stale covers", async t => {
  const window = new Window({ url: "http://localhost:8080/matchmaking/" });
  t.after(() => window.happyDOM.close());
  const { document } = window;
  document.body.innerHTML = '<ol id="top-books-list"></ol>';
  renderTopBooks(document, Array.from({ length: 20 }, (_, i) => ({ work_id: `OL${i}W`, title: `Book ${i}`, author: "An author", votes: 1 })), []);
  assert.equal(document.querySelectorAll("li").length, 10);
  renderTopBooks(document, [], []);
  assert.equal(document.querySelector("#top-books-list").children.length, 0);
});
