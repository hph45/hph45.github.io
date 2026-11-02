import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePublicMap } from "../home/src/community.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../matchmaking/src/config.js";

export async function fetchPublicSnapshot({ fetch = globalThis.fetch, now = Date.now } = {}) {
  // This is the already-public aggregate endpoint. No service-role key, member
  // session, database password, or individual profile is used by publishing.
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_public_matchmaking_map`, {
    method: "POST", headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: "{}", credentials: "omit", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Public map request failed (${response.status})`);
  const data = parsePublicMap(await response.json());
  const age = now() - Date.parse(data.generated_at);
  if (age < -300000 || age > 65 * 60 * 1000) throw new Error("Refusing to publish an expired map snapshot");
  return data;
}

export async function writePublicSnapshot(file, options) {
  const snapshot = await fetchPublicSnapshot(options);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(snapshot) + "\n");
  return snapshot;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error("Usage: node scripts/refresh-public-map.mjs OUTPUT.json");
  const snapshot = await writePublicSnapshot(output);
  console.log(`Published aggregate snapshot: ${snapshot.cities.length} cities; generated ${snapshot.generated_at}.`);
}
