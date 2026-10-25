// Both shelves use the site's curated images. Missing/failed covers stay as a
// placeholder: displaying a book never triggers a database or provider lookup.
export function createBookCover(document, presentation, { width = 44, height = 66, className = "ranked-book-cover" } = {}) {
  const element = document.createElement("span"); element.className = className; element.setAttribute("aria-hidden", "true");
  const placeholder = document.createElement("span"); placeholder.className = "cover-placeholder"; placeholder.textContent = "ZBC";
  const image = document.createElement("img"); image.alt = ""; image.width = width; image.height = height;
  image.loading = "lazy"; image.decoding = "async"; image.referrerPolicy = "no-referrer";
  image.hidden = true;
  if (presentation.cover) { image.src = presentation.cover; image.hidden = false; }
  image.addEventListener("error", () => { image.hidden = true; });
  element.append(placeholder, image);
  return element;
}
