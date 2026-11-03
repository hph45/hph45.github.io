import catalog from "../data/country-books.json" with { type: "json" };
import { bookPresentation } from "./review-catalog.js";

const key = value => String(value || "").normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const sameBook = (a, b) => key(a.title) === key(b.title) && key(a.author) === key(b.author);

export function countryBookPresentation(book, reviews) {
  const reviewed = bookPresentation(book, reviews);
  const exact = catalog.books.find(entry => entry.work_ids.includes(book.work_id)) || catalog.books.find(entry => sameBook(entry, book));
  const alias = exact ? null : catalog.books.find(entry => entry.aliases?.some(name => sameBook(name, book)));
  const entry = exact || alias;
  const approximate = !reviewed.cover && Boolean(alias?.approximate_aliases);
  // Keep the user's curated short links. Verified ISBN editions can use their
  // product link; an ambiguous/unknown title uses a tagged Amazon book search.
  const url = new URL(reviewed.affiliate ? reviewed.url : (!approximate && entry?.amazon_url) || reviewed.url);
  if (!reviewed.affiliate) {
    url.searchParams.set("tag", "zebrabookclub-20");
    if (book.author === "Unknown author" && url.pathname === "/s") url.searchParams.set("k", book.title);
  }
  // A series keeps its saved title and votes, but uses the first volume's
  // artwork even when an older curated entry still has a boxed-set cover.
  const cover = entry?.first_book ? entry.cover : reviewed.cover || entry?.cover || "";
  return { ...reviewed, cover, url: url.href, affiliate: true,
    approximate, coverTitle: entry?.first_book?.title || entry?.title, coverAuthor: entry?.first_book?.author || entry?.author };
}
