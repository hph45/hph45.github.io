const revealItems = document.querySelectorAll(".reveal");
const reviewsGrid = document.querySelector("#reviews-grid");
const reviewsToggle = document.querySelector("#reviews-toggle");
const reviewsSearch = document.querySelector("#reviews-search");
const reviewsRatingFilter = document.querySelector("#reviews-rating-filter");
const reviewsCsv = window.REVIEWS_CSV;
const INITIAL_REVIEW_COUNT = 6;
let allReviews = [];
let reviewsExpanded = false;

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
    if (!reviewsCsv) {
      throw new Error("Reviews data missing");
    }

    const rows = parseCsv(reviewsCsv);
    const headerIndex = rows.findIndex((row) => row[0] === "Ep. #");

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
      .filter((row) => row.episode && row.title);

    if (allReviews.length === 0) {
      throw new Error("No review rows found");
    }

    renderVisibleReviews();
  } catch (error) {
    renderReviewsError();
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
