import test from "node:test";
import assert from "node:assert/strict";
import { INTENTS, profileIntents, preferenceDetails, ageOn, birthdayBounds, makeProfile, validateProfile, normalizeLinkedInURL, normalizeInstagramHandle, instagramProfileURL, ageRangeLabel, currentReadEditTime } from "../src/profile.js";
import { getAuthRedirect } from "../src/config.js";

const today = new Date("2026-10-21T12:00:00Z");
const basics = {
  intent: "friends", display_name: " Reader ", instagram_handle: "reader.books", birth_date: "1994-06-15",
  city_id: 5378538, city: " Oakland ", region: "California", country: "United States",
  favorite_book_id: "OL1W",
  favorite_book: "Parable of the Sower", favorite_author: "Octavia Butler",
  location_preference: "same_city", friendship_interests: "Coffee and bookshops",
};

test("Instagram accepts usernames and profile links while keeping links on the Instagram domain", () => {
  for (const value of ["reader.books", " @Reader.Books ", "instagram.com/Reader.Books", "https://www.instagram.com/Reader.Books/?igsh=tracking#profile", "http://instagram.com/reader%2Ebooks/"]) {
    assert.equal(normalizeInstagramHandle(value), "reader.books", value);
    assert.equal(instagramProfileURL(value), "https://www.instagram.com/reader.books/");
    assert.equal(makeProfile({ ...basics, instagram_handle: value }).instagram_handle, "reader.books");
  }
  assert.equal(normalizeInstagramHandle("_a.1"), "_a.1");
  assert.equal(normalizeInstagramHandle("a".repeat(30)), "a".repeat(30));
  for (const value of ["a".repeat(31), "two words", ".reader", "reader.", "reader..books", "@@reader", "reader/books", "reader?next=bad", "reels",
    "javascript:alert(1)", "https://instagram.com.evil.test/reader", "https://evil.test/reader", "https://instagram.com@evil.test/reader",
    "https://reader@instagram.com/reader", "https://instagram.com:444/reader", "https://instagram.com/p/post", "https://instagram.com/", "https://instagram.com/%ZZ"])
    assert.equal(normalizeInstagramHandle(value), null, value);
  assert.equal(normalizeInstagramHandle(null), "");
  assert.equal(instagramProfileURL("javascript:alert(1)"), "");
});

test("new signup requires Instagram while a legacy member can defer it without accepting invalid text", () => {
  const missing = makeProfile({ ...basics, instagram_handle: "" });
  assert.equal(missing.instagram_handle, null);
  assert.ok(validateProfile(missing, { consent: true, today }).some(error => error.field === "instagram_handle" && error.step === 0));
  assert.deepEqual(validateProfile(missing, { consent: true, today, requireInstagram: false }), []);
  const invalid = makeProfile({ ...basics, instagram_handle: "not a handle" });
  assert.equal(invalid.instagram_handle, "not a handle", "keep invalid text so validation can explain the problem");
  assert.ok(validateProfile(invalid, { consent: true, today, requireInstagram: false }).some(error => error.field === "instagram_handle"));
});

test("every combination keeps and requires the answers for all selected connection types", () => {
  const types = Object.keys(INTENTS);
  const answers = { ...basics, gender: "other", interested_in: ["woman", "other"], age_min: 25, age_max: 80,
    romance_ideal_match: "Someone curious and kind", business_about: "A neighborhood bookshop",
    business_skills: "Events and community", business_seeking: "An operations partner", business_linkedin_url: "linkedin.com/in/reader" };
  for (let mask = 1; mask < 8; mask++) {
    const intents = types.filter((_, index) => mask & (1 << index));
    const profile = makeProfile({ ...answers, intents });
    assert.deepEqual(profile.intents, intents);
    assert.ok(!("intent" in profile), "new writes use the array only");
    assert.deepEqual(validateProfile(profile, { consent: true, today }), [], intents.join(", "));
    for (const [intent, field] of [["romance", "gender"], ["friends", "friendship_interests"], ["business_partners", "business_skills"]]) {
      assert.equal(Boolean(profile[field]), intents.includes(intent), field);
      const errors = validateProfile({ ...profile, [field]: "" }, { consent: true, today });
      assert.equal(errors.some(error => error.field === field), intents.includes(intent), `${intents}: ${field}`);
    }
    assert.equal(preferenceDetails(profile).some(([title]) => title === "Your ideal match"), intents.includes("romance"));
    assert.equal(preferenceDetails(profile).some(([title]) => title === "Time well spent"), intents.includes("friends"));
    assert.equal(preferenceDetails(profile).some(([title]) => title === "What you’re building"), intents.includes("business_partners"));
  }
  const all = makeProfile({ ...answers, intents: types });
  const removed = makeProfile({ ...all, intents: ["friends"] });
  assert.equal(removed.friendship_interests, all.friendship_interests);
  assert.equal(removed.gender, null);
  assert.deepEqual(removed.interested_in, []);
  assert.equal(removed.romance_ideal_match, "");
  assert.equal(removed.business_about, "");
  assert.equal(removed.business_linkedin_url, "");
});

test("a selection is required, old profiles restore, and an explicit array takes precedence", () => {
  assert.deepEqual(profileIntents({ intent: "friends" }), ["friends"]);
  assert.deepEqual(profileIntents({ intent: "friends", intents: [] }), []);
  assert.deepEqual(profileIntents({ intent: "romance", intents: ["friends", "friends"] }), ["friends"]);
  for (const intents of [[], ["unknown"], ["friends", "unknown"], "friends"]) {
    assert.ok(validateProfile(makeProfile({ ...basics, intents }), { consent: true, today }).some(error => error.field === "intents"));
  }
});

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
  const profile = makeProfile({ ...basics, user_id: "forged", created_at: "forged", gender: "man", gender_description: "old", interested_in: ["woman"], age_min: 25, age_max: 40, romance_ideal_match: "An old answer", business_about: "Old project", business_linkedin_url: "https://www.linkedin.com/in/old-profile", email_matches: "true" });
  assert.equal(profile.display_name, "Reader");
  assert.equal(profile.city, "Oakland");
  assert.equal(profile.gender, null);
  assert.deepEqual(profile.interested_in, []);
  assert.equal(profile.age_min, null);
  assert.equal(profile.business_about, "");
  assert.equal(profile.business_linkedin_url, "");
  assert.equal(profile.romance_ideal_match, "");
  assert.ok(!("gender_description" in profile));
  assert.equal(profile.email_matches, false);
  assert.ok(!("user_id" in profile));
  assert.ok(!("created_at" in profile));
  assert.deepEqual(validateProfile(profile, { consent: true, today }), []);
});

test("all three intentions enforce their questions, age preferences, and consent", () => {
  const romance = makeProfile({ ...basics, intent: "romance", gender: "other", interested_in: [], age_min: "35", age_max: "25" });
  const errors = validateProfile(romance, { consent: false, today }).map(e => e.field);
  assert.deepEqual(errors, ["interested_in", "age_max", "profile_consent"]);
  const business = makeProfile({ ...basics, intent: "business_partners", business_about: "     " });
  assert.deepEqual(validateProfile(business, { consent: true, today }).map(e => e.field), ["business_about", "business_skills", "business_seeking"]);
  assert.ok(validateProfile(makeProfile({ ...basics, birth_date: "2010-01-01" }), { consent: true, today }).some(e => e.field === "birth_date"));
});

test("romance accepts the three gender choices and limits the private open answer", () => {
  for (const gender of ["woman", "man", "other"]) {
    const profile = makeProfile({ ...basics, intent: "romance", gender, interested_in: ["woman", "man", "other", "other"], age_min: 18, age_max: 120, romance_ideal_match: " Someone curious and kind. " });
    assert.deepEqual(validateProfile(profile, { consent: true, today }), []);
    assert.deepEqual(profile.interested_in, ["woman", "man", "other"]);
    assert.equal(profile.romance_ideal_match, "Someone curious and kind.");
    assert.ok(validateProfile({ ...profile, romance_ideal_match: "a".repeat(601) }, { consent: true, today }).some(error => error.field === "romance_ideal_match"));
    for (const retired of ["nonbinary", "self_described"]) {
      const errors = validateProfile({ ...profile, gender: retired, interested_in: [retired] }, { consent: true, today });
      assert.deepEqual(errors.map(error => error.field), ["gender", "interested_in"]);
    }
  }
});

test("80+ includes older members and is displayed consistently", () => {
  const profile = makeProfile({ ...basics, intent: "romance", gender: "other", interested_in: ["other"], age_min: 25, age_max: 80 });
  assert.equal(profile.age_max, 120);
  assert.deepEqual(validateProfile(profile, { consent: true, today }), []);
  assert.equal(ageRangeLabel(profile.age_min, profile.age_max), "25–80+");
  assert.equal(ageRangeLabel(80, 120), "80+");
  assert.equal(ageRangeLabel(25, 79), "25–79");
  assert.ok(validateProfile(makeProfile({ ...profile, age_max: 121 }), { consent: true, today }).some(error => error.field === "age_max"));
});

test("LinkedIn is optional and accepts only personal or company page URLs", () => {
  const business = makeProfile({ ...basics, intent: "business_partners", business_about: "A neighborhood bookshop", business_skills: "Events and community", business_seeking: "An operations partner" });
  assert.deepEqual(validateProfile(business, { consent: true, today }), []);
  assert.equal(normalizeLinkedInURL(""), "");
  for (const input of ["linkedin.com/in/reader", " http://uk.linkedin.com/in/reader/?trk=profile#about ", "https://WWW.LINKEDIN.COM/IN/reader"]) {
    const profile = makeProfile({ ...business, business_linkedin_url: input });
    assert.equal(profile.business_linkedin_url, "https://www.linkedin.com/in/reader");
    assert.deepEqual(validateProfile(profile, { consent: true, today }), []);
  }
  assert.equal(normalizeLinkedInURL("linkedin.com/company/zebra-book-club/"), "https://www.linkedin.com/company/zebra-book-club");
  for (const input of ["javascript:alert(1)", "https://linkedin.com.evil.example/in/reader", "https://linkedin.com@evil.example/in/reader", "https://name:secret@linkedin.com/in/reader", "https://www.linkedin.com:444/in/reader", "https://www.linkedin.com/feed", "https://www.linkedin.com/in/", "not a link", "https://www.linkedin.com/in/" + "a".repeat(300)]) {
    assert.equal(normalizeLinkedInURL(input), null, input);
    const profile = makeProfile({ ...business, business_linkedin_url: input });
    assert.equal(profile.business_linkedin_url, input, "invalid input remains available for correction");
    assert.deepEqual(validateProfile(profile, { consent: true, today }).map(error => error.field), ["business_linkedin_url"]);
  }
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

test("a current read is optional, validates selected catalog IDs, and may also be a favorite", () => {
  const empty = makeProfile(basics);
  assert.equal(empty.current_book_id, null);
  assert.equal(empty.current_book, "");
  assert.equal(empty.current_author, "");
  assert.deepEqual(validateProfile(empty, { consent: true, today }), []);
  const reading = makeProfile({ ...basics, current_book_id: " OL1W ", current_book: " Parable of the Sower ", current_author: " Octavia Butler " });
  assert.equal(reading.current_book_id, "OL1W");
  assert.equal(reading.current_book, basics.favorite_book);
  assert.deepEqual(validateProfile(reading, { consent: true, today }), []);
  for (const changes of [{ current_book_id: "" }, { current_book_id: "OL1M" }, { current_book: "" }, { current_author: "" }, { current_book: "a".repeat(301) }]) {
    assert.ok(validateProfile({ ...reading, ...changes }, { consent: true, today }).some(error => error.step === 1));
  }
});

test("typed books need only a title, preserve author text, and reject duplicate favorites", () => {
  const values = { ...basics, favorite_book_id: "", favorite_book: "An unlisted book", favorite_author: "",
    favorite_book_2: "Another book", favorite_author_2: "An author",
    favorite_book_3: "A third title", current_book: "An unlisted book", current_author: "" };
  const manual = makeProfile(values);
  for (const key of ["favorite_book_id", "favorite_book_2_id", "favorite_book_3_id", "current_book_id"]) assert.equal(manual[key], "manual");
  assert.deepEqual(validateProfile(manual, { consent: true, today }), []);
  const duplicate = makeProfile({ ...values, favorite_book_2: " AN  UNLISTED BOOK! ", favorite_author_2: "" });
  assert.ok(validateProfile(duplicate, { consent: true, today }).some(error => error.field === "favorite_book_2"));
  const local = makeProfile({ ...basics, favorite_book_id: "ZB" + "a".repeat(32) });
  assert.deepEqual(validateProfile(local, { consent: true, today }), []);
  for (const id of ["ZBbad", "OL123M", "https://example.test"]) {
    assert.ok(validateProfile({ ...local, favorite_book_id: id }, { consent: true, today }).some(error => error.step === 1));
  }
});

test("the current-read clock handles empty profiles and cannot be supplied in a profile write", () => {
  for (const value of [undefined, null, "", "invalid"]) assert.equal(currentReadEditTime({ current_book_updated_at: value }), 0);
  assert.equal(currentReadEditTime({ current_book_updated_at: "2026-10-23T12:00:00Z", books_updated_at: "2026-10-22T00:00:00Z" }), Date.parse("2026-10-24T12:00:00Z"));
  assert.ok(!("current_book_updated_at" in makeProfile({ ...basics, current_book_updated_at: "2000-01-01" })));
});
