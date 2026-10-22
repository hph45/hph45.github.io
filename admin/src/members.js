import { INTENTS, GENDERS, ageRangeLabel, normalizeLinkedInURL } from "../../matchmaking/src/profile.js";

export function createMemberDirectory({ client, document, window, onDenied, isDenied }) {
  const $ = selector => document.querySelector(selector);
  const pending = new Set(), removers = [];
  const filters = ["member-search", "member-intent", "member-gender", "member-min-age", "member-max-age"].map(id => $(`#${id}`));
  let generation = 0, page = 1, active = false, destroyed = false, timer = null;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function listen(target, event, handler) {
    target.addEventListener(event, handler);
    removers.push(() => target.removeEventListener(event, handler));
  }
  function track(promise) {
    pending.add(promise); void promise.finally(() => pending.delete(promise)); return promise;
  }
  function clearContents() {
    $("#member-list").replaceChildren();
    $("#member-status").textContent = "";
    for (const id of ["members-loading", "members-error", "members-empty"]) $(`#${id}`).hidden = true;
    $("#previous-members").disabled = $("#next-members").disabled = true;
    $("#member-filter-error").hidden = true;
    $("#member-filter-error").textContent = "";
    for (const id of ["member-min-age", "member-max-age"]) $(`#${id}`).removeAttribute("aria-invalid");
  }
  function cancelSearch() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }
  function clear() {
    generation++; active = false; cancelSearch(); clearContents();
    filters.forEach(input => { input.disabled = true; });
  }
  function readFilters() {
    const inputs = [$("#member-min-age"), $("#member-max-age")];
    const ages = inputs.map(input => input.value === "" ? null : Number(input.value));
    const invalid = inputs.filter((input, i) => input.validity.badInput || (ages[i] !== null && (!Number.isInteger(ages[i]) || ages[i] < 18 || ages[i] > 120)));
    const reversed = ages[0] !== null && ages[1] !== null && ages[0] > ages[1];
    if (invalid.length || reversed) {
      for (const input of invalid.length ? invalid : inputs) input.setAttribute("aria-invalid", "true");
      $("#member-filter-error").textContent = invalid.length ? "Enter whole-number ages between 18 and 120, or leave them blank." : "Minimum age must be no greater than maximum age.";
      $("#member-filter-error").hidden = false;
      return null;
    }
    return {
      p_search: $("#member-search").value.trim(), p_intent: $("#member-intent").value || null,
      p_min_age: ages[0], p_max_age: ages[1], p_gender: $("#member-gender").value || null,
    };
  }
  function answers(title, rows) {
    const section = element("section");
    section.append(element("h3", "", title));
    const list = element("dl");
    for (const [label, value, url] of rows) {
      list.append(element("dt", "", label));
      const answer = element("dd", "", value || "Not provided");
      if (url) {
        const link = element("a", "", value); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
        answer.replaceChildren(link);
      }
      list.append(answer);
    }
    section.append(list); return section;
  }
  function profileRow(profile) {
    const row = element("li"), details = element("details"), summary = element("summary");
    const identity = element("span", "member-identity");
    identity.append(element("strong", "member-name", profile.display_name));
    identity.append(element("span", "member-location", `${profile.age} · ${[profile.city, profile.region, profile.country].filter(Boolean).join(", ")}`));
    identity.append(element("span", "member-types", profile.intents.map(type => INTENTS[type]).filter(Boolean).join(" · ") + (profile.is_active ? "" : " · Paused")));
    const books = element("span", "member-books");
    for (const [i, book] of profile.favorite_books.entries()) {
      const item = element("span", "member-book", `${i + 1}. ${book.title}`);
      item.append(element("span", "member-book-author", book.author)); books.append(item);
    }
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("viewBox", "0 0 24 24"); chevron.setAttribute("class", "member-chevron");
    chevron.setAttribute("aria-hidden", "true"); chevron.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "m6 9 6 6 6-6"); chevron.append(path);
    summary.append(identity, books, chevron); details.append(summary);
    const response = element("div", "member-answers");
    response.append(answers("Preferences", [
      ["Profile", profile.is_active ? "Active" : "Paused"],
      ["Where would you like to connect?", profile.location_preference === "same_city" ? "In my city or metro area" : "Open to anywhere"],
      ["Email me when a match is ready", profile.email_matches ? "Yes" : "No"],
    ]));
    if (profile.intents.includes("romance")) response.append(answers("Romance", [
      ["Your gender", GENDERS[profile.gender]],
      ["Who would you like to meet?", profile.interested_in.map(value => GENDERS[value]).filter(Boolean).join(", ")],
      ["Age range", ageRangeLabel(profile.age_min, profile.age_max)],
      ["Tell us about your ideal match.", profile.romance_ideal_match],
    ]));
    if (profile.intents.includes("friends")) response.append(answers("Friends", [["What would you enjoy doing together?", profile.friendship_interests]]));
    if (profile.intents.includes("business_partners")) response.append(answers("Business partners", [
      ["What are you working on, or hoping to build?", profile.business_about],
      ["What skills or experience do you bring?", profile.business_skills],
      ["What are you looking for in a partner?", profile.business_seeking],
      ["LinkedIn page", profile.business_linkedin_url, normalizeLinkedInURL(profile.business_linkedin_url)],
    ]));
    details.append(response); row.append(details); return row;
  }
  function render(data) {
    if (!data || !Array.isArray(data.profiles) || !Number.isFinite(data.total_count) || !Number.isInteger(data.page) || !Number.isInteger(data.page_size)) throw new Error("Invalid member response");
    const fragment = document.createDocumentFragment();
    for (const profile of data.profiles) fragment.append(profileRow(profile));
    $("#member-list").replaceChildren(fragment);
    $("#members-loading").hidden = true;
    $("#members-empty").hidden = data.profiles.length > 0;
    page = data.page;
    const first = (page - 1) * data.page_size;
    $("#member-status").textContent = data.total_count ? `${first + 1}–${first + data.profiles.length} of ${data.total_count.toLocaleString()} ${data.total_count === 1 ? "reader" : "readers"}` : "0 readers";
    $("#previous-members").disabled = page <= 1;
    $("#next-members").disabled = first + data.profiles.length >= data.total_count;
  }
  async function load() {
    if (!active || destroyed) return;
    cancelSearch();
    const request = ++generation;
    clearContents();
    const filterValues = readFilters();
    if (!filterValues) return;
    $("#members-loading").hidden = false;
    try {
      const result = await client.rpc("get_matchmaking_admin_profiles", {
        ...filterValues, p_page: page, p_page_size: 20,
      });
      if (request !== generation || !active || destroyed) return;
      if (result.error) throw result.error;
      render(result.data);
    } catch (error) {
      if (request !== generation || !active || destroyed) return;
      clearContents();
      if (isDenied(error)) onDenied();
      else $("#members-error").hidden = false;
    }
  }
  function queueFilterChange() {
    if (!active) return;
    page = 1; generation++; cancelSearch(); clearContents(); $("#members-loading").hidden = false;
    timer = window.setTimeout(() => { timer = null; void track(load()); }, 250);
  }
  for (const id of ["member-search", "member-min-age", "member-max-age"]) listen($(`#${id}`), "input", queueFilterChange);
  for (const id of ["member-intent", "member-gender"]) listen($(`#${id}`), "change", () => { page = 1; void track(load()); });
  listen($("#previous-members"), "click", () => { page = Math.max(1, page - 1); void track(load()); });
  listen($("#next-members"), "click", () => { page++; void track(load()); });
  listen($("#retry-members"), "click", () => { void track(load()); });
  return {
    start() {
      if (destroyed) return Promise.resolve();
      active = true;
      filters.forEach(input => { input.disabled = false; });
      return track(load());
    },
    clear,
    async settled() {
      while (pending.size || timer !== null) {
        await Promise.all([...pending]);
        if (timer !== null) await new Promise(resolve => window.setTimeout(resolve, 25));
      }
    },
    destroy() { destroyed = true; clear(); removers.forEach(remove => remove()); },
  };
}
