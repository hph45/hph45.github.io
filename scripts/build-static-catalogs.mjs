import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/build-static-catalogs.mjs /path/to/catalog-export.json");
const raw = await readFile(input, "utf8");
const response = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
const source = response.rows?.[0]?.catalogs;
if (!source || !Array.isArray(source.books) || !Array.isArray(source.cities)) throw new Error("Expected the reference-metadata export from scripts/export-static-catalogs.sql");
const directory = new URL("../matchmaking/data/", import.meta.url);
await mkdir(directory, { recursive: true });
const manifest = { version: 1 };
for (const kind of ["books", "cities"]) {
  const ids = new Set();
  const records = source[kind].map(row => {
    const valid = kind === "books"
      ? row.length === 3 && /^OL\d+W$/.test(row[0]) && row.slice(1).every(value => typeof value === "string" && value.trim() && value.length <= 300)
      : row.length === 6 && Number.isSafeInteger(row[0]) && row[0] > 0 && row.slice(1, 5).every(value => typeof value === "string") && Number.isSafeInteger(row[5]) && row[5] >= 0;
    if (!valid || ids.has(row[0])) throw new Error(`Invalid or duplicate ${kind} record`);
    ids.add(row[0]);
    // Explicit fields only: no profile data, query history, votes, or timestamps.
    return kind === "books" ? [row[0], row[1], row[2]] : [row[0], row[1], row[2], row[3], row[4], row[5]];
  });
  if (!records.length) throw new Error(`Refusing to publish an empty ${kind} catalog`);
  const json = JSON.stringify({ version: 1, [kind]: records }) + "\n";
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 12);
  const filename = `${kind}.${hash}.json`;
  await writeFile(new URL(filename, directory), json);
  manifest[kind] = { url: `/matchmaking/data/${filename}`, count: records.length };
  console.log(`${kind}: ${records.length.toLocaleString()} records; ${(Buffer.byteLength(json) / 1e6).toFixed(2)} MB raw, ${(gzipSync(json).length / 1e6).toFixed(2)} MB gzip`);
}
// Keep earlier content-addressed files available for already-open browser tabs.
await writeFile(new URL("manifest.json", directory), JSON.stringify(manifest, null, 2) + "\n");
