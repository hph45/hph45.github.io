import { bookPresentation } from "./review-catalog.js";
import { createBookCover } from "./book-cover.js";

export function renderTopBooks(document, books, catalog) {
  const list = document.querySelector("#top-books-list");
  list.replaceChildren();
  for (const [index, book] of books.slice(0, 10).entries()) {
    const presentation = bookPresentation(book, catalog);
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "top-book-link";
    link.href = presentation.url;
    link.target = "_blank";
    link.rel = `${presentation.affiliate ? "sponsored " : ""}noopener noreferrer`;
    const rank = document.createElement("span"); rank.className = "book-rank"; rank.textContent = String(index + 1).padStart(2, "0");
    const cover = createBookCover(document, presentation);
    const info = document.createElement("span"); info.className = "ranked-book-info";
    const title = document.createElement("span"); title.className = "ranked-book-title"; title.textContent = book.title;
    const author = document.createElement("span"); author.className = "ranked-book-author"; author.textContent = book.author;
    const destination = document.createElement("span"); destination.className = "visually-hidden"; destination.textContent = "Find on Amazon (opens in a new tab).";
    const votes = document.createElement("span"); votes.className = "book-votes"; votes.textContent = `${book.votes} ${book.votes === 1 ? "favorite" : "favorites"}`;
    info.append(title, author); link.append(rank, cover, info, votes, destination); item.append(link); list.append(item);
  }
}
