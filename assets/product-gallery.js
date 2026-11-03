// Product views are static site assets. Switching sides never contacts the
// database or changes a reader's raffle preference.
export function attachProductGalleries(root) {
  const galleries = [...root.querySelectorAll("[data-product-gallery]")];
  const cleanups = [];
  const resets = [];
  for (const gallery of galleries) {
    const controls = [...gallery.querySelectorAll("[data-product-view]")];
    const images = [...gallery.querySelectorAll("[data-product-image]")];
    function show(view) {
      if (view !== "front" && view !== "back") return;
      for (const image of images) {
        const source = image.dataset[`${view}Src`];
        if (!source) continue;
        image.src = source;
        image.alt = image.dataset[`${view}Alt`] || image.alt;
        const fullSizeLink = image.closest("[data-product-full]");
        if (fullSizeLink) fullSizeLink.href = image.dataset[`${view}Full`] || source;
      }
      controls.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.productView === view)));
      gallery.dataset.currentView = view;
    }
    for (const button of controls) {
      const choose = () => show(button.dataset.productView);
      button.addEventListener("click", choose);
      cleanups.push(() => button.removeEventListener("click", choose));
    }
    resets.push(() => show("front"));
  }
  return {
    reset() { resets.forEach(reset => reset()); },
    destroy() { cleanups.forEach(cleanup => cleanup()); },
  };
}
