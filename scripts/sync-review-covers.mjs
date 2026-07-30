import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const COVERS_DIR = path.join(ROOT, "assets", "review-covers");
const MANIFEST_PATH = path.join(COVERS_DIR, "sources.csv");
const OPEN_LIBRARY_SEARCH_URL = "https://openlibrary.org/search.json";
const OPEN_LIBRARY_COVERS_URL = "https://covers.openlibrary.org/b/id";
const GOOGLE_BOOKS_URL = "https://www.googleapis.com/books/v1/volumes";
const REQUEST_HEADERS = {
  "User-Agent": "ZebraBookClub/1.0 (henry@zebrabookclub.com)",
};
const MANIFEST_COLUMNS = [
  "key",
  "episode",
  "author",
  "title",
  "file",
  "source",
  "source_id",
  "source_page",
  "matched_title",
  "matched_author",
  "match_score",
  "bytes",
];

const TITLE_ALIASES = new Map([
  ["The Creative Act, A Way of Being", "The Creative Act: A Way of Being"],
  ["The Picture of Dorian Grey", "The Picture of Dorian Gray"],
  ["The Great Cosmis Mother", "The Great Cosmic Mother"],
]);

const AUTHOR_ALIASES = new Map([
  ["Paul Wolff", "Robert Paul Wolff"],
  ["Alan Moore and Dave Gibbons", "Alan Moore"],
  ["O. Henry (William Porter)", "O. Henry"],
]);

const ISBN_COVER_OVERRIDES = new Map([
  ["review-61", { isbn: "9780593722824", provider: "Penguin Random House" }],
  ["review-50", { isbn: "9780156032971", provider: "Open Library" }],
  ["review-49", { isbn: "9780060932138", provider: "Open Library" }],
  ["review-47", { isbn: "9780385546898", provider: "Penguin Random House" }],
  ["review-45", { isbn: "9780547928197", provider: "Penguin Random House" }],
  ["review-44", { isbn: "9780547928203", provider: "Penguin Random House" }],
  ["review-43", { isbn: "9780547928210", provider: "Penguin Random House" }],
  ["review-42", { isbn: "9780593652886", provider: "Open Library" }],
  ["review-39", { isbn: "9780141439570", provider: "Penguin Random House" }],
  ["review-33", { isbn: "9780345539809", provider: "Penguin Random House" }],
  ["review-26", { isbn: "9781400031764", provider: "Open Library" }],
  ["review-22", { isbn: "9781546171461", provider: "Open Library" }],
  ["review-21", { isbn: "9780140449266", provider: "Penguin Random House" }],
  ["review-02", { isbn: "9780141191461", provider: "Open Library" }],
  ["review-01", { isbn: "9780143039426", provider: "Penguin Random House" }],
]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        value += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(value);
      if (row.some((cell) => cell.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    if (row.some((cell) => cell.trim() !== "")) {
      rows.push(row);
    }
  }

  return rows;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function cleanLabel(value) {
  return value.replace(/\s*\*+\s*$/, "").trim();
}

function catalogTitle(title) {
  const cleaned = cleanLabel(title);
  return TITLE_ALIASES.get(cleaned) || cleaned;
}

function catalogAuthor(author) {
  const cleaned = cleanLabel(author);
  return AUTHOR_ALIASES.get(cleaned) || cleaned;
}

function normalize(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value) {
  return new Set(normalize(value).split(" ").filter((token) => token.length > 1));
}

function overlapScore(expected, candidate) {
  const expectedTokens = tokens(expected);
  const candidateTokens = tokens(candidate);

  if (expectedTokens.size === 0 || candidateTokens.size === 0) {
    return 0;
  }

  let shared = 0;
  expectedTokens.forEach((token) => {
    if (candidateTokens.has(token)) {
      shared += 1;
    }
  });

  return shared / expectedTokens.size;
}

function scoreOpenLibraryMatch(book, candidate) {
  if (!candidate.cover_i) {
    return -1;
  }

  const expectedTitle = normalize(book.catalogTitle);
  const candidateTitle = normalize(candidate.title || "");
  let score = 0;

  if (candidateTitle === expectedTitle) {
    score += 100;
  } else if (
    candidateTitle.includes(expectedTitle) ||
    expectedTitle.includes(candidateTitle)
  ) {
    score += 65;
  } else {
    score += overlapScore(book.catalogTitle, candidate.title || "") * 45;
  }

  const candidateAuthors = (candidate.author_name || []).join(" ");
  score += overlapScore(book.catalogAuthor, candidateAuthors) * 35;

  if (candidate.edition_count > 10) {
    score += Math.min(10, Math.log10(candidate.edition_count) * 4);
  }

  return score;
}

async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...REQUEST_HEADERS, ...options.headers },
      });

      if (response.ok) {
        return response;
      }

      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, attempt * 750));
  }

  throw lastError;
}

async function findOpenLibraryCover(book) {
  const params = new URLSearchParams({
    title: book.catalogTitle,
    author: book.catalogAuthor,
    fields: "key,title,author_name,cover_i,edition_count,first_publish_year",
    limit: "10",
    language: "eng",
  });
  const response = await fetchWithRetry(`${OPEN_LIBRARY_SEARCH_URL}?${params}`);
  const data = await response.json();
  const candidates = (data.docs || [])
    .map((candidate) => ({
      candidate,
      score: scoreOpenLibraryMatch(book, candidate),
    }))
    .sort((left, right) => right.score - left.score);
  const match = candidates[0];

  if (!match || match.score < 70) {
    return null;
  }

  return {
    source: "Open Library",
    sourceId: String(match.candidate.cover_i),
    sourceUrl: `https://openlibrary.org${match.candidate.key}`,
    imageUrl: `${OPEN_LIBRARY_COVERS_URL}/${match.candidate.cover_i}-M.jpg?default=false`,
    matchedTitle: match.candidate.title,
    matchedAuthor: (match.candidate.author_name || []).join("; "),
    score: match.score.toFixed(1),
  };
}

function findIsbnCover(book) {
  const override = ISBN_COVER_OVERRIDES.get(book.key);
  if (!override) {
    return null;
  }

  const { isbn, provider } = override;
  const isPublisherImage = provider === "Penguin Random House";

  return {
    source: provider,
    sourceId: `ISBN ${isbn}`,
    sourceUrl: isPublisherImage
      ? `https://images.penguinrandomhouse.com/cover/${isbn}`
      : `https://openlibrary.org/isbn/${isbn}`,
    imageUrl: isPublisherImage
      ? `https://images.penguinrandomhouse.com/cover/${isbn}`
      : `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`,
    matchedTitle: book.catalogTitle,
    matchedAuthor: book.catalogAuthor,
    score: "100.0",
  };
}

function scoreGoogleBooksMatch(book, candidate) {
  const info = candidate.volumeInfo || {};
  if (!info.imageLinks?.thumbnail) {
    return -1;
  }

  const expectedTitle = normalize(book.catalogTitle);
  const candidateTitle = normalize(info.title || "");
  let score = candidateTitle === expectedTitle ? 100 : 0;

  if (
    candidateTitle !== expectedTitle &&
    (candidateTitle.includes(expectedTitle) || expectedTitle.includes(candidateTitle))
  ) {
    score += 65;
  } else if (candidateTitle !== expectedTitle) {
    score += overlapScore(book.catalogTitle, info.title || "") * 45;
  }

  score += overlapScore(book.catalogAuthor, (info.authors || []).join(" ")) * 35;
  return score;
}

async function findGoogleBooksCover(book) {
  const params = new URLSearchParams({
    q: `intitle:${book.catalogTitle} inauthor:${book.catalogAuthor}`,
    maxResults: "10",
    printType: "books",
  });
  const response = await fetchWithRetry(`${GOOGLE_BOOKS_URL}?${params}`);
  const data = await response.json();
  const candidates = (data.items || [])
    .map((candidate) => ({
      candidate,
      score: scoreGoogleBooksMatch(book, candidate),
    }))
    .sort((left, right) => right.score - left.score);
  const match = candidates[0];

  if (!match || match.score < 70) {
    return null;
  }

  const info = match.candidate.volumeInfo;
  const imageUrl = info.imageLinks.thumbnail
    .replace(/^http:/, "https:")
    .replace("&zoom=1", "&zoom=2");

  return {
    source: "Google Books",
    sourceId: match.candidate.id,
    sourceUrl: info.infoLink || `https://books.google.com/books?id=${match.candidate.id}`,
    imageUrl,
    matchedTitle: info.title,
    matchedAuthor: (info.authors || []).join("; "),
    score: match.score.toFixed(1),
  };
}

async function loadBooks() {
  const [reviewsCsv, queueCsv] = await Promise.all([
    readFile(path.join(ROOT, "reviews.csv"), "utf8"),
    readFile(path.join(ROOT, "book_club_current.csv"), "utf8"),
  ]);
  const reviewRows = parseCsv(reviewsCsv);
  const reviewHeaderIndex = reviewRows.findIndex((row) => row[0]?.trim() === "Ep. #");
  const queueRows = parseCsv(queueCsv);
  const queueHeaderIndex = queueRows.findIndex(
    (row) => row[0]?.trim().toLowerCase() === "status"
  );

  if (reviewHeaderIndex === -1 || queueHeaderIndex === -1) {
    throw new Error("Could not find review or reading-queue CSV headers.");
  }

  const reviews = reviewRows
    .slice(reviewHeaderIndex + 1)
    .filter((row) => /^\d+$/.test(row[0]?.trim()) && row[2]?.trim())
    .map((row) => ({
      key: `review-${row[0].trim().padStart(2, "0")}`,
      episode: row[0].trim(),
      author: cleanLabel(row[1].trim()),
      title: cleanLabel(row[2].trim()),
    }));

  const queue = queueRows
    .slice(queueHeaderIndex + 1)
    .filter((row) => row[0]?.trim() && row[1]?.trim() && row[2]?.trim())
    .map((row) => ({
      key: row[0].trim().toLowerCase() === "currently reading" ? "current" : "next",
      episode: "",
      author: cleanLabel(row[1].trim()),
      title: cleanLabel(row[2].trim()),
    }));

  return [...queue, ...reviews].map((book) => ({
    ...book,
    catalogTitle: catalogTitle(book.title),
    catalogAuthor: catalogAuthor(book.author),
    file: `${book.key}.jpg`,
  }));
}

async function downloadCover(book, match) {
  const response = await fetchWithRetry(match.imageUrl);
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.startsWith("image/")) {
    throw new Error(`Cover response was ${contentType || "not an image"}`);
  }

  const image = Buffer.from(await response.arrayBuffer());
  if (image.length < 1_000) {
    throw new Error(`Cover image was unexpectedly small (${image.length} bytes)`);
  }

  await writeFile(path.join(COVERS_DIR, book.file), image);
  return image.length;
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadExistingManifest() {
  if (!(await fileExists(MANIFEST_PATH))) {
    return new Map();
  }

  const rows = parseCsv(await readFile(MANIFEST_PATH, "utf8"));
  const headerIndex = rows.findIndex((row) => row[0]?.trim() === "key");

  if (headerIndex === -1) {
    return new Map();
  }

  return new Map(
    rows
      .slice(headerIndex + 1)
      .filter((row) => row[0]?.trim())
      .map((row) => [row[0].trim(), row])
  );
}

async function main() {
  const books = await loadBooks();
  const manifestRows = await loadExistingManifest();
  const unresolved = [];

  await mkdir(COVERS_DIR, { recursive: true });

  for (const [index, book] of books.entries()) {
    process.stdout.write(
      `[${String(index + 1).padStart(2, "0")}/${books.length}] ${book.title} ... `
    );

    const override = ISBN_COVER_OVERRIDES.get(book.key);
    const existingRow = manifestRows.get(book.key);
    const hasCurrentOverride =
      !override || existingRow?.[6] === `ISBN ${override.isbn}`;

    if (
      existingRow &&
      hasCurrentOverride &&
      (await fileExists(path.join(COVERS_DIR, book.file)))
    ) {
      process.stdout.write("already downloaded\n");
      continue;
    }

    try {
      let match = findIsbnCover(book);
      let bytes = 0;

      if (!match) {
        try {
          match = await findOpenLibraryCover(book);
        } catch (error) {
          process.stdout.write(`Open Library unavailable (${error.message}); `);
        }
      }

      if (match) {
        try {
          bytes = await downloadCover(book, match);
        } catch (error) {
          process.stdout.write(`Open Library cover unavailable (${error.message}); `);
          match = null;
        }
      }

      if (!match) {
        match = await findGoogleBooksCover(book);
        if (match) {
          bytes = await downloadCover(book, match);
        }
      }

      if (!match) {
        unresolved.push(book);
        process.stdout.write("unresolved\n");
      } else {
        manifestRows.set(book.key, [
          book.key,
          book.episode,
          book.author,
          book.title,
          book.file,
          match.source,
          match.sourceId,
          match.sourceUrl,
          match.matchedTitle,
          match.matchedAuthor,
          match.score,
          bytes,
        ]);
        process.stdout.write(
          `${match.source} / ${match.matchedTitle} (${Math.round(bytes / 1024)} KB)\n`
        );
      }
    } catch (error) {
      unresolved.push(book);
      process.stdout.write(`failed: ${error.message}\n`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1_200));
  }

  const lines = [
    MANIFEST_COLUMNS.join(","),
    ...books
      .map((book) => manifestRows.get(book.key))
      .filter(Boolean)
      .map((row) => row.map(csvCell).join(",")),
  ];

  await writeFile(MANIFEST_PATH, `${lines.join("\n")}\n`);

  console.log(`\nDownloaded ${manifestRows.size}/${books.length} covers.`);
  if (unresolved.length > 0) {
    console.log("Unresolved:");
    unresolved.forEach((book) => console.log(`- ${book.key}: ${book.title}`));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
