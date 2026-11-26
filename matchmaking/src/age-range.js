import { ageRangeLabel } from "./profile.js";

// Two native range inputs keep keyboard, touch, and screen-reader support.
export function attachAgeRange(root) {
  const [lower, upper] = root.querySelectorAll('input[type="range"]');
  const output = root.querySelector("output");
  const minimum = Number(lower.min);
  let maximum = 80;

  function sync(changed) {
    let low = Math.max(minimum, Math.min(maximum, Number(lower.value)));
    let high = Math.max(minimum, Math.min(maximum, Number(upper.value)));
    if (changed === upper) high = Math.max(low, high);
    else low = Math.min(low, high);
    lower.value = String(low);
    upper.value = String(high);
    lower.setAttribute("aria-valuemax", String(high));
    upper.setAttribute("aria-valuemin", String(low));
    lower.setAttribute("aria-valuetext", low === 80 && maximum === 80 ? "80 years and over" : `${low} years`);
    upper.setAttribute("aria-valuetext", high === 80 && maximum === 80 ? "80 years and over" : `${high} years`);
    output.value = maximum === 120 ? `${low}–${high}` : ageRangeLabel(low, high === 80 ? 120 : high);
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
    restore(profile = {}) {
      const low = profile[lower.name] ?? 18;
      const high = profile[upper.name] ?? 120;
      // The native pickers can save an exact age at or above the web's 80+ endpoint.
      maximum = low > 80 || (high >= 80 && high < 120) ? 120 : 80;
      lower.max = upper.max = String(maximum);
      root.querySelector(".age-range-scale span:last-child").textContent = maximum === 80 ? "80+" : "120";
      lower.value = String(low);
      upper.value = String(Math.min(maximum, high));
      sync();
    },
    bounds() {
      return { [lower.name]: Number(lower.value), [upper.name]: maximum === 80 && Number(upper.value) === 80 ? 120 : Number(upper.value) };
    },
    destroy() {
      for (const input of [lower, upper]) {
        input.removeEventListener("input", update);
        input.removeEventListener("change", update);
      }
    },
  };
}
