const number = value => value.toLocaleString();
const label = (value, singular, plural = `${singular}s`) => `${number(value)} ${value === 1 ? singular : plural}`;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const weekDate = value => new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function validateReviews(reviews) {
  if (!reviews || ![reviews.total_reviews, reviews.reviewers, reviews.reviewed_matches].every(nonnegative)
    || reviews.reviewers > reviews.total_reviews || reviews.reviewed_matches > reviews.total_reviews
    || reviews.compatibility?.total !== reviews.total_reviews || reviews.book?.total > reviews.total_reviews) {
    throw new Error("Invalid review totals");
  }
  for (const key of ["compatibility", "book"]) {
    const summary = reviews[key];
    if (!summary || !nonnegative(summary.total) || !Array.isArray(summary.distribution)
      || summary.distribution.length !== 5 || summary.distribution.some((row, index) => row.rating !== index + 1 || !nonnegative(row.review_count))
      || summary.distribution.reduce((sum, row) => sum + row.review_count, 0) !== summary.total
      || (summary.total ? !Number.isFinite(summary.average) || summary.average < 1 || summary.average > 5 : summary.average !== null)) {
      throw new Error("Invalid review statistics response");
    }
  }
}

export function createRoundStatistics({ document, renderChart }) {
  const $ = selector => document.querySelector(selector);
  const tablist = $("#review-round-tabs"), panel = $("#review-results");
  let stats = null;

  function clear() {
    stats = null;
    for (const id of ["round-account-chart", "review-round-tabs", "compatibility-chart", "book-rating-chart"]) $(`#${id}`).replaceChildren();
    for (const id of ["review-summary", "compatibility-count", "book-rating-count", "review-note"]) $(`#${id}`).textContent = "";
    for (const id of ["compatibility-average", "book-rating-average"]) $(`#${id}`).textContent = "—";
    tablist.hidden = true;
    panel.removeAttribute("role"); panel.removeAttribute("aria-labelledby"); panel.removeAttribute("tabindex");
  }

  function selectRound(week = "all", focus = false) {
    if (!stats) return;
    const round = week === "all" ? null : stats.rounds?.find(row => row.week_start === week);
    if (week !== "all" && !round) return;
    for (const tab of tablist.children) {
      const active = tab.dataset.reviewRound === week;
      tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1;
      if (active) {
        panel.setAttribute("aria-labelledby", tab.id);
        if (focus) tab.focus();
      }
    }
    const reviews = round ? round.reviews : stats.reviews;
    // An older backend must never appear to have zero reviews or rounds.
    $("#reviews-unavailable").hidden = Boolean(reviews);
    $("#review-charts").hidden = $("#review-note").hidden = !reviews;
    if (!reviews) return;
    $("#review-summary").textContent = `${label(reviews.total_reviews, "review")} · ${label(reviews.reviewers, "reader")} · ${label(reviews.reviewed_matches, "match", "matches")}`;
    $("#review-note").textContent = `${round ? `Round ${round.round_number} · Week of ${weekDate(round.week_start)}` : "All rounds"} · One review per reader per match. Updated ratings replace earlier ones.`;
    for (const [key, prefix] of [["compatibility", "compatibility"], ["book", "book-rating"]]) {
      const summary = reviews[key];
      $(`#${prefix}-average`).textContent = summary.total ? summary.average.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "—";
      $(`#${prefix}-count`).textContent = summary.total ? label(summary.total, "rating") : "No ratings yet";
      renderChart(`#${prefix}-chart`, summary.distribution.map(row => ({ ...row, label: `${row.rating} ${row.rating === 1 ? "star" : "stars"}` })), summary.total, "review_count");
    }
  }

  function render(data) {
    if (data.reviews) validateReviews(data.reviews);
    const rounds = data.rounds;
    if (rounds !== undefined) {
      if (!Array.isArray(rounds)) throw new Error("Invalid round statistics");
      for (const [index, round] of rounds.entries()) {
        if (!round || round.round_number !== index + 1 || !nonnegative(round.account_count)
          || !/^\d{4}-\d{2}-\d{2}$/.test(round.week_start) || !Number.isFinite(Date.parse(`${round.week_start}T00:00:00Z`))
          || new Date(`${round.week_start}T00:00:00Z`).toISOString().slice(0, 10) !== round.week_start
          || !Number.isFinite(Date.parse(round.first_released_at))
          || (index && rounds[index - 1].week_start >= round.week_start)) throw new Error("Invalid round statistics");
        validateReviews(round.reviews);
      }
    }
    stats = data;
    $("#rounds-unavailable").hidden = rounds !== undefined;
    $("#rounds-empty").hidden = !rounds || rounds.length > 0;
    $("#round-account-chart").hidden = $("#round-account-note").hidden = !rounds?.length;
    const bars = document.createDocumentFragment(), tabs = document.createDocumentFragment();
    const maximum = Math.max(1, ...(rounds || []).map(round => round.account_count));
    for (const round of rounds || []) {
      const row = document.createElement("li");
      const column = document.createElement("div"); column.className = "round-column";
      const value = document.createElement("strong"); value.className = "round-value"; value.textContent = number(round.account_count);
      const bar = document.createElement("div"); bar.className = "round-bar"; bar.setAttribute("aria-hidden", "true");
      bar.style.height = `${round.account_count / maximum * 54}px`;
      column.append(value, bar);
      const name = document.createElement("strong"); name.className = "round-label"; name.textContent = `Round ${round.round_number}`;
      const date = document.createElement("span"); date.className = "visually-hidden"; date.textContent = `Week of ${weekDate(round.week_start)}`;
      row.append(column, name, date); bars.append(row);
    }
    $("#round-account-chart").replaceChildren(bars);
    if (rounds && data.reviews) {
      for (const round of [null, ...rounds]) {
        const button = document.createElement("button"); button.type = "button"; button.setAttribute("role", "tab");
        button.dataset.reviewRound = round?.week_start || "all";
        button.id = `review-tab-${button.dataset.reviewRound}`;
        button.textContent = round ? `Round ${round.round_number}` : "Overview";
        button.setAttribute("aria-controls", "review-results");
        tabs.append(button);
      }
      panel.setAttribute("role", "tabpanel"); panel.tabIndex = 0;
    }
    tablist.replaceChildren(tabs); tablist.hidden = !tablist.children.length;
    selectRound();
  }

  function click(event) {
    const tab = event.target.closest("[data-review-round]");
    if (tab && tablist.contains(tab)) selectRound(tab.dataset.reviewRound);
  }
  function keydown(event) {
    const tabs = [...tablist.children], index = tabs.indexOf(event.target);
    if (!stats || index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    selectRound(tabs[next].dataset.reviewRound, true);
  }
  tablist.addEventListener("click", click); tablist.addEventListener("keydown", keydown);
  return {
    render, clear,
    destroy() { clear(); tablist.removeEventListener("click", click); tablist.removeEventListener("keydown", keydown); },
  };
}
