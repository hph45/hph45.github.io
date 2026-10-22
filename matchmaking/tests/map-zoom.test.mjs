import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { attachMapZoom } from "../src/map-zoom.js";

function setup(t) {
  const window = new Window();
  const { document } = window;
  document.body.innerHTML = `<svg id="world-map" viewBox="0 0 1000 500"><g id="map-content"><g id="map-markers">
    <circle class="map-marker" data-map-radius="5" cx="100" cy="100" r="5"/></g></g></svg>
    <button id="map-zoom-in"></button><button id="map-zoom-out"></button><button id="map-reset"></button><span id="map-zoom-status"></span>`;
  const $ = selector => document.querySelector(selector), svg = $("#world-map");
  svg.getBoundingClientRect = () => ({ left: 10, top: 20, width: 1000, height: 500 });
  const control = attachMapZoom(document);
  t.after(async () => { control.destroy(); await window.happyDOM.close(); });
  const view = () => $("#map-content").getAttribute("transform").match(/-?[\d.]+/g).map(Number);
  const touch = (name, points, cancelable = true) => {
    const event = new window.Event(name, { bubbles: true, cancelable });
    Object.defineProperty(event, "touches", { value: points.map(([x, y], identifier) => ({ clientX: x + 10, clientY: y + 20, identifier })) });
    svg.dispatchEvent(event); return event;
  };
  const pointer = (name, x, y, pointerType = "mouse") => svg.dispatchEvent(new window.PointerEvent(name, {
    pointerId: 1, pointerType, button: 0, clientX: x + 10, clientY: y + 20, bubbles: true,
  }));
  return { window, $, svg, control, view, touch, pointer };
}

test("zoom buttons stay within 1–8×, preserve the outline/dot alignment, and reset", t => {
  const { $, view } = setup(t);
  assert.deepEqual(view(), [0, 0, 1]);
  assert.equal($("#map-zoom-out").disabled, true);
  $("#map-zoom-in").click();
  assert.deepEqual(view(), [-250, -125, 1.5]);
  assert.equal(Number($("circle").getAttribute("r")), 5 / Math.sqrt(1.5));
  assert.equal($("circle").getAttribute("cx"), "100", "both layers share the same transform");
  for (let i = 0; i < 10; i++) $("#map-zoom-in").click();
  assert.equal(view()[2], 8);
  assert.equal($("#map-zoom-in").disabled, true);
  $("#map-reset").click();
  assert.deepEqual(view(), [0, 0, 1]);
  assert.equal($("#map-reset").disabled, true);
  assert.equal($("#map-zoom-status").textContent, "Map zoom 100 percent");
});

test("normal wheel scrolling passes through; trackpad pinch zooms at the pointer", t => {
  const { window, svg, view } = setup(t);
  const scroll = new window.WheelEvent("wheel", { deltaY: 100, cancelable: true });
  svg.dispatchEvent(scroll);
  assert.equal(scroll.defaultPrevented, false);
  assert.deepEqual(view(), [0, 0, 1]);
  const pinch = new window.WheelEvent("wheel", { deltaY: -Math.log(2) * 100, ctrlKey: true, clientX: 760, clientY: 145, cancelable: true });
  svg.dispatchEvent(pinch);
  assert.equal(pinch.defaultPrevented, true);
  assert.deepEqual(view(), [-750, -125, 2]);
});

test("mouse drag pans within map bounds and touch pointers never hijack page scrolling", t => {
  const { $, pointer, view, window, svg } = setup(t);
  $("#map-zoom-in").click();
  pointer("pointerdown", 500, 250); pointer("pointermove", 600, 300); pointer("pointerup", 600, 300);
  assert.deepEqual(view(), [-150, -75, 1.5]);
  const click = new window.Event("click", { cancelable: true }); svg.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true, "a drag must not select an accidental city");
  pointer("pointerdown", 500, 250); pointer("pointermove", 5000, 5000); pointer("pointerup", 5000, 5000);
  assert.deepEqual(view(), [0, 0, 1.5]);
  pointer("pointerdown", 500, 250, "touch"); pointer("pointermove", 600, 300, "touch");
  assert.deepEqual(view(), [0, 0, 1.5]);
});

test("mobile uses two fingers to zoom/pan and leaves one-finger scrolling alone at every zoom", t => {
  const { touch, view } = setup(t);
  assert.equal(touch("touchstart", [[300, 250]]).defaultPrevented, false);
  assert.equal(touch("touchmove", [[300, 350]]).defaultPrevented, false);
  assert.deepEqual(view(), [0, 0, 1]);
  assert.equal(touch("touchstart", [[300, 250], [500, 250]]).defaultPrevented, true);
  assert.equal(touch("touchmove", [[200, 250], [600, 250]]).defaultPrevented, true);
  assert.deepEqual(view(), [-400, -250, 2]);
  touch("touchmove", [[300, 250], [700, 250]]);
  assert.deepEqual(view(), [-300, -250, 2]);
  touch("touchend", [[300, 250]]);
  assert.equal(touch("touchmove", [[300, 350]]).defaultPrevented, false);
  assert.deepEqual(view(), [-300, -250, 2]);
  touch("touchcancel", []);
  touch("touchstart", [[300, 250], [500, 250]], false);
  touch("touchmove", [[100, 250], [700, 250]], false);
  assert.deepEqual(view(), [-300, -250, 2], "a browser-owned gesture is not overridden");
});

test("keyboard users can zoom, pan, reset, and reach dots outside the current viewport", t => {
  const { $, window, svg, view, control } = setup(t);
  const key = value => svg.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, cancelable: true, bubbles: true }));
  key("+"); key("ArrowLeft");
  assert.deepEqual(view(), [-190, -125, 1.5]);
  $("circle").dispatchEvent(new window.Event("focusin", { bubbles: true }));
  const [x, y, scale] = view();
  assert.ok(100 * scale + x >= 0 && 100 * scale + y >= 0);
  key("Home"); assert.deepEqual(view(), [0, 0, 1]);
  control.destroy(); key("+"); $("#map-zoom-in").click();
  assert.deepEqual(view(), [0, 0, 1], "destroy removes all listeners");
});

test("pinch coordinates stay correct on a narrow, letterboxed mobile map", t => {
  const { svg, touch, view } = setup(t);
  svg.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 250 });
  touch("touchstart", [[100, 125], [300, 125]]);
  touch("touchmove", [[0, 125], [400, 125]]);
  assert.deepEqual(view(), [-500, -250, 2]);
});
