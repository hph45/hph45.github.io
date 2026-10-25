import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createStaticCatalogSearch } from "../src/static-catalogs.js";
import manifest from "../data/manifest.json" with { type: "json" };

const books = [
  ["OL1W", "Pride and Prejudice", "Jane Austen"],
  ["OL2W", "Pride and Prejudice", "Another author"],
  ["OL3W", "Pride and Prejudice and Zombies", "Seth Grahame-Smith"],
  ["OL4W", "Jane Eyre", "Charlotte Brontë"],
  ["OL5W", "Мастер и Маргарита", "Михаил Булгаков"],
  ["OL6W", "Pride and Prejudice", "Jane Austen"],
];
const cities = [
  [2964574, "Dublin", "dublin", "Leinster", "Ireland", 1024027],
  [5344157, "Dublin", "dublin", "California", "United States", 57721],
  [3448439, "São Paulo", "sao paulo", "São Paulo", "Brazil", 12400232],
];
const response = data => ({ ok: true, json: async () => data });

test("local search preserves work IDs, matches title/author and accents, and keeps distinct authors/cities", async () => {
  const calls = [];
  const search = createStaticCatalogSearch(async (url, options) => {
    calls.push({ url, options });
    return response({ version: 1, books, cities });
  });
  assert.deepEqual(await search.books("!"), []);
  assert.equal(calls.length, 0, "a blank/short query does not download a catalog");
  assert.deepEqual((await search.books("pride, Austen")).map(book => book.work_id), ["OL1W"]);
  assert.deepEqual((await search.books("pride and prejudice")).map(book => book.work_id), ["OL1W", "OL2W", "OL3W"]);
  assert.equal((await search.books("bronte"))[0].title, "Jane Eyre");
  assert.equal((await search.books("мастер"))[0].work_id, "OL5W");
  assert.deepEqual((await search.cities("dublin")).map(city => city.country), ["Ireland", "United States"]);
  assert.equal((await search.cities("dublin california"))[0].id, 5344157);
  assert.equal((await search.cities("sao paulo brazil"))[0].name, "São Paulo");
  assert.deepEqual(calls.map(call => call.url), [manifest.books.url, manifest.cities.url]);
  assert.ok(calls.every(call => call.options.cache === "force-cache"));
  assert.ok(calls.every(call => !call.url.includes("query") && !call.options.body), "queries never leave the browser");
});

test("concurrent fields share one download and cancelling one query does not cancel other fields", async () => {
  let finish, downloadSignal, requests = 0;
  const search = createStaticCatalogSearch(async (_url, options) => {
    requests++; downloadSignal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const controller = new AbortController();
  const preloaded = search.preloadBooks();
  const cancelled = search.books("pride", { signal: controller.signal });
  const current = search.books("jane eyre");
  await Promise.resolve();
  controller.abort();
  assert.equal(downloadSignal.aborted, false);
  finish(response({ version: 1, books }));
  await assert.rejects(cancelled, /cancelled/);
  assert.equal((await current)[0].work_id, "OL4W");
  await preloaded;
  await search.books("austen");
  assert.equal(requests, 1);
  await assert.rejects(search.cities("dublin", { signal: controller.signal }), /cancelled/);
  assert.equal(requests, 1, "already cancelled searches make no request");
});

test("a failed or invalid static download can retry without contacting a search service", async () => {
  for (const failure of [() => { throw new Error("Offline"); }, () => ({ ok: false }), () => response({ version: 1, books: [["ZBprivate", "Private manual text", "Unknown author"]] })]) {
    let calls = 0;
    const search = createStaticCatalogSearch(async () => ++calls === 1 ? failure() : response({ version: 1, books }));
    await assert.rejects(search.books("jane"));
    assert.equal((await search.books("eyre"))[0].work_id, "OL4W");
    assert.equal(calls, 2);
  }
});

test("shipped catalogs match their content hashes and contain reference metadata only", async () => {
  const catalogs = {};
  for (const kind of ["books", "cities"]) {
    const json = await readFile(new URL(`../..${manifest[kind].url}`, import.meta.url), "utf8");
    const hash = createHash("sha256").update(json).digest("hex").slice(0, 12);
    assert.ok(manifest[kind].url.endsWith(`.${hash}.json`));
    const data = JSON.parse(json);
    assert.deepEqual(Object.keys(data), ["version", kind]);
    assert.equal(data[kind].length, manifest[kind].count);
    assert.equal(new Set(data[kind].map(row => row[0])).size, data[kind].length);
    assert.ok(data[kind].every(row => row.length === (kind === "books" ? 3 : 6)));
    if (kind === "books") assert.ok(data.books.every(row => /^OL\d+W$/.test(row[0])), "no manually entered member text is published");
    catalogs[manifest[kind].url] = data;
  }
  const search = createStaticCatalogSearch(async url => response(catalogs[url]));
  assert.equal((await search.books("east of eden"))[0].work_id, "OL23166W");
  assert.equal((await search.cities("dublin ireland"))[0].id, 2964574);
});
