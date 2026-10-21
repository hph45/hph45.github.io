export function parseCsv(text) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(value); value = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(value); if (row.some(cell => cell.trim())) rows.push(row);
      row = []; value = "";
    } else value += char;
  }
  row.push(value); if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}

const key = value => String(value || "").normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const clean = value => String(value || "").replace(/\s*\*+\s*$/, "").trim();

// Original-language work records for reviews whose cover manifest uses a
// separate translation record or an ISBN. These aliases affect presentation
// only; they do not combine votes or change members' saved favorites.
const reviewWorkAliases = {
  "review-03": ["OL10263W"], // Le petit prince
  "review-05": ["OL676009W"], // Мастер и Маргарита
  "review-21": ["OL36287W"], // Le Comte de Monte-Cristo
};

function amazonLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["amzn.to", "link.amazon", "amazon.com", "www.amazon.com"].includes(url.hostname)
      && !url.username && !url.password && !url.port ? value : "";
  } catch { return ""; }
}

function records(csv) {
  const [headers = [], ...rows] = parseCsv(csv);
  return rows.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] || ""])));
}

export function createReviewCatalog(reviews, queue, sources, books = "") {
  const catalog = new Map();
  for (const row of parseCsv(reviews)) {
    if (!/^\d+$/.test(row[0]?.trim()) || !row[2]?.trim()) continue;
    const id = `review-${row[0].trim().padStart(2, "0")}`;
    catalog.set(id, { title: clean(row[2]), author: clean(row[1]), amazon: amazonLink(row[6]?.trim()), cover: `/assets/review-covers/${id}.jpg`, workIDs: [...(reviewWorkAliases[id] || [])] });
  }
  for (const row of parseCsv(queue)) {
    if (!["currently reading", "next week"].includes(row[0]?.trim().toLowerCase()) || !row[2]?.trim()) continue;
    const id = row[0].trim().toLowerCase() === "currently reading" ? "current" : "next";
    catalog.set(id, { title: clean(row[2]), author: clean(row[1]), amazon: amazonLink(row[4]?.trim()), cover: `/assets/review-covers/${id}.jpg?v=${encodeURIComponent(clean(row[2]))}`, workIDs: [] });
  }
  // The cover manifest connects review spellings to Open Library's work IDs and
  // canonical labels. Don't guess a book from its title alone.
  for (const source of records(sources)) {
    const entry = catalog.get(source.key);
    if (!entry || key(entry.title) !== key(source.title) || key(entry.author) !== key(source.author)) continue;
    const workID = source.source_page.match(/^https:\/\/openlibrary\.org\/works\/(OL\d+W)$/)?.[1];
    if (workID) entry.workIDs.push(workID);
    Object.assign(entry, { matchedTitle: source.matched_title, matchedAuthor: source.matched_author });
  }
  // Curated assets also cover books that haven't appeared in a club review.
  // Merge known books so adding a link can retain their existing review cover.
  for (const book of records(books)) {
    const workID = book.work_id?.trim(), title = clean(book.title), author = clean(book.author);
    if (!/^OL\d+W$/.test(workID) || !title || !author) continue;
    const matches = [...catalog.values()].filter(entry => entry.workIDs.includes(workID)
      || (key(entry.title) === key(title) && key(entry.author) === key(author)));
    const entry = matches.length === 1 ? matches[0] : { title, author, workIDs: [], amazon: "", cover: "" };
    if (!entry.workIDs.includes(workID)) entry.workIDs.push(workID);
    const amazon = amazonLink(book.amazon_url?.trim());
    const cover = book.cover?.trim();
    if (amazon) entry.amazon = amazon;
    if (/^\/assets\/(?:review-covers|matchmaking-covers)\/[a-z0-9-]+\.(?:jpg|jpeg|png|webp)$/.test(cover)) entry.cover = cover;
    if (matches.length !== 1) catalog.set(`work-${workID}`, entry);
  }
  return [...catalog.values()];
}

export async function loadReviewCatalog(fetch) {
  const files = ["/reviews.csv", "/book_club_current.csv", "/assets/review-covers/sources.csv", "/matchmaking/books.csv"];
  const texts = await Promise.all(files.map(async file => {
    try {
      const response = await fetch(file, { signal: AbortSignal.timeout(8000) });
      return response.ok ? await response.text() : "";
    } catch { return ""; }
  }));
  return createReviewCatalog(...texts);
}

export function bookPresentation(book, catalog) {
  const byWork = catalog.find(review => review.workIDs.includes(book.work_id));
  const titleKey = key(book.title), authorKey = key(book.author);
  const candidates = titleKey && authorKey ? catalog.filter(review => [review.title, review.matchedTitle].some(title => key(title) === titleKey)
    && [review.author, review.matchedAuthor].some(author => key(author) === authorKey)) : [];
  const review = byWork || (candidates.length === 1 ? candidates[0] : null);
  const search = new URL("https://www.amazon.com/s");
  search.search = new URLSearchParams({ i: "stripbooks", k: `${book.title} ${book.author}` }).toString();
  return { cover: review?.cover || "", url: review?.amazon || search.href, affiliate: Boolean(review?.amazon) };
}
