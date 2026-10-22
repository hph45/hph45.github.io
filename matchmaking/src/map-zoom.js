const WIDTH = 1000, HEIGHT = 500, MAX_ZOOM = 8;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function attachMapZoom(document) {
  const svg = document.querySelector("#world-map");
  const content = document.querySelector("#map-content");
  const zoomIn = document.querySelector("#map-zoom-in");
  const zoomOut = document.querySelector("#map-zoom-out");
  const resetButton = document.querySelector("#map-reset");
  const status = document.querySelector("#map-zoom-status");
  let view = { x: 0, y: 0, scale: 1 };
  let drag, pinch, safariGesture;
  let suppressClick = false;
  const removers = [];
  const listen = (target, event, handler, options) => {
    target.addEventListener(event, handler, options);
    removers.push(() => target.removeEventListener(event, handler, options));
  };
  // Account for SVG letterboxing as well as its responsive width.
  const point = event => {
    const rect = svg.getBoundingClientRect();
    const fit = Math.min(rect.width / WIDTH, rect.height / HEIGHT);
    if (!fit || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return { x: WIDTH / 2, y: HEIGHT / 2 };
    return {
      x: (event.clientX - rect.left - (rect.width - WIDTH * fit) / 2) / fit,
      y: (event.clientY - rect.top - (rect.height - HEIGHT * fit) / 2) / fit,
    };
  };
  function render(next = view) {
    const scale = clamp(next.scale, 1, MAX_ZOOM);
    view = { scale, x: clamp(next.x, WIDTH * (1 - scale), 0), y: clamp(next.y, HEIGHT * (1 - scale), 0) };
    content.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.scale})`);
    // Let dots grow gently, instead of obscuring whole cities at higher zoom.
    for (const marker of content.querySelectorAll("[data-map-radius]")) {
      marker.setAttribute("r", Number(marker.dataset.mapRadius) / Math.sqrt(scale));
    }
    svg.classList.toggle("is-zoomed", scale > 1);
    zoomIn.disabled = scale >= MAX_ZOOM;
    zoomOut.disabled = scale <= 1;
    resetButton.disabled = scale <= 1;
    status.textContent = `Map zoom ${Math.round(scale * 100)} percent`;
  }
  function zoom(scale, anchor = { x: WIDTH / 2, y: HEIGHT / 2 }, start = view, destination = anchor) {
    const ratio = clamp(scale, 1, MAX_ZOOM) / start.scale;
    render({ scale, x: destination.x - (anchor.x - start.x) * ratio, y: destination.y - (anchor.y - start.y) * ratio });
  }
  function reset() {
    drag = pinch = safariGesture = null; suppressClick = false;
    svg.classList.remove("is-dragging");
    render({ x: 0, y: 0, scale: 1 });
  }
  listen(zoomIn, "click", () => zoom(view.scale * 1.5));
  listen(zoomOut, "click", () => zoom(view.scale / 1.5));
  listen(resetButton, "click", reset);

  // Ordinary scrolling always belongs to the page. Trackpad pinches arrive as
  // Ctrl+wheel in Chromium/Firefox; a mouse can use Ctrl+scroll or the buttons.
  listen(svg, "wheel", event => {
    if (!(event.ctrlKey || event.metaKey) || safariGesture || !event.cancelable) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 500 : 1);
    zoom(view.scale * Math.exp(-clamp(delta, -100, 100) * .01), point(event));
  }, { passive: false });

  listen(svg, "pointerdown", event => {
    if (event.pointerType === "touch" || event.button !== 0) return;
    suppressClick = false;
    if (view.scale <= 1) return;
    drag = { id: event.pointerId, point: point(event), view: { ...view } };
  });
  listen(svg, "pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    const current = point(event), dx = current.x - drag.point.x, dy = current.y - drag.point.y;
    if (Math.hypot(dx, dy) < 4 && !suppressClick) return;
    if (!suppressClick) svg.setPointerCapture?.(event.pointerId);
    suppressClick = true; svg.classList.add("is-dragging");
    render({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy });
  });
  const endDrag = event => {
    if (drag?.id !== event.pointerId) return;
    if (svg.hasPointerCapture?.(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    drag = null; svg.classList.remove("is-dragging");
  };
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) listen(svg, event, endDrag);
  listen(svg, "pointerleave", event => { if (!suppressClick) endDrag(event); });
  listen(svg, "click", event => {
    if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; }
  }, true);

  const pair = touches => {
    const a = point(touches[0]), b = point(touches[1]);
    return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), ids: [touches[0].identifier, touches[1].identifier] };
  };
  // Only intercept two fingers. A one-finger swipe scrolls the page even while
  // zoomed, and tapping a city still selects it. Non-passive listeners are scoped
  // to the map so the rest of the page keeps its native touch behavior.
  listen(svg, "touchstart", event => {
    if (event.touches.length === 1) suppressClick = false;
    if (event.touches.length !== 2 || !event.cancelable) { pinch = null; return; }
    event.preventDefault();
    pinch = { ...pair(event.touches), view: { ...view } };
    suppressClick = true;
  }, { passive: false });
  listen(svg, "touchmove", event => {
    if (event.touches.length !== 2 || !event.cancelable) { pinch = null; return; }
    event.preventDefault();
    const next = pair(event.touches);
    if (!pinch || next.ids.some((id, index) => id !== pinch.ids[index])) pinch = { ...next, view: { ...view } };
    zoom(pinch.view.scale * next.distance / pinch.distance, pinch.center, pinch.view, next.center);
    suppressClick = true;
  }, { passive: false });
  for (const event of ["touchend", "touchcancel"]) listen(svg, event, () => { pinch = null; }, { passive: true });

  // Safari desktop exposes trackpad pinch through GestureEvent instead.
  listen(svg, "gesturestart", event => {
    if (pinch) return;
    event.preventDefault(); safariGesture = { view: { ...view }, point: point(event) };
  }, { passive: false });
  listen(svg, "gesturechange", event => {
    if (!safariGesture || pinch) return;
    event.preventDefault();
    if (Number.isFinite(event.scale)) zoom(safariGesture.view.scale * event.scale, safariGesture.point, safariGesture.view);
  }, { passive: false });
  listen(svg, "gestureend", () => { safariGesture = null; });
  listen(svg, "keydown", event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (["+", "="].includes(event.key)) zoom(view.scale * 1.5);
    else if (event.key === "-") zoom(view.scale / 1.5);
    else if (["0", "Home", "Escape"].includes(event.key)) reset();
    else if (view.scale > 1 && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      render({ ...view, x: view.x + ({ ArrowLeft: 60, ArrowRight: -60 }[event.key] || 0), y: view.y + ({ ArrowUp: 60, ArrowDown: -60 }[event.key] || 0) });
    } else return;
    event.preventDefault();
  });
  listen(svg, "focusin", event => {
    if (!event.target.matches?.(".map-marker") || view.scale <= 1) return;
    const x = Number(event.target.getAttribute("cx")) * view.scale + view.x;
    const y = Number(event.target.getAttribute("cy")) * view.scale + view.y;
    if (x < 20 || x > WIDTH - 20 || y < 20 || y > HEIGHT - 20) {
      render({ ...view, x: view.x + WIDTH / 2 - x, y: view.y + HEIGHT / 2 - y });
    }
  });
  render();
  return { reset, refresh: () => render(), destroy: () => { removers.forEach(remove => remove()); reset(); } };
}
