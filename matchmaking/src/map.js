import { geoNaturalEarth1 } from "d3-geo";

// Keep the marker projection identical to scripts/build-matchmaking-geography.mjs.
export function worldProjection() {
  return geoNaturalEarth1().fitExtent([[14, 14], [986, 486]], { type: "Sphere" });
}

export function renderCommunityMap(document, community) {
  const group = document.querySelector("#map-markers");
  group.replaceChildren();
  const total = Number(community.total_members) || 0;
  document.querySelector("#member-count").textContent = total.toLocaleString();
  document.querySelector("#member-count-label").textContent = total === 1 ? "reader in the club" : "readers in the club";
  const message = document.querySelector("#map-selection");
  message.textContent = total ? "A shared love of books, all around the world." : "A new community, ready for its first chapter.";
  const project = worldProjection();
  for (const city of community.cities || []) {
    const point = project([Number(city.longitude), Number(city.latitude)]);
    if (!point || point.some(value => !Number.isFinite(value))) continue;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const label = `${[city.name, city.region, city.country].filter(Boolean).join(", ")} · ${city.member_count} ${city.member_count === 1 ? "reader" : "readers"}`;
    circle.setAttribute("cx", point[0]); circle.setAttribute("cy", point[1]);
    circle.setAttribute("r", Math.min(12, 4 + Math.log2(Number(city.member_count) + 1)));
    circle.setAttribute("class", "map-marker"); circle.setAttribute("tabindex", "0");
    circle.setAttribute("role", "img"); circle.setAttribute("aria-label", label);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = label; circle.append(title);
    for (const event of ["click", "focus", "mouseenter"]) circle.addEventListener(event, () => { message.textContent = label; });
    group.append(circle);
  }
}
