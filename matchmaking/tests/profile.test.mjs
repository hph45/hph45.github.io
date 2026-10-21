import test from "node:test";
import assert from "node:assert/strict";
import { ageOn, birthdayBounds, makeProfile, validateProfile } from "../src/profile.js";
import { getAuthRedirect } from "../src/config.js";

const today = new Date("2026-10-21T12:00:00Z");
const basics = {
  intent: "friends", display_name: " Reader ", birth_date: "1994-06-15",
  city_id: 5378538, city: " Oakland ", region: "California", country: "United States",
  favorite_book_id: "OL1W",
  favorite_book: "Parable of the Sower", favorite_author: "Octavia Butler",
  location_preference: "same_city", friendship_interests: "Coffee and bookshops",
};

test("age checks the exact eighteenth birthday, invalid dates, and leap birthdays", () => {
  assert.equal(ageOn("2008-10-21", today), 18);
  assert.equal(ageOn("2008-10-22", today), 17);
  assert.ok(Number.isNaN(ageOn("2001-02-29", today)));
  assert.ok(Number.isNaN(ageOn("bad-date", today)));
  assert.equal(ageOn("2008-02-29", new Date("2026-02-28")), 17);
  assert.equal(ageOn("2008-02-29", new Date("2026-03-01")), 18);
  assert.deepEqual(birthdayBounds(today), { min: "1905-10-22", max: "2008-10-21" });
});

test("changing intent removes former sensitive preferences and whitelists fields", () => {
  const profile = makeProfile({ ...basics, user_id: "forged", created_at: "forged", gender: "man", gender_description: "old", interested_in: ["woman"], age_min: 25, age_max: 40, business_about: "Old project", email_matches: "true" });
  assert.equal(profile.display_name, "Reader");
  assert.equal(profile.city, "Oakland");
  assert.equal(profile.gender, null);
  assert.deepEqual(profile.interested_in, []);
  assert.equal(profile.age_min, null);
  assert.equal(profile.business_about, "");
  assert.equal(profile.email_matches, false);
  assert.ok(!("user_id" in profile));
  assert.ok(!("created_at" in profile));
  assert.deepEqual(validateProfile(profile, { consent: true, today }), []);
});

test("all three intentions enforce their questions, age preferences, and consent", () => {
  const romance = makeProfile({ ...basics, intent: "romance", gender: "self_described", interested_in: [], age_min: "35", age_max: "25" });
  const errors = validateProfile(romance, { consent: false, today }).map(e => e.field);
  assert.deepEqual(errors, ["gender_description", "interested_in", "age_max", "profile_consent"]);
  const business = makeProfile({ ...basics, intent: "business_partners", business_about: "     " });
  assert.deepEqual(validateProfile(business, { consent: true, today }).map(e => e.field), ["business_about", "business_skills", "business_seeking"]);
  assert.ok(validateProfile(makeProfile({ ...basics, birth_date: "2010-01-01" }), { consent: true, today }).some(e => e.field === "birth_date"));
});

test("editing preserves a paused profile; redirect never carries query parameters", () => {
  assert.equal(makeProfile(basics, { isActive: false }).is_active, false);
  assert.equal(getAuthRedirect(new URL("http://127.0.0.1:8080/matchmaking/?next=https://untrusted.example")), "http://127.0.0.1:8080/matchmaking/");
  assert.equal(getAuthRedirect(new URL("https://zebrabookclub.com/matchmaking/")), "https://zebrabookclub.com/matchmaking/");
});

test("one to three books are valid, a first book is required, and the retired answer is not submitted", () => {
  const one = makeProfile({ ...basics, book_reason: "A legacy answer", favorite_book_4_id: "OL4W" });
  assert.deepEqual(validateProfile(one, { consent: true, today }), []);
  assert.equal(one.favorite_book_2_id, null);
  assert.equal(one.favorite_book_3_id, null);
  assert.ok(!("book_reason" in one));
  assert.ok(!("favorite_book_4_id" in one));
  const two = makeProfile({ ...basics, favorite_book_2_id: "OL2W", favorite_book_2: "Second book", favorite_author_2: "Second author" });
  const three = makeProfile({ ...two, favorite_book_3_id: "OL3W", favorite_book_3: "Third book", favorite_author_3: "Third author" });
  for (const profile of [two, three]) assert.deepEqual(validateProfile(profile, { consent: true, today }), []);
  const empty = makeProfile({ ...basics, favorite_book_id: "", favorite_book: "", favorite_author: "" });
  assert.ok(validateProfile(empty, { consent: true, today }).some(error => error.field === "favorite_book"));
});
