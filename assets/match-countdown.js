// One UTC deadline for the homepage and every matchmaking view.
export const FIRST_MATCH_AT = Date.parse("2026-11-02T00:00:00Z");
const UNITS = ["days", "hours", "minutes", "seconds"];

export function countdownParts(now = Date.now()) {
  const total = Math.max(0, Math.ceil((FIRST_MATCH_AT - now) / 1000));
  return [Math.floor(total / 86400), Math.floor(total / 3600) % 24, Math.floor(total / 60) % 60, total % 60];
}

export function startMatchCountdown({ document, window, now = Date.now }) {
  const clocks = [...document.querySelectorAll("[data-match-countdown]")].map(root => {
    const clock = root.querySelector("[data-countdown-clock]");
    clock.setAttribute("role", "timer");
    clock.setAttribute("aria-live", "off");
    const values = [];
    let letterIndex = 15;
    clock.replaceChildren();
    for (const [i, unit] of UNITS.entries()) {
      if (i) {
        const colon = document.createElement("span");
        colon.className = "countdown-colon"; colon.textContent = ":";
        colon.setAttribute("aria-hidden", "true");
        colon.style.setProperty("--letter-index", letterIndex++);
        clock.append(colon);
      }
      const group = document.createElement("span"); group.className = "countdown-unit";
      group.setAttribute("aria-hidden", "true");
      const value = document.createElement("span"); value.className = "countdown-value";
      value.dataset.countdownPart = unit;
      const label = document.createElement("span"); label.className = "countdown-unit-label"; label.textContent = unit;
      values.push({ value, firstIndex: letterIndex }); letterIndex += 2;
      group.append(value, label); clock.append(group);
    }
    return { root, clock, values };
  });
  let timer, destroyed = false;
  function pause() { window.clearTimeout(timer); }
  function update() {
    pause();
    if (destroyed || !clocks.length || document.hidden) return;
    const time = now(), parts = countdownParts(time);
    const complete = time >= FIRST_MATCH_AT;
    for (const { root, clock, values } of clocks) {
      root.dataset.countdownState = complete ? "complete" : "running";
      clock.setAttribute("aria-label", complete ? "The countdown to the first matches is complete." : parts.map((value, i) => `${value} ${value === 1 ? UNITS[i].slice(0, -1) : UNITS[i]}`).join(", ") + " until the first matches.");
      for (const [i, { value, firstIndex }] of values.entries()) {
        const digits = String(parts[i]).padStart(2, "0");
        while (value.children.length < digits.length) {
          const digit = document.createElement("span"); digit.className = "countdown-digit";
          digit.style.setProperty("--letter-index", firstIndex + value.children.length);
          value.append(digit);
        }
        while (value.children.length > digits.length) value.lastChild.remove();
        [...value.children].forEach((digit, index) => {
          // Keep the same elements so changing seconds never restarts animation.
          if (digit.textContent !== digits[index]) digit.textContent = digits[index];
        });
      }
    }
    if (!complete) timer = window.setTimeout(update, 1000 - (time % 1000) + 10);
  }
  document.addEventListener("visibilitychange", update);
  window.addEventListener("pageshow", update);
  window.addEventListener("pagehide", pause);
  update();
  return { destroy() {
    destroyed = true; pause();
    document.removeEventListener("visibilitychange", update);
    window.removeEventListener("pageshow", update);
    window.removeEventListener("pagehide", pause);
  } };
}

if (typeof document !== "undefined" && typeof window !== "undefined") startMatchCountdown({ document, window });
