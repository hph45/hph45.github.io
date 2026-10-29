import { normalizeInstagramHandle } from "./profile.js";

export function createFriendMatchmaking({ client, document, window, action }) {
  const $ = selector => document.querySelector(selector);
  const launch = $("#matchmake-friends");
  const dialog = $("#friend-match-dialog");
  const form = $("#friend-match-form");
  const inputs = [$("#friend-instagram-first"), $("#friend-instagram-second")];
  const error = $("#friend-match-error");
  const success = $("#friend-match-success");
  const submit = $("#submit-friend-match");
  let available = false, busy = false, generation = 0, overflow = null;

  function setBusy(value) {
    busy = value; submit.disabled = value;
    inputs.forEach(input => { input.disabled = value; });
    submit.textContent = value ? "Sending…" : "Suggest this match";
  }
  function clear() {
    generation++; form.reset(); form.hidden = false; success.hidden = true;
    error.hidden = true; error.textContent = "";
    inputs.forEach(input => input.removeAttribute("aria-invalid"));
    setBusy(false);
    if (overflow !== null) { document.body.style.overflow = overflow; overflow = null; }
  }
  function close() {
    if (dialog.open) dialog.close();
    clear();
  }
  function open() {
    if (!available || dialog.open) return;
    clear(); overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    dialog.showModal(); inputs[0].focus();
  }
  function showError(message, input) {
    error.textContent = message; error.hidden = false;
    if (input) { input.setAttribute("aria-invalid", "true"); input.focus(); }
  }
  action(form, "submit", async () => {
    if (!available || busy || !dialog.open) return;
    error.hidden = true; inputs.forEach(input => input.removeAttribute("aria-invalid"));
    const handles = inputs.map(input => normalizeInstagramHandle(input.value));
    const invalid = handles.findIndex(handle => !handle);
    if (invalid >= 0) { showError("Enter a valid Instagram username or profile link for each friend.", inputs[invalid]); return; }
    if (handles[0] === handles[1]) { showError("Choose two different Instagram accounts.", inputs[1]); return; }
    const version = generation; setBusy(true);
    try {
      const { data, error: failure } = await client.rpc("suggest_matchmaking_friends", {
        p_first_instagram: handles[0], p_second_instagram: handles[1],
      });
      if (version !== generation) return;
      if (failure || data !== true) throw failure || new Error("Suggestion unavailable");
      form.hidden = true; success.hidden = false;
      form.reset(); $("#friend-match-done").focus();
    } catch (failure) {
      if (version !== generation) return;
      showError(failure?.message === "FRIEND_SUGGESTION_LIMIT"
        ? "You can suggest up to five matches in 24 hours. Please try again later."
        : "We couldn’t save your suggestion. Please try again.");
    } finally { if (version === generation) setBusy(false); }
  });
  const closed = () => { if (!dialog.open) clear(); };
  launch.addEventListener("click", open);
  $("#friend-match-cancel").addEventListener("click", close);
  $("#friend-match-done").addEventListener("click", close);
  dialog.addEventListener("close", closed);
  return {
    setAvailable(value) { available = Boolean(value); launch.hidden = !available; if (!available) close(); },
    reset() { available = false; launch.hidden = true; close(); },
    destroy() {
      available = false; launch.hidden = true; close();
      launch.removeEventListener("click", open);
      $("#friend-match-cancel").removeEventListener("click", close);
      $("#friend-match-done").removeEventListener("click", close);
      dialog.removeEventListener("close", closed);
    },
  };
}
