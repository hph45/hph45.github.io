import { renderCommunityMap } from "../../matchmaking/src/map.js";
import { attachMapZoom } from "../../matchmaking/src/map-zoom.js";
import { createMemberDirectory } from "./members.js";

const PAGE_SIZE = 12;
const count = value => Math.max(0, Math.trunc(Number(value) || 0));
const number = value => count(value).toLocaleString();
const share = (value, total) => total ? Math.min(100, count(value) / total * 100) : 0;
const percent = (value, total) => `${Number(share(value, total).toFixed(1))}%`;
const searchable = value => String(value).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
const denied = error => ["42501", "PGRST301", "PGRST302", "refresh_token_not_found", "refresh_token_already_used"].includes(error?.code)
  || [401, 403].includes(error?.status);

export function createAdminApp({ client, document, window }) {
  const $ = selector => document.querySelector(selector);
  const zoom = attachMapZoom(document);
  const directory = createMemberDirectory({ client, document, window, onDenied: redirect, isDenied: denied });
  const pending = new Set(), removers = [];
  let stats = null, mode = "countries", page = 0, userId = null;
  let generation = 0, started = false, destroyed = false, away = false, authTimer = null, subscription;

  function listen(target, event, handler) {
    target.addEventListener(event, handler);
    removers.push(() => target.removeEventListener(event, handler));
  }
  function track(promise) {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
    return promise;
  }
  function view(name) {
    for (const key of ["loading", "error", "admin"]) $(`#${key}-view`).hidden = key !== name;
  }
  function clear() {
    stats = null;
    directory.clear();
    $("#admin-view").hidden = true;
    for (const id of ["age-chart", "gender-chart", "connection-chart", "location-rows", "map-markers"]) $(`#${id}`).replaceChildren();
    for (const id of ["population-note", "updated-at", "member-count", "member-count-label", "map-selection", "location-status"]) $(`#${id}`).textContent = "";
    for (const id of ["summary-total", "summary-age", "summary-countries", "summary-cities"]) $(`#${id}`).textContent = "—";
    $("#previous-locations").disabled = $("#next-locations").disabled = true;
    zoom.reset();
  }
  function invalidate() {
    generation++;
    if (authTimer !== null) window.clearTimeout(authTimer);
    authTimer = null;
    clear();
  }
  function redirect() {
    invalidate();
    view("loading");
    // Same-origin, fixed destination: never accept a redirect URL from input.
    window.location.replace("/matchmaking/");
  }
  const current = request => !destroyed && !away && request === generation;

  function renderChart(selector, groups) {
    const fragment = document.createDocumentFragment();
    for (const group of groups) {
      const row = document.createElement("li");
      const label = document.createElement("div"); label.className = "bar-label";
      const name = document.createElement("span"); name.textContent = group.label;
      const values = document.createElement("span"); values.className = "bar-value";
      const readers = document.createElement("strong"); readers.textContent = number(group.member_count);
      const proportion = document.createElement("span"); proportion.textContent = percent(group.member_count, stats.total_members);
      values.append(readers, proportion); label.append(name, values);
      const track = document.createElement("div"); track.className = "bar-track"; track.setAttribute("aria-hidden", "true");
      const fill = document.createElement("div"); fill.className = "bar-fill"; fill.style.width = `${share(group.member_count, stats.total_members)}%`;
      track.append(fill); row.append(label, track); fragment.append(row);
    }
    $(selector).replaceChildren(fragment);
  }

  function renderLocations() {
    if (!stats) return;
    const query = searchable($("#location-search").value.trim());
    const cities = mode === "cities";
    const rows = stats[mode].filter(row => searchable(cities ? [row.name, row.region, row.country].join(" ") : row.country).includes(query));
    page = Math.min(page, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
    const first = page * PAGE_SIZE;
    const fragment = document.createDocumentFragment();
    for (const row of rows.slice(first, first + PAGE_SIZE)) {
      const tr = document.createElement("tr");
      const label = document.createElement("th"); label.scope = "row";
      label.textContent = cities ? row.name : row.country;
      if (cities) {
        const detail = document.createElement("span"); detail.className = "location-detail";
        detail.textContent = [row.region, row.country].filter(Boolean).join(", "); label.append(detail);
      }
      const readers = document.createElement("td"); readers.textContent = number(row.member_count);
      const proportion = document.createElement("td"); proportion.textContent = percent(row.member_count, stats.total_members);
      tr.append(label, readers, proportion); fragment.append(tr);
    }
    $("#location-rows").replaceChildren(fragment);
    $("#location-caption").textContent = `Readers by ${cities ? "city" : "country"}`;
    for (const button of document.querySelectorAll("[data-location-mode]")) button.setAttribute("aria-pressed", String(button.dataset.locationMode === mode));
    $("#location-empty").hidden = rows.length > 0;
    $("#location-empty").textContent = query ? "No matching locations." : "No locations to show yet.";
    $("#location-status").textContent = rows.length ? `${first + 1}–${Math.min(first + PAGE_SIZE, rows.length)} of ${number(rows.length)}` : "0 locations";
    $("#previous-locations").disabled = page === 0;
    $("#next-locations").disabled = first + PAGE_SIZE >= rows.length;
  }

  function render(data) {
    if (!data || !Number.isFinite(data.total_members) || !["age_groups", "genders", "connection_types", "cities", "countries"].every(key => Array.isArray(data[key]))) {
      throw new Error("Invalid statistics response");
    }
    stats = data;
    const total = count(data.total_members), active = Math.min(total, count(data.active_members));
    $("#summary-total").textContent = number(total);
    $("#summary-age").textContent = data.median_age === null ? "—" : Number(data.median_age).toLocaleString(undefined, { maximumFractionDigits: 1 });
    $("#summary-countries").textContent = number(data.country_count);
    $("#summary-cities").textContent = number(data.city_count);
    $("#population-note").textContent = `${number(total)} ${total === 1 ? "profile" : "profiles"} · ${number(active)} active · ${number(total - active)} paused`;
    const updated = new Date(data.generated_at);
    $("#updated-at").textContent = Number.isNaN(updated.getTime()) ? "Updated just now" : `Updated ${updated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    renderChart("#age-chart", data.age_groups);
    renderChart("#gender-chart", data.genders);
    renderChart("#connection-chart", data.connection_types);
    renderCommunityMap(document, data);
    zoom.reset();
    renderLocations();
    view("admin");
  }

  async function load() {
    if (destroyed || away) return;
    const request = ++generation;
    clear(); view("loading");
    $("#refresh").disabled = $("#retry").disabled = true;
    try {
      const session = await client.auth.getSession();
      if (!current(request)) return;
      if (session.error) throw session.error;
      userId = session.data.session?.user.id || null;
      if (!userId) { redirect(); return; }
      // Session presence is only a convenience. This RPC checks the signed JWT
      // against the server's allowlist, including when access has been revoked.
      const result = await client.rpc("get_matchmaking_admin_stats");
      if (!current(request)) return;
      if (result.error) throw result.error;
      render(result.data);
      await directory.start();
    } catch (error) {
      if (!current(request)) return;
      clear();
      if (denied(error)) redirect();
      else view("error");
    } finally {
      if (current(request)) $("#refresh").disabled = $("#retry").disabled = false;
    }
  }

  for (const id of ["refresh", "retry"]) listen($(`#${id}`), "click", () => { void track(load()); });
  for (const button of document.querySelectorAll("[data-location-mode]")) listen(button, "click", () => {
    mode = button.dataset.locationMode; page = 0; renderLocations();
  });
  listen($("#location-search"), "input", () => { page = 0; renderLocations(); });
  listen($("#previous-locations"), "click", () => { page = Math.max(0, page - 1); renderLocations(); });
  listen($("#next-locations"), "click", () => { page++; renderLocations(); });
  listen(window, "pagehide", () => { away = true; invalidate(); view("loading"); });
  listen(window, "pageshow", event => {
    if (event.persisted) { away = false; void track(load()); }
  });

  return {
    start() {
      if (started || destroyed) return Promise.resolve();
      started = true;
      subscription = client.auth.onAuthStateChange((event, session) => {
        if (destroyed || event === "INITIAL_SESSION") return;
        const next = session?.user.id || null;
        if (event !== "SIGNED_OUT" && next === userId) return;
        invalidate(); userId = next;
        if (!next) { redirect(); return; }
        view("loading");
        // Leave Supabase's auth callback before making another auth request.
        authTimer = window.setTimeout(() => { authTimer = null; void track(load()); }, 0);
      }).data.subscription;
      return track(load());
    },
    async settled() {
      while (pending.size || authTimer !== null) {
        await Promise.all([...pending]);
        if (authTimer !== null) await new Promise(resolve => window.setTimeout(resolve, 0));
      }
      await directory.settled();
    },
    destroy() {
      destroyed = true; invalidate(); view("loading");
      subscription?.unsubscribe();
      removers.forEach(remove => remove());
      zoom.destroy();
      directory.destroy();
    },
  };
}
