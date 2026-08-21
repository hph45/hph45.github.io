(function prepareCarnapExercise() {
  "use strict";

  const practice = window.LOGIC_PRACTICE;
  const root = document.querySelector("#logic-checker-root");
  const problemId = new URLSearchParams(window.location.search).get("problem");
  const problem = practice?.problems.find((candidate) => candidate.id === problemId);

  function report(type) {
    window.parent.postMessage({ type, problemId }, window.location.origin);
  }

  if (!root || !problem) {
    if (root) root.innerHTML = '<p class="checker-error">This problem could not be found.</p>';
    report("logic-practice:error");
    return;
  }

  const exercise = document.createElement("section");
  exercise.className = "exercise logic-carnap-exercise";
  exercise.id = `exercise-${problem.id}`;
  exercise.dataset.carnapLabel = problem.id;

  const label = document.createElement("span");
  label.className = "logic-exercise-label";
  label.textContent = "Target sequent";

  const checker = document.createElement("div");
  checker.dataset.carnapGoal = problem.goal;
  checker.dataset.carnapOptions = "indent resize render tabindent fonts";
  checker.dataset.carnapSubmission = "none";
  checker.dataset.carnapSystem = practice.system;
  checker.dataset.carnapType = "proofchecker";

  exercise.append(label, checker);
  root.replaceChildren(exercise);

  // Carnap asks its host for saved derived rules at startup. Anonymous practice
  // deliberately has none, so answer locally and keep every check in-browser.
  window.jsonCommand = function jsonCommand(_request, onSuccess) {
    onSuccess("[]");
  };

  document.addEventListener("exercise-success", () => {
    report("logic-practice:success");
  });

  document.addEventListener("carnap-loaded", () => {
    document.body.classList.add("checker-ready");
    report("logic-practice:ready");
    document.querySelector("textarea")?.focus({ preventScroll: true });
  });

  window.addEventListener("error", (event) => {
    if (event.target instanceof HTMLScriptElement) report("logic-practice:error");
  }, true);
})();
