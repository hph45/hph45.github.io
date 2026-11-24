import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { geoGraticule, geoPath } from "d3-geo";
import { COUNTRY_SHAPES } from "../matchmaking/src/country-shapes.js";
import { worldProjection } from "../matchmaking/src/map.js";

export const STATS_PAGES = ["community-stats/index.html", "press/index.html"];
const snapshotFile = "assets/community-stats.json";
const mapFile = "assets/community-readers-map.svg";
const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", month: "long", day: "numeric", year: "numeric",
});
const validCount = value => Number.isSafeInteger(value) && value >= 0;

function validTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace("Z", ".000Z");
}

// Copy only the public aggregates and the catalog points needed to draw small regions.
export function parseCommunityStats(input) {
  const row = Array.isArray(input?.rows) && input.rows.length === 1 ? input.rows[0] : input;
  if (row?.methodology_version !== 2 || !validTimestamp(row.measured_at) || !validCount(row.active_accounts)
      || !validCount(row.matches_made) || !validCount(row.reader_country_count)
      || !Array.isArray(row.reader_countries) || row.reader_countries.length !== row.reader_country_count) {
    throw new Error("Invalid community statistics snapshot.");
  }
  const names = new Set();
  const countries = row.reader_countries.map(({ country, latitude, longitude }) => {
    if (typeof country !== "string" || !country.trim() || country.length > 200 || names.has(country)
        || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      throw new Error("Invalid or duplicate reader country.");
    }
    names.add(country);
    return { country, latitude, longitude };
  });
  return {
    methodology_version: 2, measured_at: row.measured_at, active_accounts: row.active_accounts,
    reader_country_count: row.reader_country_count, reader_countries: countries, matches_made: row.matches_made,
  };
}

export function renderStatsHtml(html, input) {
  const stats = parseCommunityStats(input);
  const fragments = {
    date: `<time datetime="${stats.measured_at}">${dateFormat.format(new Date(stats.measured_at))}</time>`,
    active_accounts: stats.active_accounts.toLocaleString("en-US"),
    reader_country_count: stats.reader_country_count.toLocaleString("en-US"),
    matches_made: stats.matches_made.toLocaleString("en-US"),
  };
  let replaced = 0;
  const result = html.replace(/<!-- stats:(\w+) -->[\s\S]*?<!-- \/stats:\1 -->/g, (_, key) => {
    if (!Object.hasOwn(fragments, key)) throw new Error(`Unknown statistics marker: ${key}`);
    replaced++;
    return `<!-- stats:${key} -->${fragments[key]}<!-- /stats:${key} -->`;
  });
  if (!replaced || (html.match(/<!-- stats:/g) || []).length !== replaced) throw new Error("Missing or malformed community-statistics markers.");
  return result;
}

export function renderReaderMap(countries) {
  const represented = new Set(countries.map(location => location.country));
  const outlined = new Set(COUNTRY_SHAPES.map(shape => shape.country));
  const projection = worldProjection();
  const grid = geoGraticule().extent([[-180, -59], [180, 84]]).step([30, 30]);
  const chart = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="435" viewBox="0 12 1000 435">',
    '<title>Countries and territories with Zebra readers</title>',
    '<!-- World boundaries: Natural Earth (public domain). Small-region locations: GeoNames, CC BY 4.0, https://www.geonames.org/ -->',
    `<path d="${geoPath(projection).digits(1)(grid())}" fill="none" stroke="#526b5f" stroke-width="0.9"/>`,
    '<g stroke="#264638" stroke-width="1.1" stroke-linejoin="round">',
  ];
  for (const shape of COUNTRY_SHAPES) {
    if (shape.country === "Antarctica") continue;
    const fill = represented.has(shape.country) ? "#e4dca6" : "#718879";
    chart.push(`<path fill="${fill}" d="${shape.path}"/>`);
  }
  chart.push('</g><g fill="#e4dca6" stroke="#213f34" stroke-width="1.1">');
  for (const location of countries) {
    if (outlined.has(location.country)) continue;
    const [x, y] = projection([location.longitude, location.latitude]);
    chart.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.4"/>`);
  }
  chart.push('</g></svg>');
  return chart.join("\n") + "\n";
}

export async function refreshCommunityStats(root, input, { now = Date.now() } = {}) {
  const stats = parseCommunityStats(input);
  const measured = Date.parse(stats.measured_at);
  if (measured > now + 5 * 60_000 || measured < now - 24 * 60 * 60_000) throw new Error("Use a database snapshot from the last 24 hours; future snapshots are invalid.");
  // Version 1 only contained an account count. Its timestamp still guards against a stale update.
  try {
    const previous = JSON.parse(await readFile(join(root, snapshotFile), "utf8"));
    if (!validTimestamp(previous.measured_at)) throw new Error("Cannot read the previous snapshot timestamp.");
    if (Date.parse(previous.measured_at) > measured) throw new Error("Refusing to replace a newer snapshot with an older one.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const writes = new Map();
  const sitemap = await readFile(join(root, "sitemap.xml"), "utf8");
  let updatedSitemap = sitemap;
  for (const page of STATS_PAGES) {
    const html = await readFile(join(root, page), "utf8");
    const updated = renderStatsHtml(html, stats);
    if (html === updated) continue;
    writes.set(page, updated);
    const path = page.replace(/index\.html$/, "");
    const entry = `<url><loc>https://zebrabookclub.com/${path}</loc>`;
    const start = updatedSitemap.indexOf(entry);
    const end = updatedSitemap.indexOf("</url>", start);
    if (start < 0 || end < 0) throw new Error(`Missing sitemap entry for ${page}`);
    const date = new Date(now).toISOString().slice(0, 10);
    updatedSitemap = updatedSitemap.slice(0, start) + `${entry}<lastmod>${date}</lastmod>` + updatedSitemap.slice(end);
  }
  if (updatedSitemap !== sitemap) writes.set("sitemap.xml", updatedSitemap);
  writes.set(mapFile, renderReaderMap(stats.reader_countries));
  writes.set(snapshotFile, JSON.stringify(stats, null, 2) + "\n");
  for (const [file, content] of writes) {
    const path = join(root, file);
    await writeFile(`${path}.tmp`, content);
    await rename(`${path}.tmp`, path);
  }
  return stats;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length !== 3) throw new Error("Usage: npm run refresh:stats -- /path/to/aggregate-query.json");
  const source = await readFile(inputPath, "utf8");
  const input = JSON.parse(source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1));
  const stats = await refreshCommunityStats(process.cwd(), input);
  console.log(`Prepared ${stats.active_accounts} active accounts, ${stats.reader_country_count} countries and territories, and ${stats.matches_made} matches as of ${stats.measured_at}.`);
}
