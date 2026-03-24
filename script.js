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
const INITIAL_REVIEW_COUNT = 6;
const REVIEWS_CSV_URL = "./reviews.csv";
const EVENTS_CSV_URL = "./events.csv";
let allReviews = [];
let reviewsExpanded = false;
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

    const rating = document.createElement("p");
    rating.className = "review-rating";
    rating.textContent = review.rating;

    const date = document.createElement("p");
    date.className = "review-date";
    date.textContent = review.date;

    card.append(meta, title, author, rating, date);

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
    const response = await fetch(REVIEWS_CSV_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    const csv = await response.text();
    const rows = parseCsv(csv);
    const headerIndex = rows.findIndex(
      (row) => row[0]?.trim().toLowerCase() === "ep. #"
    );

    if (headerIndex === -1) {
      throw new Error("Header row not found");
    }

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
      }))
      .filter(
        (row) =>
          row.episode &&
          /^\d+$/.test(row.episode) &&
          row.title
      )
      .sort((left, right) => Number(right.episode) - Number(left.episode));

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
    const headerIndex = rows.findIndex((row) => row[0]?.trim().toLowerCase() === "date");

    if (headerIndex === -1) {
      throw new Error("Event header row not found");
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const events = rows
      .slice(headerIndex + 1)
      .map((row) => {
        const rawDate = row[0]?.trim();
        const eventDate = rawDate ? new Date(`${rawDate}T00:00:00`) : null;

        return {
          rawDate,
          eventDate,
          name: row[1]?.trim(),
          detail: row[2]?.trim() || "TBD",
        };
      })
      .filter(
        (event) =>
          event.rawDate &&
          event.name &&
          event.eventDate instanceof Date &&
          !Number.isNaN(event.eventDate.valueOf()) &&
          event.eventDate >= today
      )
      .sort((left, right) => left.eventDate - right.eventDate)
      .map((event) => ({
        dateLabel: formatEventDate(event.eventDate),
        name: event.name,
        detail: event.detail,
      }));

    renderEvents(events);
    startEventsBelt();
  } catch (error) {
    renderEvents([]);
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
