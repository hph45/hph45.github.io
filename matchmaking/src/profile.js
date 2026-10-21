export const INTENTS = {
  romance: "Romance",
  friends: "Friends",
  business_partners: "Business partners",
};

export const GENDERS = {
  woman: "Woman",
  man: "Man",
  other: "Other",
};

export function ageRangeLabel(minimum, maximum) {
  return minimum >= 80 ? "80+" : `${minimum}–${maximum >= 80 ? "80+" : maximum}`;
}

// Accept pasted personal or company links, then store one safe HTTPS format.
// Invalid input stays in the form so the member can correct it.
export function normalizeLinkedInURL(value) {
  const input = String(value ?? "").trim();
  if (!input) return "";
  if (input.length > 300) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port
      || !/^(?:(?:www|[a-z]{2,3})\.)?linkedin\.com$/i.test(url.hostname)
      || !/^\/(in|company)\/(?:[a-z\d_-]|%[a-f\d]{2})+\/?$/i.test(url.pathname)) return null;
    const [, type, slug] = url.pathname.split("/");
    const canonical = `https://www.linkedin.com/${type.toLowerCase()}/${slug}`;
    return canonical.length <= 300 ? canonical : null;
  } catch { return null; }
}

export function ageOn(birthDate, today = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate ?? "")) return NaN;
  const birth = new Date(`${birthDate}T00:00:00Z`);
  if (Number.isNaN(birth.valueOf()) || birth.toISOString().slice(0, 10) !== birthDate) return NaN;
  const birthdayPending = today.getUTCMonth() < birth.getUTCMonth()
    || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate());
  return today.getUTCFullYear() - birth.getUTCFullYear() - Number(birthdayPending);
}

export function birthdayBounds(today = new Date()) {
  const yearsAgo = (years) => {
    const year = today.getUTCFullYear() - years;
    const month = today.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(today.getUTCDate(), lastDay)));
  };
  const earliest = yearsAgo(121);
  earliest.setUTCDate(earliest.getUTCDate() + 1);
  return { min: earliest.toISOString().slice(0, 10), max: yearsAgo(18).toISOString().slice(0, 10) };
}

// Build an explicit allowlist of writable fields. Irrelevant category answers are
// cleared when someone changes their intent; timestamps and account IDs stay out.
export function makeProfile(values, { isActive = true } = {}) {
  const text = (key) => String(values[key] ?? "").trim();
  const intent = text("intent");
  const romance = intent === "romance";
  const business = intent === "business_partners";
  return {
    display_name: text("display_name"),
    birth_date: text("birth_date"),
    city_id: Number(values.city_id) || null,
    city: text("city"), region: text("region"), country: text("country"), intent,
    favorite_book_id: text("favorite_book_id") || null,
    favorite_book: text("favorite_book"), favorite_author: text("favorite_author"),
    favorite_book_2_id: text("favorite_book_2_id") || null,
    favorite_book_2: text("favorite_book_2"), favorite_author_2: text("favorite_author_2"),
    favorite_book_3_id: text("favorite_book_3_id") || null,
    favorite_book_3: text("favorite_book_3"), favorite_author_3: text("favorite_author_3"),
    location_preference: text("location_preference"),
    gender: romance ? text("gender") || null : null,
    interested_in: romance && Array.isArray(values.interested_in) ? [...new Set(values.interested_in)] : [],
    age_min: romance && text("age_min") ? Number(values.age_min) : null,
    // The slider's 80+ endpoint includes every older member the platform allows.
    age_max: romance && text("age_max") ? (Number(values.age_max) === 80 ? 120 : Number(values.age_max)) : null,
    romance_ideal_match: romance ? text("romance_ideal_match") : "",
    friendship_interests: intent === "friends" ? text("friendship_interests") : "",
    business_about: business ? text("business_about") : "",
    business_skills: business ? text("business_skills") : "",
    business_seeking: business ? text("business_seeking") : "",
    business_linkedin_url: business ? normalizeLinkedInURL(text("business_linkedin_url")) ?? text("business_linkedin_url") : "",
    is_active: Boolean(isActive), email_matches: values.email_matches === true,
  };
}

export function validateProfile(profile, { consent, today = new Date() } = {}) {
  const errors = [];
  const error = (field, step, message) => errors.push({ field, step, message });
  const length = (field, min, max, step, label) => {
    const size = String(profile[field] ?? "").trim().length;
    if (size < min || size > max) error(field, step, `${label} should be ${min}–${max} characters.`);
  };
  if (!Object.hasOwn(INTENTS, profile.intent)) error("intent", 0, "Choose the kind of connection you’re looking for.");
  length("display_name", 1, 60, 0, "Your name");
  const age = ageOn(profile.birth_date, today);
  if (!Number.isInteger(age) || age < 18 || age > 120) error("birth_date", 0, "Enter a valid birthday. Matchmaking is for people 18 and over.");
  if (!Number.isInteger(profile.city_id) || profile.city_id <= 0) error("city", 0, "Choose your city or a nearby city from the suggestions.");
  length("city", 1, 200, 0, "Your city");
  length("region", 0, 200, 0, "Your state or region");
  length("country", 2, 200, 0, "Your country");
  const bookIDs = new Set();
  for (const suffix of ["", "_2", "_3"]) {
    const title = profile[`favorite_book${suffix}`];
    const id = profile[`favorite_book${suffix}_id`];
    if (suffix && !title && !id) continue;
    if (!/^OL\d+W$/.test(id || "")) error(`favorite_book${suffix}`, 1, "Choose a book from the suggestions so we can recognize it.");
    else if (bookIDs.has(id)) error(`favorite_book${suffix}`, 1, "Choose a different book for each of your favorites.");
    bookIDs.add(id);
    length(`favorite_book${suffix}`, 1, 300, 1, "The book’s title");
    length(`favorite_author${suffix}`, 1, 300, 1, "The author’s name");
  }
  if (profile.favorite_book_3_id && !profile.favorite_book_2_id) error("favorite_book_2", 1, "Add your second favorite before your third.");
  if (!["same_city", "anywhere"].includes(profile.location_preference)) error("location_preference", 2, "Choose where you’d like to connect.");
  if (profile.intent === "romance") {
    if (!Object.hasOwn(GENDERS, profile.gender ?? "")) error("gender", 2, "Choose how you describe your gender.");
    if (!Array.isArray(profile.interested_in) || !profile.interested_in.length || profile.interested_in.some((value) => !Object.hasOwn(GENDERS, value))) {
      error("interested_in", 2, "Choose at least one group of people you’d like to meet.");
    }
    for (const field of ["age_min", "age_max"]) {
      if (!Number.isInteger(profile[field]) || profile[field] < 18 || profile[field] > 120) error(field, 2, "Choose a whole-number age between 18 and 120.");
    }
    if (profile.age_min > profile.age_max) error("age_max", 2, "The maximum age must be at least the minimum age.");
    length("romance_ideal_match", 0, 600, 2, "Your ideal-match answer");
  }
  if (profile.intent === "friends") length("friendship_interests", 5, 600, 2, "Your friendship answer");
  if (profile.intent === "business_partners") {
    length("business_about", 5, 600, 2, "Your project answer");
    length("business_skills", 5, 600, 2, "Your skills answer");
    length("business_seeking", 5, 600, 2, "Your partner answer");
    if (normalizeLinkedInURL(profile.business_linkedin_url) === null) {
      error("business_linkedin_url", 2, "Enter a LinkedIn profile or company URL, such as linkedin.com/in/your-name, or leave it blank.");
    }
  }
  if (!consent) error("profile_consent", 2, "Please confirm that you’re happy to share your profile with your matches.");
  return errors;
}

export function locationLabel(profile) {
  return [profile.city, profile.region, profile.country].filter(Boolean).join(", ");
}

export function bookEditTime(profile) {
  const lastEdit = Date.parse(profile?.books_updated_at);
  return Number.isFinite(lastEdit) ? lastEdit + 24 * 60 * 60 * 1000 : 0;
}

export function favoriteBooks(profile) {
  return ["", "_2", "_3"].map(suffix => ({
    work_id: profile[`favorite_book${suffix}_id`],
    title: profile[`favorite_book${suffix}`], author: profile[`favorite_author${suffix}`],
  })).filter(book => book.title);
}

export function preferenceDetails(profile) {
  const details = [["Where", profile.location_preference === "same_city" ? "My city or metro area" : "Open to anywhere"]];
  if (profile.intent === "romance") {
    details.push(["Who you’d like to meet", profile.interested_in.map((gender) => GENDERS[gender]).join(", ")]);
    details.push(["Age range", ageRangeLabel(profile.age_min, profile.age_max)]);
    if (profile.romance_ideal_match) details.push(["Your ideal match", profile.romance_ideal_match]);
  } else if (profile.intent === "friends") {
    details.push(["Time well spent", profile.friendship_interests]);
  } else if (profile.intent === "business_partners") {
    details.push(["What you’re building", profile.business_about], ["What you bring", profile.business_skills], ["Your ideal partner", profile.business_seeking]);
  }
  return details;
}
