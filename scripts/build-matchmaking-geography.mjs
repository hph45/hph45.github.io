// Inputs: GeoNames cities15000.txt, admin1CodesASCII.txt, Natural Earth countries GeoJSON.
// The resulting migration is a snapshot; do not regenerate a migration after applying it.
import { readFile, writeFile } from "node:fs/promises";
import { geoPath } from "d3-geo";
import { worldProjection } from "../matchmaking/src/map.js";

const [citiesFile, regionsFile, countriesFile] = process.argv.slice(2);
if (!countriesFile) throw new Error("Usage: node scripts/build-matchmaking-geography.mjs cities15000.txt admin1CodesASCII.txt countries.geojson");
const regions = new Map((await readFile(regionsFile, "utf8")).trim().split("\n").map(line => { const [id, name] = line.split("\t"); return [id, name]; }));
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const cities = (await readFile(citiesFile, "utf8")).trim().split("\n").map(line => {
  const values = line.split("\t");
  const [id, name, ascii, , latitude, longitude, , , country, , region, , , , population] = values;
  if (!/^\d+$/.test(id) || !/^[A-Z]{2}$/.test(country) || !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) throw new Error("Invalid geographic record");
  return `(${Number(id)},${quote(name)},${quote(ascii.toLowerCase())},${quote(regions.get(`${country}.${region}`) || "")},${quote(countryNames.of(country))},${Number(latitude)},${Number(longitude)},${Number(population) || 0})`;
});
let sql = `-- GeoNames cities15000 snapshot, downloaded 2026-10-21. CC BY 4.0.\n-- https://www.geonames.org/export/ ; https://creativecommons.org/licenses/by/4.0/\nbegin;\ncreate table public.matchmaking_cities (\n  id integer primary key, name text not null, search_name text not null,\n  region text not null, country text not null,\n  latitude double precision not null check (latitude between -90 and 90),\n  longitude double precision not null check (longitude between -180 and 180),\n  population bigint not null\n);\nalter table public.matchmaking_cities enable row level security;\nrevoke all on public.matchmaking_cities from public, anon, authenticated;\ngrant select on public.matchmaking_cities to authenticated;\ngrant all on public.matchmaking_cities to service_role;\ncreate policy "Members can search the city catalog" on public.matchmaking_cities for select to authenticated using (true);\n`;
for (let i = 0; i < cities.length; i += 1000) sql += `insert into public.matchmaking_cities values\n${cities.slice(i, i + 1000).join(",\n")};\n`;
sql += `create index matchmaking_city_search on public.matchmaking_cities (search_name text_pattern_ops);\ncreate index matchmaking_city_name on public.matchmaking_cities (lower(name) text_pattern_ops);\n\ncreate function public.search_matchmaking_cities(query text)\nreturns table (id integer, name text, region text, country text)\nlanguage sql stable set search_path = '' as $$\n  select c.id, c.name, c.region, c.country from public.matchmaking_cities c\n  where char_length(btrim(query)) between 2 and 80\n    and (c.search_name like lower(btrim(query)) || '%' or lower(c.name) like lower(btrim(query)) || '%')\n  order by c.population desc, c.id limit 12;\n$$;\nrevoke all on function public.search_matchmaking_cities(text) from public, anon, authenticated;\ngrant execute on function public.search_matchmaking_cities(text) to authenticated;\ncommit;\n`;
await writeFile(new URL("../supabase/migrations/20261021000000_matchmaking_cities.sql", import.meta.url), sql);
const countries = JSON.parse(await readFile(countriesFile, "utf8"));
const path = geoPath(worldProjection()).digits(2);
const paths = countries.features.map(feature => `<path d="${path(feature)}"/>`).join("");
await writeFile(new URL("../matchmaking/world-outline.svg", import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500"><title>World outline</title><!-- Natural Earth, public domain. https://naturalearthdata.com --><g fill="#fafaf7" stroke="#c4c4bd" stroke-width="0.55" stroke-linejoin="round">${paths}</g></svg>\n`);
console.log(`Built the world outline and ${cities.length.toLocaleString()} city records.`);
