import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { countryBookPresentation } from "../src/country-books.js";
import catalog from "../data/country-books.json" with { type: "json" };

test("country books have local image files, public reference metadata, and affiliate destinations", async () => {
  for (const book of catalog.books) {
    assert.ok(book.work_ids.every(id => /^OL\d+W$/.test(id)), "no private member/book identifiers in the asset catalog");
    assert.match(book.cover, /^\/assets\/matchmaking-covers\/[a-z0-9-]+\.(jpg|png)$/);
    const bytes = await readFile(new URL(`../..${book.cover}`, import.meta.url));
    assert.ok(["ffd8ff", "89504e"].includes(bytes.subarray(0, 3).toString("hex")), book.title);
    assert.equal(new URL(book.source_url).protocol, "https:");
    for (const favorite of [book, ...(book.aliases || [])]) {
      const result = countryBookPresentation(favorite, []);
      assert.equal(result.cover, book.cover, book.title);
      assert.equal(new URL(result.url).hostname, "www.amazon.com");
      assert.equal(new URL(result.url).searchParams.get("tag"), "zebrabookclub-20");
    }
  }
});

test("country links preserve curated affiliate links and show uncertainty without changing favorites", () => {
  const book = { work_id: "OL5782000W", title: "A Thousand Splendid Suns", author: "Khaled Hosseini" };
  const result = countryBookPresentation(book, [{ ...book, workIDs: [book.work_id], cover: "/assets/review-covers/custom.jpg", amazon: "https://link.amazon/kept" }]);
  assert.equal(result.url, "https://link.amazon/kept");
  assert.equal(result.cover, "/assets/review-covers/custom.jpg");
  const ambiguous = { title: "Belladonna", author: "Unknown author" }, before = structuredClone(ambiguous);
  const closest = countryBookPresentation(ambiguous, []);
  assert.equal(closest.approximate, true);
  assert.equal(new URL(closest.url).pathname, "/s");
  assert.equal(new URL(closest.url).searchParams.get("k"), "Belladonna");
  assert.deepEqual(ambiguous, before);
  const unknown = countryBookPresentation({ title: '<a>new & book</a>', author: "New author" }, []);
  assert.equal(unknown.cover, "");
  assert.equal(new URL(unknown.url).searchParams.get("k"), '<a>new & book</a> New author');
  assert.equal(new URL(unknown.url).searchParams.get("tag"), "zebrabookclub-20");
});

test("series use the first book's artwork without changing the favorite or its curated link", () => {
  for (const entry of catalog.books.filter(book => book.first_book)) {
    const book = { work_id: entry.work_ids[0], title: entry.title, author: entry.author, votes: 7 };
    const before = structuredClone(book);
    const result = countryBookPresentation(book, [{ ...book, workIDs: entry.work_ids, cover: "/assets/old-box-set.jpg", amazon: "https://link.amazon/kept" }]);
    assert.equal(result.cover, entry.cover);
    assert.equal(result.coverTitle, entry.first_book.title);
    assert.equal(result.url, "https://link.amazon/kept");
    assert.deepEqual(book, before);
  }
});
