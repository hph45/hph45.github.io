// The same Auth client serves the matchmaking form and the guest community page.
export function openGuestCommunity(auth, page, window) {
  auth.onAuthStateChange((_event, session) => {
    if (session?.user) {
      page.removeAttribute("data-guest-ready");
      window.location.replace("/matchmaking/");
    } else {
      page.setAttribute("data-guest-ready", "");
    }
  });
  // A different tab may have signed in while this page was in the back/forward cache.
  window.addEventListener("pagehide", () => page.removeAttribute("data-guest-ready"));
  window.addEventListener("pageshow", event => {
    if (event.persisted) window.location.reload();
  });
}
