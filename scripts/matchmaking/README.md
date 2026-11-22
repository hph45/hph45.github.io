# Offline matchmaking

This code prepares private introduction proposals. It never writes to Supabase,
releases introductions, changes member preferences, sends messages, or publishes
files. All member data, model caches, review ledgers, and generated plans belong
in the ignored `.matchmaking-private` directory.

## Current coverage mode

The operator explicitly requested broad coverage even for weak fits, relaxed
operator introduction-count and friendship-age limits, instructed the matcher to
ignore location, and required no repeat person-pair. Those instructions are
frozen in each run's `policy.json`; they do not alter saved member preferences.

1. Export one read-only repeatable-read snapshot with `snapshot.sql`, then close
   the cohort. Include current profiles, prior introductions, ratings, blocks,
   library IDs, test accounts and reports. Account email addresses are omitted.
2. Enforce active/adult/contact status, explicit account holds, mutually selected
   connection types, reciprocal romantic age and gender preferences, blocks,
   reviewed explicit incompatibilities, and every previous person-pair across
   connection types. Transfer history across verified duplicate/recreated
   identities without copying old preferences. Recover archived pair membership
   and recommendation history when deletion has removed a database join.
   An explicitly requested pair can reserve both people exclusively. Bind the
   request to hashes of their current profiles and enforce all ordinary type,
   romance, activity, history, block and account-hold rules. A named endpoint
   without a consented contact route may appear only in that private requested
   pair, with a mandatory contact-review hold; saved sharing settings stay intact.
3. In `ignore_location` mode, city, distance and geographic country-pair rules
   do not filter or score pairs, except explicit `radius` preferences: these
   always require both members to be within their saved `match_radius_miles`.
   Missing coordinates or invalid radii fail closed. Distances are straight-line
   city-center distances (6,371 km Earth radius; 1 mile = 1.609344 km).
   `anywhere` adds no distance cap; pairs using anywhere/radius are ranked without
   distance bonuses or penalties. Record every cross-location introduction where
   someone saved a local-only preference. Show that exception prominently in
   the private review; never claim that member chose openness to anywhere.
4. Canonicalize exact title-and-author duplicates and reviewed leading-article
   variants. Cache public descriptions/subjects with their provenance. Custom
   book IDs resolve by exact title AND author. Missing metadata remains missing.
   Encode books locally with the pinned MiniLM model revision. Insufficiently
   enriched records receive no semantic/genre credit; exact shared books and
   authors still count. No member text is sent to an LLM or an embedding API.
5. Compare every favorite with its best counterpart, averaging both directions.
   The book-fit formula combines shelf affinity, bounded rare shared-title
   evidence and author overlap. Explicit shared catalog genres have a bounded
   0.5–0.6 similarity floor; the same known author has a 0.75 floor. Vectorize the
   all-person fit matrix, then recompute retained edges in detail for the audit.
6. Rank romance by 90% book fit and 10% age proximity. Friendship uses 80% books,
   10% explicitly shared activities and 10% age when both supplied activities;
   otherwise 90% books and 10% age. Age proximity is `1 / (1 + gap / 10)` and is
   only a heuristic within mandatory romantic age ranges. Business uses 50%
   books and 50% reciprocal offered/requested skill overlap. Location has zero
   weight. Weights are declared policy choices, not calibrated probabilities.
7. Do not reject otherwise eligible first introductions for low scores or weak
   evidence. Keep standard/broader/weak evidence labels, and use factual reasons
   that acknowledge limited overlap. Every selected pair in coverage mode must
   supply at least one person's sole total introduction. Extra introductions
   and broad friendship age gaps therefore serve first-match recipients.
8. Stream the full eligible graph through per-person top-quality and stable
   hash-exploration shortlists. Audit that every nonisolated full-graph vertex
   retains an edge. Find an exact maximum-cardinality matching on the retained
   graph, with optional exact additive quality optimization. Attach uncovered
   vertices using flow that minimizes maximum helper load for that matching,
   then quality and squared load. The resulting components are stars.
   This covers every nonisolated person, proving maximum unique coverage on the
   full eligible graph. Minimum pair count and matching quality are exact only
   on the retained graph; global total-cover quality and helper-load optimality
   are not claimed. Display every helper's full load and all recipient assignments.
9. Recommend a supported new book from the explicit standalone/series-entry
   catalog. Require affinity of at least 0.35 to BOTH shelves. Exclude favorites,
   current reads, library books, historical recommendations, duplicate public
   source works, and repeated suggestions within this round. Protected series
   entries are withheld from known readers of the same author. Missing supported
   recommendations remain review items rather than invented evidence.
10. Flag written requirements for review. A book embedding cannot establish
    faith, parenting intentions, attraction or other unrecorded traits. Manual
    clear/exclude decisions require rationale and hashes of both exact profiles.
    The report separates proposals without current holds from held-only recipients.
11. Audit selected pairs independently, reconstruct the entire hard-eligible
    graph separately, verify identity/history exclusions, recalculate scores and
    recommendation novelty, and check full coverage and every sole-recipient
    condition. Negative controls must reject deliberate violations. Replay the
    full process with another Python hash seed and compare the content digest.

## Reviews

The review form records compatibility and book-recommendation star ratings,
without comments or contact outcomes. Analyze every recorded rating, identify
repeat reviewers, and use dated pre-release profiles for retrospective features.
A well-liked suggested book is not evidence of a successful personal match.
Sparse, voluntary, one-sided ratings do not justify trained chemistry claims or
hard rejection thresholds. The private review ledger preserves all rows and
clearly distinguishes observed ratings from hypotheses.

## Running

Use the private environment installed from `requirements.lock.txt`. Initial
public metadata/model downloads require network access; allocation and audit
use frozen local artifacts. `ROUND_DIRECTORY` below is a placeholder for a new
private run containing the snapshot and policy.

```sh
.matchmaking-private/.venv-round-two/bin/python -B -m unittest discover -s scripts/matchmaking -p 'test_*.py'
.matchmaking-private/.venv-round-two/bin/python -B -u scripts/matchmaking/prepare.py .matchmaking-private/ROUND_DIRECTORY
.matchmaking-private/.venv-round-two/bin/python -B -u scripts/matchmaking/engine.py .matchmaking-private/ROUND_DIRECTORY
.matchmaking-private/.venv-round-two/bin/python -B scripts/matchmaking/audit.py .matchmaking-private/ROUND_DIRECTORY
.matchmaking-private/.venv-round-two/bin/python -B scripts/matchmaking/report.py .matchmaking-private/ROUND_DIRECTORY
```

For replay, run the engine with `--output replay.json` and audit with
`--plan replay.json`. `plan_sha256` excludes runtime timing. Freeze the source
files and input hashes with the final run. After a sparse metadata refinement,
use `prepare.py --stage embeddings`; `--stage cached` would discard refinements
by reconstructing from the older cache.

## Legacy capped mode

The engine retains the earlier score-gated CP-SAT allocator when broad coverage
is disabled. It can enforce numeric per-type/total caps, wider-friendship and
first-introduction exceptions, fixed seeds and deterministic work budgets.
Record every solver status and bound; a feasible solution or local repair is
not a proof of optimality. Location preferences are binding when the explicit
location override is disabled. Do not apply the coverage proof to this mode.

## Release boundary

Plans and review pages are private drafts. A separately authorized release needs
fresh checks of current preferences, activity/contact availability, blocks,
previous introductions, account identity, and all unresolved review items.
Later signups and changes lie outside the frozen batch. Never publish private
snapshots, candidate graphs or operator review files with the public website.
