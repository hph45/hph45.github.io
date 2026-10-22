// Shared by both community shelves. Start loading only after the row is mounted;
// a late fallback response must not restore a row removed on refresh/sign-out.
export function createBookCover(document, book, presentation, loadCover, { width = 44, height = 66, className = "ranked-book-cover" } = {}) {
  const element = document.createElement("span"); element.className = className; element.setAttribute("aria-hidden", "true");
  const placeholder = document.createElement("span"); placeholder.className = "cover-placeholder"; placeholder.textContent = "ZBC";
  const image = document.createElement("img"); image.alt = ""; image.width = width; image.height = height;
  image.loading = "lazy"; image.decoding = "async"; image.referrerPolicy = "no-referrer";
  image.hidden = true;
  const showCover = url => { if (url && image.isConnected) { image.src = url; image.hidden = false; } };
  let fallback;
  const useFallback = () => fallback ||= Promise.resolve(loadCover(book.work_id)).then(showCover).catch(() => {});
  image.addEventListener("error", () => { image.hidden = true; if (presentation.cover && image.getAttribute("src") === presentation.cover) void useFallback(); });
  element.append(placeholder, image);
  return { element, load: () => presentation.cover ? Promise.resolve(showCover(presentation.cover)) : useFallback() };
}
