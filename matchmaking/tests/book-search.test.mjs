import test from "node:test";
import assert from "node:assert/strict";
import { createBookSearchHandler, normalizeBooks } from "../../supabase/functions/search-books/handler.ts";

test("book search accepts only work IDs and deduplicates editions of a work", () => {
  const books = normalizeBooks({ docs: [
    { key: "/works/OL1W", title: "A book", author_name: ["One", "Two"] },
    { key: "/works/OL1W", title: "A book", author_name: ["One", "Two"] },
    { key: "/books/OL99M", title: "An edition" },
    { key: "https://untrusted.example", title: "Bad ID" },
    { key: "/works/OL2W", title: "Another book" },
  ] });
  assert.deepEqual(books, [{ work_id: "OL1W", title: "A book", author: "One, Two" }, { work_id: "OL2W", title: "Another book", author: "Unknown author" }]);
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
