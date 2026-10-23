import { bookPresentation } from "./review-catalog.js";
import { createBookCover } from "./book-cover.js";

export function coverURL(id) {
  return Number.isSafeInteger(id) && id > 0 ? `https://covers.openlibrary.org/b/id/${id}-M.jpg?default=false` : "";
}

// Reuse the authenticated, cached book search and its shared upstream throttle.
// Serializing missing covers avoids a burst of ten Open Library requests.
export function createCoverLookup(client, window) {
  const cache = new Map();
  let queue = Promise.resolve();
  return workID => {
    if (!/^OL\d+W$/.test(workID)) return Promise.resolve("");
    if (!cache.has(workID)) {
      const request = queue.then(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const { data, error } = await client.functions.invoke("search-books", { body: { work_id: workID } });
          if (!error) return coverURL(data?.books?.find(book => book.work_id === workID)?.cover_id);
          if (error.context?.status !== 429 || attempt === 2) return "";
          await new Promise(resolve => window.setTimeout(resolve, 600));
        }
        return "";
      }).catch(() => "");
      cache.set(workID, request);
      queue = request.then(() => {});
    }
    return cache.get(workID);
  };
}

export function renderTopBooks(document, books, catalog, loadCover) {
  const list = document.querySelector("#top-books-list");
  list.replaceChildren();
  const covers = [];
  for (const [index, book] of books.slice(0, 10).entries()) {
    const presentation = bookPresentation(book, catalog);
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "top-book-link";
    link.href = presentation.url;
    link.target = "_blank";
    link.rel = `${presentation.affiliate ? "sponsored " : ""}noopener noreferrer`;
    const rank = document.createElement("span"); rank.className = "book-rank"; rank.textContent = String(index + 1).padStart(2, "0");
    const cover = createBookCover(document, book, presentation, loadCover);
    const info = document.createElement("span"); info.className = "ranked-book-info";
    const title = document.createElement("span"); title.className = "ranked-book-title"; title.textContent = book.title;
    const author = document.createElement("span"); author.className = "ranked-book-author"; author.textContent = book.author;
    const destination = document.createElement("span"); destination.className = "visually-hidden"; destination.textContent = "Find on Amazon (opens in a new tab).";
    const votes = document.createElement("span"); votes.className = "book-votes"; votes.textContent = `${book.votes} ${book.votes === 1 ? "favorite" : "favorites"}`;
    info.append(title, author); link.append(rank, cover.element, info, votes, destination); item.append(link); list.append(item);
    covers.push(cover.load());
  }
  return Promise.all(covers);
}
