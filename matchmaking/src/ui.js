import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, PROFILE_TABLE, getAuthRedirect } from "./config.js";
import { INTENTS, profileIntents, ageOn, birthdayBounds, makeProfile, validateProfile, locationLabel, preferenceDetails, bookEditTime, favoriteBooks, normalizeLinkedInURL } from "./profile.js";
import { attachAutocomplete } from "./autocomplete.js";
import { attachAgeRange } from "./age-range.js";
import { renderCommunityMap } from "./map.js";
import { attachMapZoom } from "./map-zoom.js";
import { loadReviewCatalog } from "./review-catalog.js";
import { createCoverLookup, renderTopBooks } from "./top-books.js";
import { renderRisingBooks } from "./rising-books.js";

export function createMatchmakingApp({ client, document, window, fetch = window.fetch.bind(window) }) {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const form = $("#profile-form");
  const views = $$("main > section");
  const steps = $$("#profile-form > fieldset[data-step]");
  const field = (name) => form.querySelector(`[name="${name}"]`);
  const text = (selector, value) => { $(selector).textContent = value; };
  const pending = new Set();
  let user = null;
  let profile = null;
  let currentStep = 0;
  let generation = 0;
  let authReady = false;
  let subscription;
  let mutationPending = false;
  let selectedIntents = [];
  let bookTimer;
  let communityRequest = 0;
  const autocompletes = [];
  const ageRange = attachAgeRange($(".age-range"));
  const mapZoom = attachMapZoom(document);
  const loadCover = createCoverLookup(client, window);
  let reviewCatalog;

  try {
    const stored = window.localStorage.getItem("zebra-matchmaking-intents");
    selectedIntents = profileIntents(stored === null
      ? { intent: window.localStorage.getItem("zebra-matchmaking-intent") }
      : { intents: JSON.parse(stored) });
  } catch { /* Storage is optional. */ }

  function notice(message = "") {
    text("#notice", message);
    $("#notice").hidden = !message;
  }

  function showView(id, focus) {
    views.forEach((view) => { view.hidden = view.id !== id; });
    if (focus) $(focus)?.focus();
  }

  function action(element, event, handler) {
    element.addEventListener(event, (e) => {
      const work = Promise.resolve().then(() => handler(e)).catch(() => {
        notice("Something interrupted that request. Please try again.");
      });
      pending.add(work);
      void work.finally(() => pending.delete(work));
      // Prevent navigation synchronously; the handler may make an async request.
      if (event === "submit") e.preventDefault();
    });
  }

  function rememberIntents(intents) {
    selectedIntents = Object.keys(INTENTS).filter(intent => intents.includes(intent));
    try { window.localStorage.setItem("zebra-matchmaking-intents", JSON.stringify(selectedIntents)); } catch { /* No personal answers are stored here. */ }
    $$("[data-intent]").forEach((button) => button.setAttribute("aria-pressed", String(selectedIntents.includes(button.dataset.intent))));
  }
  rememberIntents(selectedIntents);

  async function checkGoogle() {
    text("#google-button-label", "Continue with Google");
    try {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
        headers: { apikey: SUPABASE_PUBLISHABLE_KEY }, signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error("Settings unavailable");
      const settings = await response.json();
      const unavailable = settings.external?.google === false;
      $("#google-sign-in").disabled = unavailable;
      $("#sign-in-status").hidden = !unavailable;
      return !unavailable;
    } catch {
      // An unavailable settings endpoint need not prevent an OAuth attempt.
      $("#google-sign-in").disabled = false;
      return true;
    }
  }

  function updatePreferenceFields() {
    const intents = $$('#profile-form [name="intents"]:checked').map(input => input.value);
    $$("[data-preferences]").forEach((group) => {
      group.hidden = !intents.includes(group.dataset.preferences);
      group.disabled = currentStep !== 2 || group.hidden;
    });
  }

  function showStep(index, focus = true) {
    currentStep = index;
    steps.forEach((step, i) => { step.hidden = i !== index; step.disabled = i !== index; });
    $$("[data-progress]").forEach((item) => {
      if (Number(item.dataset.progress) === index) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
    const titles = ["A little about you.", "Your favorite books.", "Your kind of people."];
    const descriptions = ["The basics, before the book.", "A little shelf that says a lot about you.", "Tell us what a good connection looks like."];
    text("#onboarding-title", titles[index]);
    text("#form-description", descriptions[index]);
    text("#next-step-label", index === 2 ? (profile ? "Save changes" : "Create my profile") : "Continue");
    $("#next-step-arrow").toggleAttribute("hidden", index === 2);
    $("#previous-step").hidden = index === 0;
    $("#cancel-edit").hidden = !profile;
    $("#form-error").hidden = true;
    form.querySelectorAll('[aria-invalid="true"]').forEach(input => {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-errormessage");
    });
    updatePreferenceFields();
    updateBookLock();
    autocompletes.forEach(control => control.close());
    if (focus) {
      $("#onboarding-title").focus();
      window.scrollTo(0, 0);
    }
  }

  function updateBookLock() {
    window.clearTimeout(bookTimer);
    const unlocks = bookEditTime(profile);
    const remaining = unlocks - Date.now();
    const locked = remaining > 0;
    steps[1].disabled = currentStep !== 1 || locked;
    const message = locked
      ? `You can change your books again ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(unlocks))}.`
      : "You can update your books now. Changes are available once every 24 hours.";
    text("#books-lock-note", message);
    $("#books-lock-note").hidden = currentStep !== 1 || !locked;
    text("#book-edit-status", message);
    if (locked) bookTimer = window.setTimeout(updateBookLock, Math.min(remaining + 50, 24 * 60 * 60 * 1000));
  }

  function openForm() {
    notice();
    resetForm();
    const values = profile || {
      intents: selectedIntents,
      display_name: user?.user_metadata?.given_name || user?.user_metadata?.full_name?.split(" ")[0] || "",
      age_min: 18, age_max: 80,
    };
    for (const input of form.querySelectorAll("[name]")) {
      if (input.type === "checkbox") {
        input.checked = input.name === "intents" ? profileIntents(values).includes(input.value)
          : input.name === "interested_in" ? (values.interested_in || []).includes(input.value)
          : input.name === "profile_consent" ? Boolean(profile) : values[input.name] === true;
      } else if (values[input.name] !== undefined) input.value = values[input.name] ?? (input.type === "range" ? input.defaultValue : "");
    }
    ageRange.sync();
    text("#form-eyebrow", profile ? "Edit your chapter" : "Your first chapter");
    showStep(0, false);
    showView("onboarding-view", "#onboarding-title");
    // The desktop intro is sticky: focusing it alone can leave the form's first
    // questions above the viewport when editing from a scrolled dashboard.
    window.scrollTo(0, 0);
  }

  function resetForm() {
    form.reset();
    ageRange.sync();
    // Hidden inputs reflect .value into their default value, unlike text inputs.
    // Clear catalog IDs explicitly so a later account never inherits old picks.
    form.querySelectorAll('input[type="hidden"]').forEach(input => { input.value = ""; });
  }

  function readProfile() {
    const values = {};
    // FormData omits disabled earlier steps, so collect the known controls directly.
    for (const input of form.querySelectorAll("[name]")) {
      if (!["intents", "interested_in"].includes(input.name)) values[input.name] = input.type === "checkbox" ? input.checked : input.value;
    }
    values.intents = [...form.querySelectorAll('[name="intents"]:checked')].map(input => input.value);
    values.interested_in = [...form.querySelectorAll('[name="interested_in"]:checked')].map((input) => input.value);
    return makeProfile(values, { isActive: profile?.is_active ?? true });
  }

  function detail(container, title, value) {
    const group = document.createElement("div");
    const heading = document.createElement("h3");
    heading.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.className = "preserve-lines";
    paragraph.textContent = value;
    group.append(heading, paragraph);
    container.append(group);
  }

  function linkedInDetail(container, profile) {
    const url = normalizeLinkedInURL(profile.business_linkedin_url);
    if (!profileIntents(profile).includes("business_partners") || !url) return;
    const group = document.createElement("div");
    const heading = document.createElement("h3");
    heading.textContent = "LinkedIn";
    const paragraph = document.createElement("p");
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "View LinkedIn page ";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "icon-arrow"); icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true"); icon.setAttribute("focusable", "false");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "/assets/icons.svg#arrow-up-right");
    icon.append(use); link.append(icon);
    paragraph.append(link);
    group.append(heading, paragraph);
    container.append(group);
  }

  function renderDashboard(focus = false) {
    text("#account-name", profile.display_name);
    text("#profile-category", profileIntents(profile).map(intent => INTENTS[intent]).join(" · "));
    text("#dashboard-title", `Hello, ${profile.display_name}.`);
    text("#profile-name", `${profile.display_name}, ${ageOn(profile.birth_date)}`);
    text("#profile-location", locationLabel(profile));
    text("#profile-book", profile.favorite_book);
    text("#profile-author", `by ${profile.favorite_author}`);
    const extraBooks = $("#profile-extra-books");
    extraBooks.replaceChildren();
    favoriteBooks(profile).slice(1).forEach(book => detail(extraBooks, book.title, `by ${book.author}`));
    updateBookLock();
    text("#participation-description", profile.is_active ? "You’re on the list for future introductions." : "Your profile is saved. You won’t receive new matches while paused.");
    text("#pause-matching", profile.is_active ? "Pause matching" : "Resume matching");
    text("#account-email", user.email || "your Google account");
    $("#email-preference").checked = profile.email_matches;
    const preferences = $("#profile-preferences");
    preferences.replaceChildren();
    preferenceDetails(profile).forEach(([title, value]) => detail(preferences, title, value));
    linkedInDetail(preferences, profile);
    showView("dashboard-view", focus ? "#dashboard-title" : undefined);
  }

  async function loadMatches(version) {
    const container = $("#matches-list");
    container.textContent = "Looking for your introductions…";
    try {
      const { data, error } = await client.rpc("get_my_matchmaking_matches");
      if (version !== generation) return;
      container.replaceChildren();
      if (error) throw error;
      if (!data?.length) {
        const empty = document.createElement("div");
        empty.className = "empty-matches";
        detail(empty, "Your next chapter is still being written.", "Weekly introductions are coming soon. When you have a match, you’ll find them here.");
        container.append(empty);
        return;
      }
      for (const match of data) {
        const article = document.createElement("article");
        article.className = "match-card";
        const tag = document.createElement("p");
        tag.className = "eyebrow";
        tag.textContent = `${INTENTS[match.intent] || "Introduction"} · Week of ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${match.week_start}T00:00:00Z`))}`;
        const heading = document.createElement("h3");
        heading.textContent = `${match.display_name}, ${match.age}`;
        const place = document.createElement("p");
        place.className = "muted";
        place.textContent = locationLabel(match);
        article.append(tag, heading, place);
        favoriteBooks(match).forEach(book => detail(article, book.title, `by ${book.author}`));
        detail(article, "Why you crossed paths", match.reason);
        if (match.intent === "friends") detail(article, "Time well spent", match.friendship_interests);
        if (match.intent === "business_partners") {
          detail(article, "What they’re building", match.business_about);
          detail(article, "What they bring", match.business_skills);
          detail(article, "Who they’d like to meet", match.business_seeking);
          linkedInDetail(article, match);
        }
        container.append(article);
      }
    } catch {
      if (version !== generation) return;
      container.textContent = "We couldn’t load your matches. ";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "text-button";
      retry.textContent = "Try again";
      action(retry, "click", () => loadMatches(generation));
      container.append(retry);
    }
  }

  async function loadCommunity(version) {
    const request = ++communityRequest;
    try {
      const [{ data, error }, catalog] = await Promise.all([
        client.rpc("get_matchmaking_community"), reviewCatalog ||= loadReviewCatalog(fetch),
      ]);
      if (version !== generation || request !== communityRequest) return;
      if (error || !data) throw error || new Error("No community data");
      renderCommunityMap(document, data);
      mapZoom.refresh();
      const coverWork = Promise.all([
        renderTopBooks(document, data.top_books || [], catalog, loadCover),
        renderRisingBooks(document, data.rising_books || [], data.top_books || [], catalog, loadCover),
      ]);
      pending.add(coverWork);
      void coverWork.finally(() => pending.delete(coverWork));
      text("#top-books-status", data.top_books?.length ? "" : "The first favorites will appear here as readers join.");
    } catch {
      if (version !== generation || request !== communityRequest) return;
      text("#member-count", "—");
      text("#map-selection", "We couldn’t load the community right now.");
      $("#rising-books-list").replaceChildren();
      $("#rising-books-status").hidden = false;
      text("#rising-books-status", "Rising favorites are temporarily unavailable.");
      text("#top-books-status", "The community shelf is temporarily unavailable. ");
      const retry = document.createElement("button"); retry.type = "button"; retry.className = "text-button"; retry.textContent = "Try again";
      action(retry, "click", () => loadCommunity(generation)); $("#top-books-status").append(retry);
    }
  }

  async function loadProfile(version = ++generation) {
    showView("loading-view");
    try {
      const { data, error } = await client.from(PROFILE_TABLE).select("*").eq("user_id", user.id).maybeSingle();
      if (version !== generation) return;
      if (error) throw error;
      profile = data;
      if (!profile) openForm();
      else {
        renderDashboard(true);
        await Promise.all([loadMatches(version), loadCommunity(version)]);
      }
    } catch {
      if (version === generation) showView("error-view");
    }
  }

  async function acceptSession(session) {
    const version = ++generation;
    user = session?.user || null;
    profile = null;
    mapZoom.reset();
    resetForm();
    window.clearTimeout(bookTimer);
    autocompletes.forEach(control => control.close());
    $("#account-tools").hidden = !user;
    $("#back-to-club").hidden = Boolean(user);
    text("#account-name", "");
    notice();
    if (user) await loadProfile(version);
    else {
      $$("#dashboard-view [id^='profile-'], #account-email, #matches-list, #top-books-list, #rising-books-list, #rising-books-status, #map-markers").forEach((element) => element.replaceChildren());
      if ($("#delete-dialog").open) $("#delete-dialog").close();
      showView("welcome-view");
    }
  }

  function setMutationBusy(busy) {
    mutationPending = busy;
    for (const selector of ["#pause-matching", "#email-preference", "#edit-profile", "#delete-account"]) $(selector).disabled = busy;
  }

  async function saveSettings(patch) {
    if (mutationPending || !profile || !user) return;
    const version = generation;
    setMutationBusy(true);
    notice();
    try {
      const { data, error } = await client.from(PROFILE_TABLE).update(patch).eq("user_id", user.id).select("*").single();
      if (version !== generation) return;
      if (error) throw error;
      profile = data;
      renderDashboard();
      notice("Your preferences are saved.");
    } catch {
      if (version !== generation) return;
      renderDashboard();
      notice("We couldn’t save that change. Your previous preference is still in place. Please try again.");
    } finally { setMutationBusy(false); }
  }

  action(form, "submit", async () => {
    if (mutationPending || !user) return;
    const values = readProfile();
    const errors = validateProfile(values, { consent: field("profile_consent").checked });
    const invalid = errors.find((error) => currentStep === 2 || error.step === currentStep);
    if (invalid) {
      showStep(invalid.step, false);
      text("#form-error", invalid.message);
      $("#form-error").hidden = false;
      const input = field(invalid.field);
      input?.setAttribute("aria-invalid", "true");
      input?.setAttribute("aria-errormessage", "form-error");
      input?.focus();
      return;
    }
    const controls = [...steps[currentStep].querySelectorAll("input, select, textarea")]
      .filter((input) => !input.disabled && !input.closest("fieldset[disabled]"));
    if (!controls.every((input) => input.reportValidity())) return;
    if (currentStep < 2) { showStep(currentStep + 1); return; }
    const version = generation;
    setMutationBusy(true);
    form.inert = true;
    $("#next-step").disabled = true;
    text("#next-step-label", "Saving…");
    try {
      const table = client.from(PROFILE_TABLE);
      const query = profile ? table.update(values).eq("user_id", user.id) : table.insert({ ...values, user_id: user.id });
      const { data, error } = await query.select("*").single();
      if (version !== generation) return;
      if (error) throw error;
      profile = data;
      rememberIntents(profileIntents(profile));
      renderDashboard(true);
      notice("Your profile is saved.");
      await Promise.all([loadMatches(version), loadCommunity(version)]);
    } catch (error) {
      if (version !== generation) return;
      text("#form-error", error?.message === "BOOKS_LOCKED"
        ? "Your books can be changed once every 24 hours. Please wait until your next update is available."
        : "We couldn’t save your profile. Your answers are still here—please try again.");
      $("#form-error").hidden = false;
    } finally {
      form.inert = false;
      $("#next-step").disabled = false;
      text("#next-step-label", profile ? "Save changes" : "Create my profile");
      setMutationBusy(false);
    }
  });

  $$("[data-intent]").forEach((button) => action(button, "click", () => {
    const intent = button.dataset.intent;
    rememberIntents(selectedIntents.includes(intent) ? selectedIntents.filter(value => value !== intent) : [...selectedIntents, intent]);
  }));
  $$('#profile-form [name="intents"]').forEach(input => action(input, "change", updatePreferenceFields));
  action($("#previous-step"), "click", () => showStep(Math.max(0, currentStep - 1)));
  action($("#edit-profile"), "click", openForm);
  action($("#cancel-edit"), "click", () => { resetForm(); renderDashboard(true); });
  action($("#retry-profile"), "click", () => user ? loadProfile() : acceptSession(null));
  action($("#pause-matching"), "click", () => saveSettings({ is_active: !profile.is_active }));
  action($("#email-preference"), "change", () => saveSettings({ email_matches: $("#email-preference").checked }));

  action($("#google-sign-in"), "click", async () => {
    notice();
    $("#google-sign-in").disabled = true;
    text("#google-button-label", "Opening Google…");
    try {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: "google", options: { redirectTo: getAuthRedirect(window.location), skipBrowserRedirect: true },
      });
      if (error || !data?.url) throw error || new Error("No sign-in URL");
      window.location.assign(data.url);
    } catch {
      notice("We couldn’t start Google sign-in. Please try again in a moment.");
      await checkGoogle();
    }
  });

  action($("#sign-out"), "click", async () => {
    $("#sign-out").disabled = true;
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
      await acceptSession(null);
    } catch { notice("We couldn’t sign you out. Please try again."); }
    finally { $("#sign-out").disabled = false; }
  });

  action($("#delete-account"), "click", () => {
    $("#delete-form").reset();
    $("#delete-error").hidden = true;
    $("#delete-dialog").showModal();
  });
  action($("#cancel-delete"), "click", () => $("#delete-dialog").close());
  action($("#delete-form"), "submit", async () => {
    if (!user || mutationPending || $("#delete-confirmation").value !== "DELETE") return;
    const version = generation;
    setMutationBusy(true);
    $("#confirm-delete").disabled = true;
    text("#confirm-delete", "Deleting…");
    try {
      const { error } = await client.functions.invoke("delete-matchmaking-account", { body: { confirmation: "DELETE" } });
      if (version !== generation) return;
      if (error) throw error;
      // A revoked session may already be gone after Auth deletes the account.
      await client.auth.signOut({ scope: "local" });
      await acceptSession(null);
      notice("Your matchmaking account has been deleted.");
    } catch {
      if (version !== generation) return;
      text("#delete-error", "We couldn’t delete your account. Please try again, or contact us for help.");
      $("#delete-error").hidden = false;
    } finally {
      $("#confirm-delete").disabled = false;
      text("#confirm-delete", "Delete account");
      setMutationBusy(false);
    }
  });

  form.noValidate = true;
  const bounds = birthdayBounds();
  field("birth_date").min = bounds.min;
  field("birth_date").max = bounds.max;

  autocompletes.push(attachAutocomplete(field("city"), {
    document, window, delay: 250,
    emptyMessage: "No city found. Try a nearby city or its local name.",
    async search(query) {
      const { data, error } = await client.rpc("search_matchmaking_cities", { query });
      if (error) throw error;
      return data || [];
    },
    describe: city => [city.name, [city.region, city.country].filter(Boolean).join(", ")],
    onSelect(city) { field("city_id").value = city.id; field("city").value = city.name; field("region").value = city.region; field("country").value = city.country; },
    onClear() { field("city_id").value = ""; field("region").value = ""; field("country").value = ""; },
  }));
  for (const suffix of ["", "_2", "_3"]) {
    autocompletes.push(attachAutocomplete(field(`favorite_book${suffix}`), {
      document, window,
      async search(query) {
        let result = await client.functions.invoke("search-books", { body: { query: query.slice(0, 120) } });
        if (result.error?.context?.status === 429) {
          await new Promise(resolve => window.setTimeout(resolve, 1000));
          result = await client.functions.invoke("search-books", { body: { query: query.slice(0, 120) } });
        }
        if (result.error) throw result.error;
        return result.data?.books || [];
      },
      describe: book => [book.title, book.author],
      onSelect(book) { field(`favorite_book${suffix}_id`).value = book.work_id; field(`favorite_book${suffix}`).value = book.title; field(`favorite_author${suffix}`).value = book.author; },
      onClear() { field(`favorite_book${suffix}_id`).value = ""; field(`favorite_author${suffix}`).value = ""; },
    }));
  }

  return {
    async start() {
      showView("loading-view");
      const initialURL = new URL(window.location.href);
      const hadOAuthError = initialURL.searchParams.has("error") || new URLSearchParams(initialURL.hash.slice(1)).has("error");
      const googleCheck = checkGoogle();
      const listener = client.auth.onAuthStateChange((_event, session) => {
        // Never await another Auth method in this callback: it holds Auth's lock.
        if (authReady && (session?.user?.id || null) !== (user?.id || null)) {
          window.setTimeout(() => {
            if ((session?.user?.id || null) !== (user?.id || null)) void acceptSession(session);
          }, 0);
        }
      });
      subscription = listener.data.subscription;
      try {
        const { data, error } = await client.auth.getSession();
        authReady = true;
        await acceptSession(data?.session);
        if (error || hadOAuthError) notice("Google sign-in wasn’t completed. Please try again.");
      } catch {
        authReady = true;
        await acceptSession(null);
        notice("We couldn’t restore your sign-in. Please try signing in again.");
      } finally {
        // Remove OAuth return values from browser history once the SDK has handled them.
        for (const name of ["code", "error", "error_code", "error_description"]) initialURL.searchParams.delete(name);
        if (/access_token=|error=|refresh_token=/.test(initialURL.hash)) initialURL.hash = "";
        window.history.replaceState({}, "", `${initialURL.pathname}${initialURL.search}${initialURL.hash}`);
        await googleCheck;
      }
    },
    async settled() { while (pending.size) await Promise.allSettled([...pending]); },
    destroy() { subscription?.unsubscribe(); generation++; window.clearTimeout(bookTimer); ageRange.destroy(); mapZoom.destroy(); autocompletes.forEach(control => control.destroy()); },
  };
}
