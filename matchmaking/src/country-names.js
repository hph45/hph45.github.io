// Keep geographic keys unchanged for grouping and map geometry; use the same
// display name wherever a country is shown to readers.
export function displayCountry(country) {
  return country === "Palestinian Territories" ? "Palestine" : country;
}
