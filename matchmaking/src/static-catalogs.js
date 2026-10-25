import manifest from "../data/manifest.json" with { type: "json" };

// Only public book/city reference metadata lives in these files. Query text stays
// in the browser; profile saves still validate the selected IDs in Supabase.
function normalize(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function indexCatalog(data, kind) {
  if (data?.version !== 1 || !Array.isArray(data[kind]) || !data[kind].length) throw new Error("Catalog unavailable");
  return data[kind].map(row => {
    if (!Array.isArray(row)) throw new Error("Invalid catalog record");
    if (kind === "books") {
      const [work_id, title, author] = row;
      if (row.length !== 3 || !/^OL\d+W$/.test(work_id) || typeof title !== "string" || typeof author !== "string") throw new Error("Invalid book record");
      const name = normalize(title), by = normalize(author);
      return { value: { work_id, title, author }, name, all: `${name} ${by}`, key: `${name}\0${by}`, order: Number(work_id.slice(2, -1)) };
    }
    const [id, name, searchName, region, country, population] = row;
    if (row.length !== 6 || !Number.isSafeInteger(id) || id <= 0 || !row.slice(1, 5).every(value => typeof value === "string") || !Number.isSafeInteger(population) || population < 0) throw new Error("Invalid city record");
    const normalizedName = normalize(name);
    return { value: { id, name, region, country }, name: normalizedName, all: normalize(`${name} ${searchName} ${region} ${country}`), key: id, order: -population };
  });
}

function searchIndex(index, query, limit) {
  const words = query.split(" ");
  const found = [];
  for (const item of index) {
    if (!words.every(word => item.all.includes(word))) continue;
    const score = item.name === query ? 0 : item.name.startsWith(query) ? 1 : item.name.includes(query) ? 2 : words.every(word => item.name.includes(word)) ? 3 : 4;
    found.push({ item, score });
  }
  found.sort((a, b) => a.score - b.score || a.item.order - b.item.order || a.item.name.localeCompare(b.item.name));
  const seen = new Set(), results = [];
  for (const { item } of found) {
    // Identical title/author records need only one suggestion; cities with the
    // same name remain separate, with their region and country in the menu.
    if (seen.has(item.key)) continue;
    seen.add(item.key); results.push(item.value);
    if (results.length === limit) break;
  }
  return results;
}

export function createStaticCatalogSearch(fetch) {
  const loaded = new Map();
  function load(kind) {
    if (!loaded.has(kind)) {
      // A keystroke cancellation must not cancel a download shared by the other
      // book fields. Hashed URLs can safely use the browser's HTTP cache.
      const request = Promise.resolve().then(async () => {
        const response = await fetch(manifest[kind].url, { cache: "force-cache", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("Catalog unavailable");
        return indexCatalog(await response.json(), kind);
      }).catch(error => { loaded.delete(kind); throw error; });
      loaded.set(kind, request);
    }
    return loaded.get(kind);
  }
  async function search(kind, query, { signal } = {}) {
    if (signal?.aborted) throw new Error("Search cancelled");
    const normalized = normalize(query.slice(0, 120));
    if (normalized.length < 2) return [];
    const index = await load(kind);
    if (signal?.aborted) throw new Error("Search cancelled");
    return searchIndex(index, normalized, kind === "books" ? 8 : 12);
  }
  return {
    books: (query, options) => search("books", query, options),
    cities: (query, options) => search("cities", query, options),
    preloadBooks: () => load("books"),
    preloadCities: () => load("cities"),
  };
}
