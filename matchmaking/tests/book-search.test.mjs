import test from "node:test";
import assert from "node:assert/strict";
import { createBookSearchHandler, normalizeBooks } from "../../supabase/functions/search-books/handler.ts";

test("book search accepts only work IDs and deduplicates editions of a work", () => {
  const books = normalizeBooks({ docs: [
    { key: "/works/OL1W", title: "A book", author_name: ["One", "Two"], cover_i: 1234 },
    { key: "/works/OL1W", title: "A book", author_name: ["One", "Two"], cover_i: 1234 },
    { key: "/books/OL99M", title: "An edition" },
    { key: "https://untrusted.example", title: "Bad ID" },
    { key: "/works/OL2W", title: "Another book" },
  ] });
  assert.deepEqual(books, [{ work_id: "OL1W", title: "A book", author: "One, Two", cover_id: 1234 }, { work_id: "OL2W", title: "Another book", author: "Unknown author", cover_id: null }]);
});

test("stored suggestions survive rate limits, cache outages, and provider failures without losing cover metadata", async () => {
  const stored = { work_id: "OL1W", title: "A book", author: "An author", cover_id: null };
  for (const failure of ["busy", "provider", "cache", "none"]) {
    const handle = createBookSearchHandler({
      authenticate: async () => true,
      cached: async () => { if (failure === "cache") throw new Error("Cache down"); return null; },
      catalog: async () => [stored],
      reserve: async () => failure !== "busy",
      search: async () => { if (failure === "provider") throw new Error("Provider down"); return { docs: [{ key: "/works/OL1W", title: "A book", author_name: ["An author"], cover_i: 123 }] }; },
      save: async () => {},
    });
    const response = await handle(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer valid", origin: "https://zebrabookclub.com" }, body: JSON.stringify({ query: "a book" }) }));
    assert.equal(response.status, 200, failure);
    const result = await response.json();
    assert.equal(result.books.length, 1);
    assert.equal(result.books[0].cover_id, ["busy", "provider"].includes(failure) ? null : 123);
  }
});

test("only positive integer cover IDs are accepted from the book provider", () => {
  const books = normalizeBooks({ docs: [-1, 0, 2.5, "1234", "https://example.test/cover.jpg", 1234].map((cover_i, index) => ({ key: `/works/OL${index}W`, title: "A book", cover_i })) });
  assert.deepEqual(books.map(book => book.cover_id), [null, null, null, null, null, 1234]);
});

test("book lookup authenticates, caches canonical records, and honors the shared rate limit", async () => {
  let searches = 0, reserves = 0, allowed = true;
  const cache = new Map();
  const handle = createBookSearchHandler({
    authenticate: async token => token === "valid",
    cached: async query => cache.get(query) || null,
    reserve: async () => { reserves++; return allowed; },
    search: async () => { searches++; return { docs: [{ key: "/works/OL1W", title: "A book", author_name: ["An author"] }] }; },
    save: async (query, books) => cache.set(query, books),
  });
  const request = (query, token = "valid") => handle(new Request("https://example.test", { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://zebrabookclub.com" }, body: JSON.stringify({ query }) }));
  assert.equal((await request("A book", "invalid")).status, 401);
  assert.equal((await request("a")).status, 400);
  assert.equal(searches, 0);
  assert.equal((await request(" A  Book ")).status, 200);
  assert.equal(cache.get("a book")[0].work_id, "OL1W");
  allowed = false;
  assert.equal((await request("a book")).status, 200);
  assert.equal(searches, 1); assert.equal(reserves, 1);
  assert.equal((await request("another book")).status, 429);
  assert.equal(searches, 1);
});

test("exact work lookups authenticate, reject malformed IDs, and cache cover metadata", async () => {
  const queries = [], cache = new Map();
  const handle = createBookSearchHandler({
    authenticate: async token => token === "valid",
    cached: async query => cache.get(query) || null,
    reserve: async () => true,
    search: async query => { queries.push(query); return { docs: [{ key: "/works/OL123W", title: "A book", cover_i: 5678 }] }; },
    save: async (query, books) => cache.set(query, books),
  });
  const request = (work_id, token = "valid") => handle(new Request("https://example.test", { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://zebrabookclub.com" }, body: JSON.stringify({ work_id }) }));
  assert.equal((await request("OL123W", "invalid")).status, 401);
  for (const id of [null, 123, "OL123M", "ol123w", "OL123W OR *:*", "/works/OL123W"]) assert.equal((await request(id)).status, 400);
  assert.equal(queries.length, 0);
  const response = await request("OL123W");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).books[0].cover_id, 5678);
  assert.equal((await request("OL123W")).status, 200);
  assert.deepEqual(queries, ["key:/works/OL123W"], "work IDs stay case-sensitive and cached");
});
