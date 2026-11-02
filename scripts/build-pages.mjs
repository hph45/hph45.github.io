import { copyFile, lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Publish only website assets. Never upload the repository root: it contains
// local private matching files, database tooling, tests, and development state.
export const PUBLIC_FILES = [
  "index.html", "styles.css", "script.js", "legal.css", "logo.png", "CNAME",
  "book_club_current.csv", "events.csv", "podcasts.csv", "recommended_reviews.csv", "reviews.csv", "tbr.csv",
  "zebra white.jpeg", "zebra white and black.pdf", "zebra white and black (1).pdf",
  "matchmaking/index.html", "matchmaking/styles.css", "matchmaking/app.js", "matchmaking/world-outline.svg", "matchmaking/books.csv",
  "admin/index.html", "admin/styles.css", "admin/app.js", "privacy/index.html", "terms/index.html",
];
export const PUBLIC_DIRECTORIES = ["assets", "matchmaking/data"];

export async function buildPages(source, destination) {
  source = await realpath(resolve(source)); destination = resolve(destination);
  if (source === destination) throw new Error("Choose a separate, new output directory");
  await mkdir(destination, { recursive: false }); // Refuse stale/unreviewed files in an existing output directory.
  const copy = async relative => {
    const from = join(source, relative), to = join(destination, relative);
    if (!(await lstat(from)).isFile() || await realpath(from) !== from) throw new Error(`Not a regular public file: ${relative}`);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  };
  for (const relative of PUBLIC_FILES) await copy(relative);
  const directory = async relative => {
    if (!(await lstat(join(source, relative))).isDirectory()) throw new Error(`Not a regular public directory: ${relative}`);
    for (const entry of await readdir(join(source, relative), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not publishable: ${path}`);
      if (entry.isDirectory()) await directory(path);
      else if (/\.(?:js|css|svg|png|jpe?g|webp|ico|json|csv)$/i.test(entry.name)) await copy(path);
    }
  };
  for (const relative of PUBLIC_DIRECTORIES) await directory(relative);
  await writeFile(join(destination, ".nojekyll"), "");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPages(process.cwd(), process.argv[2] || "_site");
  console.log("Staged public website assets.");
}
