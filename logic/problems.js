(function defineLogicProblems(global) {
  "use strict";

  const system = "thomasBolducAndZachTFL2019";

  global.LOGIC_PRACTICE = Object.freeze({
    system,
    difficultyDescriptions: Object.freeze({
      easy: "Direct proofs · introductions and eliminations",
      medium: "Subproofs · conditionals, disjunctions, and negation",
      hard: "Nested strategy · indirect and multi-stage proofs",
      random: "A surprise from any level",
    }),
    problems: Object.freeze([
      { id: "e01", difficulty: "easy", goal: "P /\\ Q :|-: P" },
      { id: "e02", difficulty: "easy", goal: "P /\\ Q :|-: Q /\\ P" },
      { id: "e03", difficulty: "easy", goal: "P, P -> Q :|-: Q" },
      { id: "e04", difficulty: "easy", goal: "P :|-: P \\/ Q" },
      { id: "e05", difficulty: "easy", goal: "P -> Q, Q -> R, P :|-: R" },
      { id: "e06", difficulty: "easy", goal: "P /\\ (Q /\\ R) :|-: R" },
      { id: "e07", difficulty: "easy", goal: "P, Q :|-: P /\\ Q" },
      { id: "e08", difficulty: "easy", goal: "P -> Q, P -> R, P :|-: Q /\\ R" },
      { id: "e09", difficulty: "easy", goal: "P /\\ Q, Q -> R :|-: P /\\ R" },
      { id: "e10", difficulty: "easy", goal: "P -> (Q /\\ R), P :|-: R" },

      { id: "m01", difficulty: "medium", goal: "P :|-: Q -> P" },
      { id: "m02", difficulty: "medium", goal: ":|-: P -> P" },
      { id: "m03", difficulty: "medium", goal: "P -> Q, Q -> R :|-: P -> R" },
      { id: "m04", difficulty: "medium", goal: "P \\/ Q, P -> R, Q -> R :|-: R" },
      { id: "m05", difficulty: "medium", goal: "P -> Q :|-: ~Q -> ~P" },
      { id: "m06", difficulty: "medium", goal: "P -> (Q /\\ R) :|-: P -> Q" },
      { id: "m07", difficulty: "medium", goal: "(P /\\ Q) -> R :|-: P -> (Q -> R)" },
      { id: "m08", difficulty: "medium", goal: "P -> R, Q -> R :|-: (P \\/ Q) -> R" },
      { id: "m09", difficulty: "medium", goal: "P :|-: ~(P -> Q) -> ~Q" },
      { id: "m10", difficulty: "medium", goal: "P \\/ Q, ~P :|-: Q" },

      { id: "h01", difficulty: "hard", goal: ":|-: P \\/ ~P" },
      { id: "h02", difficulty: "hard", goal: ":|-: ((P -> Q) -> P) -> P" },
      { id: "h03", difficulty: "hard", goal: "~(P \\/ Q) :|-: ~P /\\ ~Q" },
      { id: "h04", difficulty: "hard", goal: "~P /\\ ~Q :|-: ~(P \\/ Q)" },
      { id: "h05", difficulty: "hard", goal: "P \\/ (Q /\\ R) :|-: (P \\/ Q) /\\ (P \\/ R)" },
      { id: "h06", difficulty: "hard", goal: "(P -> R) /\\ (Q -> S), P \\/ Q :|-: R \\/ S" },
      { id: "h07", difficulty: "hard", goal: "~(P /\\ Q) :|-: ~P \\/ ~Q" },
      { id: "h08", difficulty: "hard", goal: "P -> Q, ~P -> Q :|-: Q" },
      { id: "h09", difficulty: "hard", goal: "(P -> Q) -> R, ~R :|-: ~(P -> Q)" },
      { id: "h10", difficulty: "hard", goal: "P -> (Q -> R) :|-: Q -> (P -> R)" },
    ]),
  });
})(window);
