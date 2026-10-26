// Share only the public destination, never the current URL's OAuth parameters
// or anything from the signed-in reader's profile.
const INVITE_URL = "https://zebrabookclub.com/matchmaking";

export function attachInvites(document, window) {
  const buttons = [...document.querySelectorAll("[data-invite-friends]")];
  const dialog = document.querySelector("#invite-dialog");
  const input = document.querySelector("#invite-url");
  const copyButton = document.querySelector("#copy-invite-link");
  const help = document.querySelector("#invite-copy-help");
  const status = document.querySelector("#invite-status");
  let busy = false;
  let destroyed = false;
  let statusTimer;

  input.value = INVITE_URL;

  function setBusy(value) {
    busy = value;
    for (const button of [...buttons, copyButton]) button.disabled = value;
  }

  function showManualCopy() {
    if (destroyed) return;
    help.textContent = "Select and copy this link to send to a friend.";
    if (!dialog.open) dialog.showModal();
    input.focus();
    input.select();
  }

  async function copyLink() {
    try {
      await window.navigator.clipboard.writeText(INVITE_URL);
      if (destroyed) return;
      if (dialog.open) dialog.close();
      window.clearTimeout(statusTimer);
      status.textContent = "Link copied. Send it to a friend.";
      status.hidden = false;
      statusTimer = window.setTimeout(() => { status.hidden = true; }, 4000);
    } catch {
      showManualCopy();
    }
  }

  async function invite() {
    if (busy || destroyed) return;
    setBusy(true);
    window.clearTimeout(statusTimer);
    status.hidden = true;
    try {
      if (typeof window.navigator.share === "function") {
        try {
          // Call directly from the click so browsers retain user activation.
          await window.navigator.share({
            title: "Zebra Book Club",
            text: "Join me on Zebra Book Club. Meet through the books you love.",
            url: INVITE_URL,
          });
          return;
        } catch (error) {
          if (error?.name === "AbortError" || destroyed) return;
        }
      }
      await copyLink();
    } finally {
      if (!destroyed) setBusy(false);
    }
  }

  async function copyManually() {
    if (busy || destroyed) return;
    setBusy(true);
    try { await copyLink(); }
    finally { if (!destroyed) setBusy(false); }
  }

  for (const button of buttons) button.addEventListener("click", invite);
  copyButton.addEventListener("click", copyManually);
  return {
    destroy() {
      destroyed = true;
      window.clearTimeout(statusTimer);
      status.hidden = true;
      if (dialog.open) dialog.close();
      for (const button of buttons) button.removeEventListener("click", invite);
      copyButton.removeEventListener("click", copyManually);
    },
  };
}
