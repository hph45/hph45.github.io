import { ageRangeLabel } from "./profile.js";

// Two native range inputs keep keyboard, touch, and screen-reader support.
export function attachAgeRange(root) {
  const lower = root.querySelector('[name="age_min"]');
  const upper = root.querySelector('[name="age_max"]');
  const output = root.querySelector("output");
  const minimum = Number(lower.min);
  const maximum = Number(upper.max);

  function sync(changed) {
    let low = Math.max(minimum, Math.min(maximum, Number(lower.value)));
    let high = Math.max(minimum, Math.min(maximum, Number(upper.value)));
    if (changed === upper) high = Math.max(low, high);
    else low = Math.min(low, high);
    lower.value = String(low);
    upper.value = String(high);
    lower.setAttribute("aria-valuemax", String(high));
    upper.setAttribute("aria-valuemin", String(low));
    lower.setAttribute("aria-valuetext", low === maximum ? "80 years and over" : `${low} years`);
    upper.setAttribute("aria-valuetext", high === maximum ? "80 years and over" : `${high} years`);
    output.value = ageRangeLabel(low, high);
    root.style.setProperty("--age-lower", `${100 * (low - minimum) / (maximum - minimum)}%`);
    root.style.setProperty("--age-upper", `${100 * (high - minimum) / (maximum - minimum)}%`);
    // At the right endpoint the lower thumb must remain draggable to the left.
    root.classList.toggle("age-range-at-end", low === maximum);
  }
  const update = event => sync(event.target);
  for (const input of [lower, upper]) {
    input.addEventListener("input", update);
    input.addEventListener("change", update);
  }
  sync();
  return {
    sync: () => sync(),
    destroy() {
      for (const input of [lower, upper]) {
        input.removeEventListener("input", update);
        input.removeEventListener("change", update);
      }
    },
  };
}
