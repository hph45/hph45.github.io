import { bookPresentation } from "./review-catalog.js";
import { createBookCover } from "./book-cover.js";

export function renderRisingBooks(document, books, topBooks, catalog) {
  const list = document.querySelector("#rising-books-list");
  list.replaceChildren();
  const excluded = new Set(topBooks.map(book => book.work_id));
  for (const book of books) {
    if (excluded.has(book.work_id)) continue;
    excluded.add(book.work_id);
    const presentation = bookPresentation(book, catalog);
    const item = document.createElement("li");
    const link = document.createElement("a"); link.className = "rising-book-link";
    link.href = presentation.url; link.target = "_blank";
    link.rel = `${presentation.affiliate ? "sponsored " : ""}noopener noreferrer`;
    const cover = createBookCover(document, presentation, { width: 48, height: 72, className: "rising-book-cover" });
    const info = document.createElement("span"); info.className = "rising-book-details";
    const title = document.createElement("span"); title.className = "rising-book-title"; title.textContent = book.title;
    const author = document.createElement("span"); author.className = "rising-book-author"; author.textContent = book.author;
    info.append(title, author);
    const ranking = document.createElement("span"); ranking.className = "rising-book-rank";
    const context = document.createElement("span"); context.className = "visually-hidden"; context.textContent = "Rising favorite ";
    const rank = document.createElement("span"); rank.textContent = String(list.children.length + 1);
    const flame = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    flame.classList.add("rising-book-icon"); flame.setAttribute("viewBox", "0 0 24 24");
    flame.setAttribute("aria-hidden", "true"); flame.setAttribute("focusable", "false");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "/assets/icons.svg?v=20261021.2#flame"); flame.append(use);
    ranking.append(context, rank, flame);
    const destination = document.createElement("span"); destination.className = "visually-hidden";
    destination.textContent = "Find on Amazon (opens in a new tab).";
    link.append(cover, info, ranking, destination); item.append(link); list.append(item);
    if (list.children.length === 2) break;
  }
  const status = document.querySelector("#rising-books-status");
  status.hidden = list.children.length > 0;
  status.textContent = status.hidden ? "" : "New favorites will appear here as readers discover more books.";
}
