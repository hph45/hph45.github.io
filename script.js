const revealItems = document.querySelectorAll(".reveal");
const eventsBelt = document.querySelector(".events-belt");
const eventsTrack = document.querySelector("#events-track");
const eventsViewport = document.querySelector("#events-viewport");
const eventsPrev = document.querySelector("#events-prev");
const eventsNext = document.querySelector("#events-next");
const reviewsGrid = document.querySelector("#reviews-grid");
const reviewsToggle = document.querySelector("#reviews-toggle");
const reviewsSearch = document.querySelector("#reviews-search");
const reviewsRatingFilter = document.querySelector("#reviews-rating-filter");
const podcastsGrid = document.querySelector("#podcasts-grid");
const podcastsToggle = document.querySelector("#podcasts-toggle");
const INITIAL_REVIEW_COUNT = 6;
const INITIAL_PODCAST_COUNT = 6;
const REVIEWS_CSV_URL = "./reviews.csv";
const RECOMMENDED_REVIEWS_CSV_URL = "./recommended_reviews.csv";
const EVENTS_CSV_URL = "./events.csv";
const PODCASTS_CSV_URL = "./podcasts.csv";
let allReviews = [];
let recommendedReviewNotes = new Map();
let reviewsExpanded = false;
let allPodcasts = [];
let podcastsExpanded = false;
let eventsAutoScrollFrame = null;

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  },
  {
    threshold: 0.08,
    rootMargin: "0px 0px -6% 0px",
  }
);

revealItems.forEach((item) => observer.observe(item));

function formatEventDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(date);
}

function normalizeDate(date) {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function parseWeekday(value) {
  const weekdays = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  return weekdays[value?.trim().toLowerCase()] ?? null;
}

function matchesEventCadence(eventDate, schedule) {
  if (schedule.frequency === "weekly") {
    return true;
  }

  if (schedule.frequency !== "biweekly" || !schedule.startDate) {
    return false;
  }

  const diffMs = normalizeDate(eventDate) - schedule.startDate;
  const diffDays = Math.round(diffMs / 86400000);
  return diffDays >= 0 && diffDays % 14 === 0;
}

function renderEvents(events) {
  if (!eventsTrack || !eventsViewport) {
    return;
  }

  if (events.length === 0) {
    eventsTrack.innerHTML = `
      <article class="event-card event-card--placeholder">
        <p class="event-date">No events scheduled</p>
        <h3>Check back soon.</h3>
        <p class="event-detail">TBD</p>
      </article>
    `;
    return;
  }

  const repeatedEvents = [...events, ...events];

  eventsTrack.innerHTML = repeatedEvents
    .map(
      (event, index) => `
        <article class="event-card"${index >= events.length ? ' aria-hidden="true"' : ""}>
          <p class="event-date">${event.dateLabel}</p>
          <h3>${event.name}</h3>
          <p class="event-detail">${event.detail}</p>
        </article>
      `
    )
    .join("");

  eventsViewport.scrollLeft = 0;
}

function stepEventsBelt() {
  if (!eventsViewport || !eventsTrack) {
    return;
  }

  const shouldPause =
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    eventsBelt?.matches(":hover");

  if (!shouldPause) {
    const loopPoint = eventsTrack.scrollWidth / 2;
    eventsViewport.scrollLeft += 0.45;

    if (eventsViewport.scrollLeft >= loopPoint) {
      eventsViewport.scrollLeft -= loopPoint;
    }
  }

  eventsAutoScrollFrame = window.requestAnimationFrame(stepEventsBelt);
}

function startEventsBelt() {
  if (eventsAutoScrollFrame !== null) {
    window.cancelAnimationFrame(eventsAutoScrollFrame);
  }

  eventsAutoScrollFrame = window.requestAnimationFrame(stepEventsBelt);
}

function getEventStepSize() {
  const firstCard = eventsTrack?.querySelector(".event-card");

  if (!firstCard) {
    return 320;
  }

  const cardWidth = firstCard.getBoundingClientRect().width;
  const trackStyles = window.getComputedStyle(eventsTrack);
  const gap = Number.parseFloat(trackStyles.columnGap || trackStyles.gap || "16");

  return cardWidth + gap;
}

function moveEvents(direction) {
  if (!eventsViewport || !eventsTrack) {
    return;
  }

  const loopPoint = eventsTrack.scrollWidth / 2;
  const step = getEventStepSize() * direction;
  let nextScrollLeft = eventsViewport.scrollLeft + step;

  if (nextScrollLeft < 0) {
    nextScrollLeft += loopPoint;
    eventsViewport.scrollLeft = nextScrollLeft;
    return;
  }

  if (nextScrollLeft >= loopPoint) {
    nextScrollLeft -= loopPoint;
  }

  eventsViewport.scrollTo({
    left: nextScrollLeft,
    behavior: "smooth",
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        value += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      row.push(value);
      if (row.some((cell) => cell.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    if (row.some((cell) => cell.trim() !== "")) {
      rows.push(row);
    }
  }

  return rows;
}

function renderReviewCards(reviews) {
  if (!reviewsGrid) {
    return;
  }

  reviewsGrid.innerHTML = "";

  if (reviews.length === 0) {
    reviewsGrid.innerHTML = `
      <article class="review-card review-card--placeholder">
        <p class="review-meta">No matching reviews</p>
        <h3>Try a different search or zebra rating.</h3>
      </article>
    `;
    return;
  }

  reviews.forEach((review) => {
    const card = document.createElement("article");
    card.className = "review-card";

    const meta = document.createElement("p");
    meta.className = "review-meta";
    meta.textContent = `Book #${review.episode}`;

    const title = document.createElement("h3");
    title.textContent = review.title;

    const author = document.createElement("p");
    author.className = "review-meta";
    author.textContent = review.author;

    card.append(meta);

    if (review.isRecommended) {
      const recommended = document.createElement("div");
      recommended.className = "review-recommended";

      const tag = document.createElement("p");
      tag.className = "review-tag";
      tag.textContent = "Recommended";
      recommended.append(tag);

      if (review.recommendationNote) {
        const note = document.createElement("p");
        note.className = "review-note";
        note.textContent = review.recommendationNote;
        recommended.append(note);
      }

      card.append(recommended);
    }

    card.append(title, author);

    const rating = document.createElement("p");
    rating.className = "review-rating";
    rating.textContent = review.rating;

    const date = document.createElement("p");
    date.className = "review-date";
    date.textContent = review.date;

    card.append(rating, date);

    if (review.link) {
      const link = document.createElement("a");
      link.className = "review-link";
      link.href = review.link;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "View book";
      card.append(link);
    }

    reviewsGrid.append(card);
  });
}

function renderPodcastCards(podcasts) {
  if (!podcastsGrid) {
    return;
  }

  podcastsGrid.innerHTML = "";

  if (podcasts.length === 0) {
    podcastsGrid.innerHTML = `
      <article class="podcast-card podcast-card--placeholder">
        <p class="podcast-meta">No podcast episodes yet</p>
        <h3>Check back soon for the archive.</h3>
      </article>
    `;
    return;
  }

  podcasts.forEach((podcast) => {
    const card = document.createElement("article");
    card.className = "podcast-card";

    const meta = document.createElement("p");
    meta.className = "podcast-meta";
    meta.textContent = `Episode ${podcast.episode}`;

    const title = document.createElement("h3");
    title.textContent = podcast.guest;

    const date = document.createElement("p");
    date.className = "podcast-meta";
    date.textContent = podcast.date;

    const book = document.createElement("p");
    book.className = "podcast-book";
    book.textContent = `Favorite book: ${podcast.favoriteBook}`;

    const links = document.createElement("div");
    links.className = "podcast-links";

    if (podcast.spotifyLink) {
      const spotify = document.createElement("a");
      spotify.className = "podcast-link";
      spotify.href = podcast.spotifyLink;
      spotify.target = "_blank";
      spotify.rel = "noreferrer";
      spotify.textContent = "Spotify";
      links.append(spotify);
    }

    if (podcast.youtubeLink) {
      const youtube = document.createElement("a");
      youtube.className = "podcast-link";
      youtube.href = podcast.youtubeLink;
      youtube.target = "_blank";
      youtube.rel = "noreferrer";
      youtube.textContent = "YouTube";
      links.append(youtube);
    }

    if (podcast.bookLink) {
      const bookLink = document.createElement("a");
      bookLink.className = "podcast-link";
      bookLink.href = podcast.bookLink;
      bookLink.target = "_blank";
      bookLink.rel = "noreferrer";
      bookLink.textContent = "View book";
      links.append(bookLink);
    }

    card.append(meta, title, date, book);
    if (links.children.length > 0) {
      card.append(links);
    }
    podcastsGrid.append(card);
  });
}

function syncReviewsToggle() {
  if (!reviewsToggle) {
    return;
  }

  const filteredCount = getFilteredReviews().length;

  if (filteredCount <= INITIAL_REVIEW_COUNT) {
    reviewsToggle.hidden = true;
    return;
  }

  reviewsToggle.hidden = false;
  reviewsToggle.textContent = reviewsExpanded ? "Show less" : "Show more";
}

function renderVisibleReviews() {
  const filteredReviews = getFilteredReviews();
  const visibleReviews = reviewsExpanded
    ? filteredReviews
    : filteredReviews.slice(0, INITIAL_REVIEW_COUNT);

  renderReviewCards(visibleReviews);
  syncReviewsToggle();
}

function syncPodcastsToggle() {
  if (!podcastsToggle) {
    return;
  }

  if (allPodcasts.length <= INITIAL_PODCAST_COUNT) {
    podcastsToggle.hidden = true;
    return;
  }

  podcastsToggle.hidden = false;
  podcastsToggle.textContent = podcastsExpanded ? "Show less" : "Show more";
}

function renderVisiblePodcasts() {
  const visiblePodcasts = podcastsExpanded
    ? allPodcasts
    : allPodcasts.slice(0, INITIAL_PODCAST_COUNT);

  renderPodcastCards(visiblePodcasts);
  syncPodcastsToggle();
}

function getFilteredReviews() {
  const searchValue = reviewsSearch?.value.trim().toLowerCase() ?? "";
  const ratingValue = reviewsRatingFilter?.value ?? "all";

  return allReviews.filter((review) => {
    const matchesSearch =
      searchValue === "" ||
      review.title.toLowerCase().includes(searchValue) ||
      review.author.toLowerCase().includes(searchValue);

    const matchesRating =
      ratingValue === "all" || String(review.ratingCount) === ratingValue;

    return matchesSearch && matchesRating;
  });
}

function renderReviewsError() {
  if (!reviewsGrid) {
    return;
  }

  if (reviewsToggle) {
    reviewsToggle.hidden = true;
  }

  reviewsGrid.innerHTML = `
    <article class="review-card review-card--placeholder">
      <p class="review-meta">Reviews unavailable</p>
      <h3>The published review feed could not be loaded right now.</h3>
    </article>
  `;
}

async function loadReviews() {
  if (!reviewsGrid) {
    return;
  }

  try {
    const [reviewsResponse, recommendedResponse] = await Promise.all([
      fetch(REVIEWS_CSV_URL, { cache: "no-store" }),
      fetch(RECOMMENDED_REVIEWS_CSV_URL, { cache: "no-store" }),
    ]);

    if (!reviewsResponse.ok) {
      throw new Error(`Request failed with ${reviewsResponse.status}`);
    }

    if (!recommendedResponse.ok) {
      throw new Error(`Request failed with ${recommendedResponse.status}`);
    }

    const [csv, recommendedCsv] = await Promise.all([
      reviewsResponse.text(),
      recommendedResponse.text(),
    ]);
    const rows = parseCsv(csv);
    const recommendedRows = parseCsv(recommendedCsv);
    const headerIndex = rows.findIndex(
      (row) => row[0]?.trim().toLowerCase() === "ep. #"
    );
    const recommendedHeaderIndex = recommendedRows.findIndex(
      (row) => row[0]?.trim().toLowerCase() === "episode"
    );

    if (headerIndex === -1) {
      throw new Error("Header row not found");
    }

    if (recommendedHeaderIndex === -1) {
      throw new Error("Recommended reviews header row not found");
    }

    recommendedReviewNotes = new Map(
      recommendedRows
        .slice(recommendedHeaderIndex + 1)
        .map((row, index) => [
          row[0]?.trim(),
          { note: row[1]?.trim(), order: index },
        ])
        .filter(([episode]) => episode)
    );

    allReviews = rows
      .slice(headerIndex + 1)
      .map((row) => ({
        episode: row[0]?.trim(),
        author: row[1]?.trim(),
        title: row[2]?.trim(),
        rating: row[3]?.trim(),
        ratingCount: row[4]?.trim(),
        date: row[5]?.trim(),
        link: row[6]?.trim(),
        isRecommended: recommendedReviewNotes.has(row[0]?.trim()),
        recommendationNote:
          recommendedReviewNotes.get(row[0]?.trim())?.note || "",
      }))
      .filter(
        (row) =>
          row.episode &&
          /^\d+$/.test(row.episode) &&
          row.title
      )
      .sort((left, right) => {
        const leftRecommended = recommendedReviewNotes.get(left.episode);
        const rightRecommended = recommendedReviewNotes.get(right.episode);

        if (leftRecommended && rightRecommended) {
          return leftRecommended.order - rightRecommended.order;
        }

        if (leftRecommended) {
          return -1;
        }

        if (rightRecommended) {
          return 1;
        }

        return Number(right.episode) - Number(left.episode);
      });

    if (allReviews.length === 0) {
      throw new Error("No review rows found");
    }

    if (reviewsSearch) {
      reviewsSearch.value = "";
    }

    if (reviewsRatingFilter) {
      reviewsRatingFilter.value = "all";
    }

    reviewsExpanded = false;
    renderVisibleReviews();
  } catch (error) {
    renderReviewsError();
    console.error(error);
  }
}

async function loadEvents() {
  if (!eventsTrack || !eventsViewport) {
    return;
  }

  try {
    const response = await fetch(EVENTS_CSV_URL);
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    const csv = await response.text();
    const rows = parseCsv(csv);
    const headerIndex = rows.findIndex(
      (row) => row[0]?.trim().toLowerCase() === "title"
    );

    if (headerIndex === -1) {
      throw new Error("Event header row not found");
    }

    const today = new Date();
    const normalizedToday = normalizeDate(today);
    const schedules = rows
      .slice(headerIndex + 1)
      .map((row) => ({
        name: row[0]?.trim(),
        weekday: parseWeekday(row[1]),
        frequency: row[2]?.trim().toLowerCase(),
        startDate: row[3]?.trim()
          ? normalizeDate(new Date(`${row[3].trim()}T00:00:00`))
          : null,
        detail: row[4]?.trim() || "TBD",
      }))
      .filter(
        (schedule) =>
          schedule.name &&
          schedule.weekday !== null &&
          (schedule.frequency === "weekly" || schedule.frequency === "biweekly") &&
          (schedule.frequency === "weekly" || schedule.startDate)
      );

    const events = [];

    for (let offset = 0; offset < 14; offset += 1) {
      const eventDate = new Date(normalizedToday);
      eventDate.setDate(normalizedToday.getDate() + offset);

      schedules.forEach((schedule) => {
        if (eventDate.getDay() !== schedule.weekday) {
          return;
        }

        if (!matchesEventCadence(eventDate, schedule)) {
          return;
        }

        events.push({
          dateValue: normalizeDate(eventDate),
          dateLabel: formatEventDate(eventDate),
          name: schedule.name,
          detail: schedule.detail,
        });
      });
    }

    events.sort((left, right) => left.dateValue - right.dateValue);

    renderEvents(events);
    startEventsBelt();
  } catch (error) {
    renderEvents([]);
    console.error(error);
  }
}

async function loadPodcasts() {
  if (!podcastsGrid) {
    return;
  }

  try {
    const response = await fetch(PODCASTS_CSV_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    const csv = await response.text();
    const rows = parseCsv(csv);
    const headerIndex = rows.findIndex(
      (row) => row[0]?.trim().toLowerCase() === "episode"
    );

    if (headerIndex === -1) {
      throw new Error("Podcast header row not found");
    }

    allPodcasts = rows
      .slice(headerIndex + 1)
      .map((row) => ({
        episode: row[0]?.trim(),
        guest: row[1]?.trim(),
        favoriteBook: row[2]?.trim(),
        date: row[3]?.trim(),
        spotifyLink: row[4]?.trim(),
        youtubeLink: row[5]?.trim(),
        bookLink: row[6]?.trim(),
      }))
      .filter(
        (podcast) =>
          podcast.episode &&
          /^\d+$/.test(podcast.episode) &&
          podcast.guest
      )
      .sort((left, right) => Number(right.episode) - Number(left.episode));

    podcastsExpanded = false;
    renderVisiblePodcasts();
  } catch (error) {
    renderPodcastCards([]);
    if (podcastsToggle) {
      podcastsToggle.hidden = true;
    }
    console.error(error);
  }
}

if (reviewsToggle) {
  reviewsToggle.addEventListener("click", () => {
    reviewsExpanded = !reviewsExpanded;
    renderVisibleReviews();
  });
}

if (reviewsSearch) {
  reviewsSearch.addEventListener("input", () => {
    reviewsExpanded = false;
    renderVisibleReviews();
  });
}

if (reviewsRatingFilter) {
  reviewsRatingFilter.addEventListener("change", () => {
    reviewsExpanded = false;
    renderVisibleReviews();
  });
}

loadReviews();
loadEvents();
loadPodcasts();

if (eventsPrev && eventsViewport) {
  eventsPrev.addEventListener("click", () => {
    moveEvents(-1);
  });
}

if (eventsNext && eventsViewport) {
  eventsNext.addEventListener("click", () => {
    moveEvents(1);
  });
}

if (podcastsToggle) {
  podcastsToggle.addEventListener("click", () => {
    podcastsExpanded = !podcastsExpanded;
    renderVisiblePodcasts();
  });
}
