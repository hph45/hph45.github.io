import { geoNaturalEarth1 } from "d3-geo";

// Keep the marker projection identical to scripts/build-matchmaking-geography.mjs.
export function worldProjection() {
  return geoNaturalEarth1().fitExtent([[14, 14], [986, 486]], { type: "Sphere" });
}

export function renderCommunityMap(document, community, { showCounts = true, hoverOnly = false } = {}) {
  const group = document.querySelector("#map-markers");
  group.replaceChildren();
  const total = Number(community.total_members) || 0;
  const message = document.querySelector("#map-selection");
  if (showCounts) {
    document.querySelector("#member-count").textContent = total.toLocaleString();
    document.querySelector("#member-count-label").textContent = total === 1 ? "reader in the club" : "readers in the club";
    message.textContent = total ? "A shared love of books, all around the world." : "A new community, ready for its first chapter.";
  }
  const project = worldProjection();
  for (const city of community.cities || []) {
    const point = project([Number(city.longitude), Number(city.latitude)]);
    if (!point || point.some(value => !Number.isFinite(value))) continue;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const memberCount = Math.max(1, Number(city.member_count) || 1);
    const location = [city.name, city.region, city.country].filter(Boolean).join(", ");
    const label = showCounts ? `${location} · ${memberCount} ${memberCount === 1 ? "reader" : "readers"}` : location;
    circle.setAttribute("cx", point[0]); circle.setAttribute("cy", point[1]);
    const radius = .8 * Math.min(12, 4 + Math.log2(memberCount + 1));
    circle.setAttribute("r", radius); circle.dataset.mapRadius = radius;
    circle.setAttribute("fill-opacity", Math.min(.85, .3 + .15 * Math.log2(memberCount)));
    circle.setAttribute("class", "map-marker");
    if (hoverOnly) circle.setAttribute("focusable", "false");
    else circle.setAttribute("tabindex", "0");
    circle.setAttribute("role", "img"); circle.setAttribute("aria-label", label);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = label; circle.append(title);
    if (message) {
      for (const event of hoverOnly ? ["mouseenter"] : ["click", "focus", "mouseenter"]) {
        circle.addEventListener(event, () => { message.textContent = label; });
      }
    }
    group.append(circle);
  }
}
