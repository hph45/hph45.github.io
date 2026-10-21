import { bookPresentation } from "./review-catalog.js";

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
    const cover = document.createElement("span"); cover.className = "ranked-book-cover"; cover.setAttribute("aria-hidden", "true");
    const placeholder = document.createElement("span"); placeholder.className = "cover-placeholder"; placeholder.textContent = "ZBC";
    const image = document.createElement("img"); image.alt = ""; image.width = 44; image.height = 66;
    image.loading = "lazy"; image.decoding = "async"; image.referrerPolicy = "no-referrer";
    image.hidden = true;
    const showCover = url => { if (url && image.isConnected) { image.src = url; image.hidden = false; } };
    let fallback;
    const useFallback = () => fallback ||= Promise.resolve(loadCover(book.work_id)).then(showCover).catch(() => {});
    image.addEventListener("error", () => { image.hidden = true; if (presentation.cover && image.getAttribute("src") === presentation.cover) void useFallback(); });
    cover.append(placeholder, image);
    const info = document.createElement("span"); info.className = "ranked-book-info";
    const title = document.createElement("span"); title.className = "ranked-book-title"; title.textContent = book.title;
    const author = document.createElement("span"); author.className = "ranked-book-author"; author.textContent = book.author;
    const destination = document.createElement("span"); destination.className = "visually-hidden"; destination.textContent = "Find on Amazon (opens in a new tab).";
    const votes = document.createElement("span"); votes.className = "book-votes"; votes.textContent = `${book.votes} ${book.votes === 1 ? "reader" : "readers"}`;
    info.append(title, author); link.append(rank, cover, info, votes, destination); item.append(link); list.append(item);
    if (presentation.cover) showCover(presentation.cover);
    else covers.push(useFallback());
  }
  return Promise.all(covers);
}
