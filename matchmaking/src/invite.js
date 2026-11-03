import { normalizeInstagramHandle } from "./profile.js";
import { referralURL } from "./referrals.js";
import { attachProductGalleries } from "../../assets/product-gallery.js";

export function attachInvites(document, window, { getProfile, savePreference, draft, action, beginSignup, requestInstagram }) {
  const $ = selector => document.querySelector(selector);
  const buttons = [...document.querySelectorAll("[data-invite-friends]")];
  const dialog = $("#invite-dialog");
  const form = $("#invite-form");
  const productGallery = attachProductGalleries(dialog);
  const choices = [...form.querySelectorAll("[data-raffle-prize]")];
  const shareButton = $("#share-invite-link");
  const label = $("#invite-action-label");
  let version = 0, busy = false, destroyed = false, prize = "", awaitingInstagram = false, statusTimer;
  const pending = new Set();

  function error(message = "") { $("#invite-error").textContent = message; $("#invite-error").hidden = !message; }
  function setPrize(value) {
    prize = value || "";
    choices.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.rafflePrize === prize)));
  }
  function setBusy(value) {
    busy = value;
    for (const button of [...choices, shareButton]) button.disabled = value;
  }
  function resetLabel(value = "Invite friends") {
    window.clearTimeout(statusTimer);
    label.textContent = value;
  }
  async function saveChoice() {
    if (busy || destroyed) return;
    const profile = getProfile();
    if (!profile) { draft.rememberPrize(prize); return; }
    if (prize === (profile.merch_raffle_prize || "")) return;
    const current = version;
    setBusy(true); error(); resetLabel("Saving preference…");
    try {
      const saved = await savePreference({ merch_raffle_prize: prize || null });
      if (current !== version || destroyed) return;
      if (!saved) throw new Error("Not saved");
      draft.clear();
    } catch {
      if (current !== version || destroyed) return;
      setPrize(getProfile()?.merch_raffle_prize);
      error("We couldn’t save that preference. Please choose it again.");
    } finally { if (current === version && !destroyed) { setBusy(false); resetLabel(); } }
  }
  function open() {
    if (destroyed || busy) return;
    error(); resetLabel();
    productGallery.reset();
    setPrize(draft.prize || getProfile()?.merch_raffle_prize);
    if (!dialog.open) dialog.showModal();
    // A selection arriving from the Merch page is saved the same way as a tap.
    if (getProfile() && prize !== (getProfile().merch_raffle_prize || "")) form.dispatchEvent(new window.Event("change"));
  }
  function reset() {
    version++; awaitingInstagram = false; setBusy(false); resetLabel();
    if (dialog.open) dialog.close();
    setPrize(""); error(); productGallery.reset();
  }
  async function share() {
    if (busy || destroyed) return;
    const profile = getProfile();
    if (!profile) { draft.rememberPrize(prize); dialog.close(); beginSignup(); return; }
    const handle = normalizeInstagramHandle(profile.instagram_handle);
    if (!handle) {
      awaitingInstagram = true; draft.rememberPrize(prize); dialog.close(); requestInstagram(); return;
    }
    const current = version;
    const url = referralURL(handle);
    setBusy(true); resetLabel();
    try {
      if (typeof window.navigator.share === "function") {
        try {
          // No database await precedes this call, preserving mobile activation.
          await window.navigator.share({ title: "Zebra Book Club", text: "Join me on Zebra Book Club. Meet through the books you love.", url });
          return;
        } catch (reason) {
          if (reason?.name === "AbortError" || current !== version || destroyed) return;
        }
      }
      try {
        await window.navigator.clipboard.writeText(url);
        if (current !== version || destroyed) return;
        resetLabel("Link copied!");
        statusTimer = window.setTimeout(() => resetLabel(), 3500);
      } catch {
        if (current !== version || destroyed) return;
        // Manual copying is an exceptional browser fallback, not permanent
        // form clutter. The link contains only the public Instagram credit.
        window.prompt("Copy this link to invite your friends:", url);
      }
    } finally { if (current === version && !destroyed) setBusy(false); }
  }
  const onSubmit = event => {
    event.preventDefault();
    const work = share();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  for (const button of buttons) button.addEventListener("click", open);
  for (const button of choices) action(button, "click", () => {
    if (busy) return;
    setPrize(prize === button.dataset.rafflePrize ? "" : button.dataset.rafflePrize);
    error(); return saveChoice();
  });
  action(form, "change", saveChoice);
  form.addEventListener("submit", onSubmit);
  $("#invite-close").addEventListener("click", () => { if (!busy) { draft.dismiss(); dialog.close(); } });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); else draft.dismiss(); });
  return {
    open, reset,
    resume() { if (draft.shouldOpen && !document.querySelector("dialog[open]")) open(); },
    instagramSaved() { if (awaitingInstagram) { awaitingInstagram = false; open(); } },
    cancelInstagram() { awaitingInstagram = false; draft.dismiss(); },
    async settled() { while (pending.size) await Promise.allSettled([...pending]); },
    destroy() { reset(); destroyed = true; productGallery.destroy(); for (const button of buttons) button.removeEventListener("click", open); form.removeEventListener("submit", onSubmit); },
  };
}
