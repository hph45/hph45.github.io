(function initializeLogicPractice() {
  "use strict";

  const practice = window.LOGIC_PRACTICE;
  const frame = document.querySelector("#logic-exercise-frame");
  const frameShell = document.querySelector("#logic-frame-shell");
  const problemLabel = document.querySelector("#logic-problem-label");
  const levelDescription = document.querySelector("#logic-level-description");
  const status = document.querySelector("#logic-status");
  const solvedCount = document.querySelector("#logic-solved-count");
  const nextButton = document.querySelector("#logic-next");
  const difficultyButtons = [...document.querySelectorAll("[data-difficulty]")];

  if (!practice || !frame || !frameShell) return;

  let difficulty = "easy";
  let currentProblem = null;
  let solvedThisVisit = 0;
  const seenProblemIds = new Set();
  const solvedProblemIds = new Set();

  function choicesFor(level) {
    if (level === "random") return [...practice.problems];
    return practice.problems.filter((problem) => problem.difficulty === level);
  }

  function chooseProblem(level) {
    const choices = choicesFor(level);
    const unseen = choices.filter((problem) =>
      !seenProblemIds.has(problem.id) && problem.id !== currentProblem?.id
    );
    const alternatives = choices.filter((problem) => problem.id !== currentProblem?.id);
    const pool = unseen.length ? unseen : alternatives.length ? alternatives : choices;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function displayNumber(problem) {
    const peers = practice.problems.filter(
      (candidate) => candidate.difficulty === problem.difficulty
    );
    return String(peers.findIndex((candidate) => candidate.id === problem.id) + 1)
      .padStart(2, "0");
  }

  function titleCase(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function setStatus(message, state = "") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function loadProblem(problem) {
    currentProblem = problem;
    seenProblemIds.add(problem.id);
    frameShell.setAttribute("aria-busy", "true");
    frameShell.classList.remove("is-ready", "is-solved", "is-error");
    problemLabel.textContent = `${titleCase(problem.difficulty)} · Problem ${displayNumber(problem)}`;
    levelDescription.textContent = practice.difficultyDescriptions[difficulty];
    setStatus("Loading the proof checker…", "loading");
    frame.src = `exercise.html?problem=${encodeURIComponent(problem.id)}`;
  }

  function setDifficulty(nextDifficulty) {
    difficulty = nextDifficulty;
    difficultyButtons.forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.difficulty === difficulty)
      );
    });
    loadProblem(chooseProblem(difficulty));
  }

  difficultyButtons.forEach((button) => {
    button.addEventListener("click", () => setDifficulty(button.dataset.difficulty));
  });

  nextButton.addEventListener("click", () => loadProblem(chooseProblem(difficulty)));

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (!message || message.problemId !== currentProblem?.id) return;

    if (message.type === "logic-practice:ready") {
      frameShell.setAttribute("aria-busy", "false");
      frameShell.classList.add("is-ready");
      setStatus("Live checking is on. Every line is checked as you type.", "ready");
    }

    if (message.type === "logic-practice:error") {
      frameShell.setAttribute("aria-busy", "false");
      frameShell.classList.add("is-error");
      setStatus("The proof checker could not load. Try refreshing this page.", "error");
    }

    if (message.type === "logic-practice:success") {
      frameShell.classList.add("is-solved");
      if (!solvedProblemIds.has(message.problemId)) {
        solvedProblemIds.add(message.problemId);
        solvedThisVisit += 1;
        solvedCount.textContent = String(solvedThisVisit);
      }
      setStatus("Correct. You reached the target conclusion.", "success");
    }
  });

  window.setTimeout(() => {
    if (frameShell.getAttribute("aria-busy") === "true") {
      frameShell.classList.add("is-error");
      setStatus("Carnap is taking longer than expected to load.", "error");
    }
  }, 15000);

  loadProblem(chooseProblem(difficulty));
})();
