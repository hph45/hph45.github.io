# Zebra matchmaking

The static website at `/matchmaking/` uses the Supabase project `nvgwfygusjwjgqtlpnyf` for Google sign-in, private profiles, a community map, favorite-book rankings, and released matches.

## Finish Google login

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview). Create or select a project for Zebra Book Club. If prompted, complete branding with the app name, your support email, an **External** audience, and a contact email.
2. In **Audience**, add your Google account as a test user while the app is in Testing. Use only the basic `openid`, email, and profile scopes.
3. Under **Clients**, create an OAuth client with application type **Web application**.
4. Add these authorized JavaScript origins (no path):

   ```text
   https://zebrabookclub.com
   http://127.0.0.1:8080
   http://localhost:8080
   ```

5. Add this exact authorized redirect URI:

   ```text
   https://nvgwfygusjwjgqtlpnyf.supabase.co/auth/v1/callback
   ```

6. In [Supabase → Authentication → Sign In / Providers → Google](https://supabase.com/dashboard/project/nvgwfygusjwjgqtlpnyf/auth/providers), turn on **Enable Sign in with Google** and paste the **client ID** and **client secret** directly from Google. Save, then check that Google shows **Enabled** in the providers list for the **Matchmaking** project. Creating the Google client alone does not enable the Supabase provider. Keep the secret out of this repository and chat.
7. Reload the local matchmaking page. Sign in with your test account and create a profile. Before a public launch, move the Google app to Production and complete any branding requirements Google shows.

The Google callback above goes to Supabase. After that, Supabase redirects to the website. [Supabase URL Configuration](https://supabase.com/dashboard/project/nvgwfygusjwjgqtlpnyf/auth/url-configuration) should have:

- Site URL: `https://zebrabookclub.com/matchmaking/`
- Additional redirects: `http://127.0.0.1:8080/matchmaking/` and `http://localhost:8080/matchmaking/`

References: [Supabase Google login](https://supabase.com/docs/guides/auth/social-login/auth-google), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).

### Google branding links

The public policy pages are `privacy/index.html` and `terms/index.html`. They use `legal.css` and do not require JavaScript or sign-in. The homepage and matchmaking signup both link to them. Use these URLs in Google Auth Platform → Branding:

- Application home page: `https://zebrabookclub.com/`
- Application privacy policy: `https://zebrabookclub.com/privacy`
- Application terms of service: `https://zebrabookclub.com/terms`

GitHub Pages serves the policy directories with a trailing slash; the URLs above redirect to them. Local file changes do not publish these pages. Google must be able to open the published URLs for branding verification. Preview locally at `http://127.0.0.1:8080/privacy/` and `http://127.0.0.1:8080/terms/`.

If the local sign-in page says Google is still being set up, Supabase's public Auth settings are reporting Google as disabled. Recheck step 6 in the correct project, then reload `http://127.0.0.1:8080/matchmaking/`. Port 8082, if running, is only a static sample dashboard, not the functional app.

## Development

```sh
npm ci
npm run test:matchmaking
npm run build:matchmaking
python3 -m http.server 8080 --bind 127.0.0.1
```

Open `http://127.0.0.1:8080/matchmaking/`. Source is under `matchmaking/src/`; `matchmaking/app.js` is the bundled browser artifact and must be rebuilt after JavaScript changes. No build system runs on GitHub Pages.

The publishable key in `matchmaking/src/config.js` is intentionally public. Private profile access is enforced by database grants and row-level security. No server credential belongs in browser code.

## Diagnostics and log usage

Supabase meters **Log Ingestion** (new log data) separately from **Log Query** (log data scanned while inspecting logs). Opening Studio log views can consume query allowance, and repeating the same query scans the data again. Ordinary application database queries and RPCs are not log searches, although their activity can generate ingested logs. See [Log Query usage](https://supabase.com/docs/guides/platform/manage-your-usage/logs-query) for current allowances and enforcement status.

For routine development, prefer local tests, configuration inspection, and targeted Postgres metadata queries. Use the organization's **Usage** page to check totals and the actual billing-cycle reset date. Do not open Unified Logs or log-based reports just to check quota consumption.

When logs are needed for a specific failure, start with a **1–5 minute window**, one relevant source/service, and filters applied before querying. Expand the window only when the event cannot be found. Avoid broad 24-hour, all-source searches, repeated refreshes, and scripted log-query polling. Leave log views when the investigation is finished. Do not disable security/error logging to reduce diagnostic scan volume.

Budget new scans against the remaining allowance and days until reset, leaving a reserve for incidents. The Usage page can lag by an hour; compare readings after that delay and across subsequent days. These are operating practices, not an automatic quota cap. A rising counter without intentional log searches needs investigation of integrations or Supabase metering before further broad scans.

The operational target is **20 MB/day of ingestion** while the organization is on the 1 GB Free allowance. Check Usage every few days and before/after a release; use the actual cycle end shown there, not the calendar month. Recalculate `(allowance − used − reserve) / remaining days` after growth or a spike, reserving roughly 150 MB of ingestion and 20 GB of query allowance for incidents. This is a planning target, not an automated shutdown or a guarantee that the other Free limits will last until 50,000 MAUs.

For a configuration check, run `npm run inspect:logging`. It reads only Postgres settings and function metadata in a read-only transaction, returning no member data and performing no log searches. Run it on demand, not on a schedule. The November 2 audit found connection/disconnection logs, temporary-file logs, duration logs, and broad pgAudit logging already disabled. `log_statement=ddl` records schema changes; normal API reads/writes are not being logged as SQL statements. Keep warnings, errors, and lock-wait diagnostics. Do not set a duration/temp-file threshold to `0` thinking it means disabled: it enables logging every qualifying event.

For an incident, identify the failing request/time locally first, then query one log source over 1–5 minutes. Filter the query itself, inspect the result once, and leave the log view. Expand only if needed. Do not leave live log reports running, add scripted log searches, or use broad log queries for routine member counts and ranking checks. The public-map publisher below makes one ordinary aggregate RPC per run; it never queries logs. Nothing in this change turns off security logging or alters session lifetimes.

### Browser request reductions

Signed-in visits skip `/auth/v1/settings` entirely. The welcome screen checks Google when needed and caches only a confirmed enabled response for 24 hours; an OAuth-start failure forces a fresh check. A settings outage still permits a normal OAuth attempt. This cache cannot grant access or replace Google/Supabase authentication.

Signed-in dashboards cache only whitelisted community counts, cities, Top Ten, and Rising Favorites for 15 minutes. The browser entry belongs to the current account and is cleared on sign-out/account change/deletion. New profiles and changed cities/favorites invalidate it immediately; unrelated edits reuse it. Failed and malformed responses are not cached. Profiles, match/contact data, review ratings, and consent continue to load through their authenticated requests and never enter this aggregate cache.

### Shared hourly map publication

`.github/workflows/pages.yml` publishes the site on a push to `main`, manual dispatch, and at minute 17 of each hour. It builds/tests locally on the runner, stages an explicit allowlist of website assets, fetches the existing public map RPC **once**, validates/whitelists its output, and places it at `/assets/community-map.json` in the Pages artifact. It uses the public publishable key already in the site; no Supabase secret or member export is required. Generated snapshots are deployment artifacts, not hourly Git commits. A failed fetch or validation aborts the deployment and keeps the last successful site live.

In [repository Settings → Pages](https://github.com/hph45/hph45.github.io/settings/pages), the publishing Source must be **GitHub Actions**. Commit the workflow, scripts, source, and rebuilt bundles together. The next push starts the first publication; the hourly job exists only after the workflow reaches `main`. Deployments use the existing `github-pages` environment and custom domain. The workflow has no repository-content write permission.

Schedules are approximate: GitHub may delay runs, and disables scheduled workflows in public repositories after 60 days without repository activity. Check the latest successful run in Actions if map updates stop; re-enable/run it there if needed. The browser checks the static file at most every 15 minutes while the map is visible, tolerates delayed publication, and hides dots older than three hours. An outage never causes visitors to fall back to Supabase. See [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) and [schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

To preview the actual artifact locally, use a new output directory:

```sh
npm run build:matchmaking
npm run build:home
npm run build:pages -- /private/tmp/zbc-public-preview
npm run refresh:map -- /private/tmp/zbc-public-preview/assets/community-map.json
python3 -m http.server 8098 --bind 127.0.0.1 --directory /private/tmp/zbc-public-preview
```

`build-pages.mjs` refuses an existing destination and symlinked public assets. Private matching files, database scripts, local credentials, source tests, and development folders are outside the publication allowlist.

## Private admin dashboard

`/admin/` is an unlinked dashboard on the main domain. Sign in with the owner’s existing Google account at `/matchmaking/`, then open `/admin/` on that same origin. Signed-out visitors and other members are redirected to matchmaking. The page is marked `noindex` and is not included in public navigation.

The dashboard has **Matchmaking** and **Kaizen** tabs. Matchmaking retains the demographic breakdowns and searchable member directory. Kaizen contains a Poetry list; each selection opens a reader with preserved line breaks and stanza spacing, source attribution, and an English translation when supplied. Tabs support arrow keys, Home, and End; the reader closes with its close button or Escape.

Migration `20261025000100` creates the private `admin_poems` collection and `get_admin_poetry()` RPC. The RPC checks the same single-owner allowlist on every request. Anonymous users cannot execute it; other authenticated accounts receive `ADMIN_ONLY`. Browser roles, including the owner's browser, have no direct read or write access to the table. Populate or edit the collection through a privileged SQL connection or the Supabase dashboard. Keep the actual poem texts and seed files outside this public repository, including tests, fixtures, and static assets. Store `slug`, `title`, `author`, `body`, and `sort_order`; optional fields are `context`, `language` (`en` or `es`), `translation`, `translation_note`, `source_url`, and `source_label`.

Opening Kaizen makes one authorized request for the collection. Subsequent poem opens and tab switches use memory until the admin page is refreshed or left; nothing is saved in browser storage. Sign-out, account switches, authorization failures, and page navigation clear the collection and close any reader. The schema migration does not seed content or change who has admin access.

Both `get_matchmaking_admin_stats()` and `get_matchmaking_admin_profiles()` independently verify `auth.uid()` against the server-managed, single-row `matchmaking_admin_access` table on every call. Browser roles cannot read or modify that table. The page contains no owner email, user ID, service key, or client-side allowlist. Existing profile RLS remains owner-only, even for the admin. The statistics endpoint returns aggregate counts, city coordinates, and a median age. The separate profiles endpoint returns names, ages, locations, one to three favorites, an optional current read, settings, and answers for every currently selected connection type, including optional romance and business answers. It excludes exact birthdays, emails, Auth IDs, and retired answers. See [Supabase database function security](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker).

Apply all migrations through `20261023000200` first. They initially deny everyone. To configure access in a new project, find the verified Google account in **Supabase → Authentication → Users**, then use a privileged SQL connection (never a browser key):

```sql
-- Replace this placeholder with the verified account's Auth user ID.
insert into public.matchmaking_admin_access (user_id)
values ('OWNER_AUTH_USER_ID')
on conflict (singleton) do update set user_id = excluded.user_id, granted_at = now();
```

Deleting the row revokes access on the next request. Deleting the Auth account also removes its admin grant. Recreating an account with the same email does not inherit access. Owner configuration is held only in the database, not in repository migrations.

The dashboard counts completed profiles, including paused profiles, exactly once per member. Accounts that have not completed a profile have no demographic data and are excluded. Ages are calculated on the server from birthdays, with bands from 18–24 through 80+. Gender is collected only for romance; members without romance selected appear as **Not provided**. Connection-type counts include each member once per selected type, so these counts can overlap. Location totals use the canonical city catalog. Location search and pagination retain percentages of the full community, and Refresh retrieves a fresh snapshot.

The member directory shows books immediately and opens each person's current answers on demand. Search by name, current account email, city/region/country, book title, or author, and optionally filter by connection type, age, and gender. Email search accepts a full address or part of one and is case-insensitive. Migration `20261022000300` searches `auth.users.email` inside the protected function after the admin check; it does not return emails or grant browser access to Auth records. Results include paused profiles, sorted newest first, with 20 profiles per page and a server maximum of 50. The two endpoints are read-only; no editing, exports, or messages are sent from this page. Nothing from either response is saved to browser storage; sign-out, account changes, errors, and page navigation clear rendered data, and stale responses cannot restore it.

Migration `20261022000400` adds optional minimum age, maximum age, and gender parameters to the protected directory function. Ages refer to members' current ages, with inclusive bounds from 18 to 120; leave either field blank for no limit on that side. Gender options are Woman, Man, Other, and Not provided. The last includes anyone without romance selected and ignores retired gender answers. All filters combine with search before counting and pagination. Changing a filter returns to page one; Refresh retains the filters. The migration replaces the old function signature in one transaction, preserves older calls through default parameters, and reloads the API schema cache.

```sh
npm run test:admin
npm run build:admin
```

Source is in `admin/src/`; rebuild and include `admin/app.js` when publishing. A migration alone does not publish the static page. Local preview is `http://127.0.0.1:8080/admin/` after signing in on that same origin. Tests cover both endpoints' access denial, self-grant prevention, revocation, profile RLS, age boundaries, empty data, demographic totals, overlapping types, complete answers, bounded pagination, filtering, unsafe content, and delayed responses after account changes.

## Backend changes

The Supabase CLI is installed in this project. Use local login; do not paste access tokens or database passwords into source files.

```sh
npm run supabase -- login
npm run supabase -- link --project-ref nvgwfygusjwjgqtlpnyf
npm run supabase -- db push --dry-run --skip-vault
npm run supabase -- db push --skip-vault
npm run supabase -- config diff
npm run supabase -- config push
npm run supabase -- functions deploy delete-matchmaking-account search-books --use-api
```

These commands manage the Supabase backend; they do not run `git commit` or `git push`. Review each migration and configuration diff before applying it. Add a new migration for subsequent database changes; never edit an already-applied migration.

Both Edge Functions validate the bearer token with Supabase Auth themselves. Their `verify_jwt = false` setting does **not** make them anonymous: requests without a verified user receive 401. Supabase supplies server-only keys in its function environment.

## Product rules

- Instagram is optional at signup and when editing a profile. The browser normalizes a supplied username or profile URL to a handle; the database still validates it, and links always use the fixed Instagram domain. Members can add, change, or remove it without resetting either book-edit clock. Handles are self-reported, not verified against Instagram. The signup form, optional existing-member popup, and dashboard explain that readers without Instagram will only be able to contact matches by email. Saving a blank handle does not immediately prompt again. Migration `20261028000100` removes the Instagram requirement from match release while preserving the two-member, active-profile, and shared-category checks. Match generation must not exclude members for a missing handle. That migration does not expose email addresses or send messages. Migration `20261029000100` adds the configurable email fallback described below.
- Migration `20261024000200` adds Instagram without changing existing member answers, timestamps, book clocks, or totals. A handle is available only through the owner’s profile, the protected admin directory, and the existing participant-only released-introduction RPC. The admin directory can also search handles. Community RPCs do not return them. New signup and popup copy explain sharing with matches; the privacy page records this use. Google sign-in does not request access to Instagram or verify its account ownership.
- Members are 18 or older and choose one or more connection types: romance, friends, and business partners. Signup and editing use the same three steps: shared personal details, shared books, then the questions for every selected type. Each selected type's required answers are enforced in the form and database; questions marked optional remain optional.
- Romance uses Woman, Man, or Other for gender and the people they want to meet, a slider from 18 to 80+, and an optional private ideal-match answer (up to 600 characters). The 80+ maximum is stored as 120 (the platform's oldest permitted age), so it includes every older member. Migration `20261021000400` maps earlier gender choices to Other and preserves retired self-descriptions privately without allowing new client writes.
- Business profiles can include an optional LinkedIn personal or company page. Links are stored as canonical HTTPS URLs and shown only to their owner and released business matches. Saving after deselecting a type clears its current answers, including the LinkedIn link when removing business partners. Answers for retained types stay in place.
- Migration `20261022000000` backfills each existing choice into the owner-only `intents` array without changing answers, edit clocks, or favorite selection dates. Use this array for eligibility. The scalar profile `intent` is retained for older clients: legacy inserts and explicit single-type changes still work, and resubmitting an unchanged scalar does not collapse multiple selections. Older forms cannot save a multi-type profile if they clear answers that are still required; reload the updated site to edit those profiles.
- An introduction still has one specific `intent`, shared by both active members. Released introductions show only the answers for that type, and never expose another member's full selection of connection types. Migration `20261029000100` removes the one-introduction-per-member-per-week limit. A drop can contain multiple introductions of the same or different shared types; each introduction still has exactly two members. Multiple selections do not multiply member totals or book votes.
- Members select a city from the catalog. The community map returns anonymous city totals and city-center coordinates, with no names or profile links. The total counts completed member profiles, including paused members. Deleting a profile removes it from future totals.
- Each profile has one required favorite and up to two additional favorites. Autocomplete is optional for favorites and the current read: members can type a title and optionally an author when a book is missing or search is unavailable. Suggested books use an Open Library **work ID**, so editions of the same work group together. Catalog duplicates can still exist upstream; a future alias table can merge those if needed.
- Members can optionally select one **Currently reading** book in the same books step. It uses the same catalog autocomplete. Adding, replacing, or clearing a current read is limited to once every rolling 24 hours, independently from the favorites limit. Migration `20261023000100` adds the catalog ID and canonical title/author without changing existing profiles' timestamps. A current read can also be a favorite; it does not add a favorite vote, change recent-favorite dates, or reset the 24-hour favorites clock. It appears on the member's profile, in released introductions, and in the protected admin directory, where its title and author are searchable. Blank selections stay hidden; a cleared selection still retains its edit timer. Migration `20261023000200` adds the server-owned `current_book_updated_at` clock. Signup with a current read starts this clock; skipping it allows a first selection later. Existing selections from before this limit may be changed once before their clock starts, because no earlier current-read timestamps were recorded. Unchanged reads and other profile edits never reset either clock. Existing profile RLS and introduction access checks still apply.
- The database resolves book titles/authors and city labels from their catalog IDs. Migration `20261024000100` also accepts the explicit `manual` book-ID marker on profile saves. A private trigger resolves an existing title/author match or creates a stable `ZB` ID from normalized title/author text; case, whitespace, punctuation, and Unicode width variations share that ID. With no author, a known title is reused only when its author is unambiguous; otherwise the book is saved with “Unknown author.” Manual entries are created inside the profile transaction, so rejected saves roll them back. Clients cannot directly insert or modify catalog rows or invoke the private resolver. The existing profile ownership rules, duplicate checks, and both 24-hour edit clocks still apply. Entries with different spelling or missing authors can still require later reconciliation; do not automatically merge ambiguous works.
- Favorite book IDs can change once every rolling 24 hours, starting at profile creation or the last actual book change. Other preferences remain editable. The database enforces the interval using its own clock; sign-out, another browser, or a direct API request does not reset it.
- The book-explanation question is retired. Migration `20261021000300` allows new profiles without it, prevents client writes to the legacy column, and excludes old answers from introductions. Previously submitted answers are retained privately with their owner's account rather than deleted by the migration.
- The top ten counts each saved favorite once per member, with equal weight for all three positions. Counts are labeled **favorite/favorites**. Ties are sorted by title and work ID. It shows fewer than ten entries until enough distinct books have been selected.
- Rising favorites ranks current selections added in the preceding seven days, counting each member once per book. A shared snapshot refreshes on the first dashboard request after 48 hours; ties use title and work ID. The dashboard takes the first two candidates outside the **current** Top Ten, skipping books no longer on any bookshelf. It shows fewer than two if there are not enough eligible books.
- Migration `20261021000500` tracks addition dates privately for each current favorite. Reordering favorites, keeping a book while replacing another, and editing other profile fields do not change its date. Removing and re-adding a book starts a new selection, with at most one vote per member. Deleting an account cascades its selections. Historical per-book dates were not recorded: the migration conservatively seeds existing selections with profile creation dates, so older accounts' recent changes may initially be undercounted. All additions after migration use the server's exact date.
- Top Ten and Rising favorites reuse local covers and Amazon affiliate links from `reviews.csv`, `book_club_current.csv`, the review-cover manifest, and `matchmaking/books.csv`. Matching uses work IDs or an unambiguous title-and-author pair; `matchmaking/src/review-catalog.js` also records known original-language work aliases. These presentation aliases do not merge ranking totals. Missing or failed local covers display a ZBC placeholder, with **no database, Edge Function, or external cover lookup**. Uncurated books use a regular Amazon title-and-author search link constructed in the browser.
- Add curated Top Ten links and covers to `matchmaking/books.csv`, keyed by Open Library work ID. It can add unreviewed books or fill in missing links for reviewed books. Store new covers under `assets/matchmaking-covers/` and record the edition ISBN and source URL in the CSV. Existing Amazon URLs are preserved, including `amzn.to` and `link.amazon` short links; a blank cover field retains any matching review cover.
- Profiles are readable only by their owners. A separate function exposes limited details of explicitly released matches to their two participants. Birthdays, gender preferences, ideal-match answers, and account IDs are not returned in introductions. Email contact follows the separate contact setting described below; the legacy match RPC still never returns email addresses.
- The account-deletion function deletes only the authenticated user's Supabase Auth account. Foreign-key cascades remove their profile and match memberships.

## Book search and geography

On the home page, the live map sits behind the countdown. Its dots have city-only hover and accessible labels, with no click selection, focus stops, displayed reader totals, or zoom controls. The countdown's outlined phase has transparent fill so the map remains visible through the digits. The shared marker renderer preserves counts and the full interactive map on the signed-in dashboard. Home-page map attribution is on the Privacy page, linked from the footer.

The home-page community map publisher uses `get_public_matchmaking_map()` (migration `20261027000100`). This dedicated public RPC exposes only the completed-profile count, city-center coordinates, city labels, and counts per city, including paused members, exactly as in the member map. It returns no personal identifiers, contacts, books, or preferences. The existing dashboard RPC remains authenticated-only. A private RLS-protected singleton caches the aggregate for one hour; concurrent refreshes serialize on its row and recheck freshness. Legacy clients can still call this endpoint; the current home-page bundle reads only the published JSON file.

The home page fetches the shared map file only near the viewport, through a small bundle built with `npm run build:home`. It sends no Supabase request, API key, or login/session data. Browser storage holds only the whitelisted aggregate. Visible maps recheck the static file every 15 minutes; background tabs and offscreen maps do not poll. The hourly Pages workflow provides updates without per-visitor database traffic, Edge Functions, external map tiles, or catalog lookups. Updates are approximate and depend on publication timing. Run `npm run test:home` for the public-data boundary, cache, and artifact-publication checks.

Book and city autocomplete search **static reference catalogs in the browser**. The initial snapshot contains 34,784 Open Library works and 34,174 cities. Each catalog downloads only when its field is first focused or searched; all four book fields share one download. Content-hashed URLs allow HTTP caching across visits, and typing never sends search text to Supabase or an external provider. Search matches titles/authors or city/region/country names without requiring exact casing, accents, or punctuation. Identical title-and-author suggestions are deduplicated; selected IDs still receive database validation on save.

Members can still type any book title and optionally an author, including when a static download fails. Saving typed books uses the database directly and never depends on Open Library. City selection still requires a valid catalog suggestion. Profile ownership, book edit clocks, and all other server rules remain in force. Login, profiles, matches, and community totals/rankings continue to use Supabase. No backend deployment is needed for this static-catalog change.

The legacy authenticated `search-books` function and search RPCs remain available for already-open/cached older clients. They use [Open Library's Search API](https://openlibrary.org/dev/docs/api/search), a 24-hour query cache, and a shared upstream throttle. **The new browser bundle calls none of them.** Do not remove these compatibility endpoints as part of a static-asset deployment. Their tests remain to protect older clients.

To refresh the static catalogs from existing public reference metadata:

```sh
npm run supabase -- db query --linked --file scripts/export-static-catalogs.sql --output json > /private/tmp/zbc-static-catalog-export.json
npm run build:catalogs -- /private/tmp/zbc-static-catalog-export.json
npm run test:matchmaking
npm run build:matchmaking
```

The export also reports the current Top 20 for a cover/link audit; the builder discards those rankings and counts. Only Open Library work IDs/titles/authors and city reference fields are written to `matchmaking/data/`. **Never export profiles, email addresses, search history, or manually entered `ZB` book text into public site files.** Commit/deploy the generated manifest, hashed JSON files, and rebuilt bundle together. Keep older hashed catalogs available for cached clients. Refreshing these files is a deliberate maintenance task; a newly saved book does not automatically become a public autocomplete suggestion. For a much larger source catalog, use Open Library data dumps under their [API guidelines](https://openlibrary.org/developers/api), not bulk Search API requests.

The city catalog contains 34,174 records from the [GeoNames cities15000 extract](https://download.geonames.org/export/dump/), downloaded October 21, 2026, plus region names from `admin1CodesASCII.txt`. GeoNames is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Records were transformed into SQL and country names localized into English. Members in smaller towns can choose a nearby city.

The world outline uses [Natural Earth 1:110m countries](https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/), a public-domain dataset. Country geometry comes from the [Natural Earth source repository](https://github.com/nvkelso/natural-earth-vector). Both outlines and dots use D3's Natural Earth projection. `scripts/build-matchmaking-geography.mjs` records the transformation; do not regenerate its migration after deployment. Source credits also appear in the site footer.

Country hover on the signed-in matchmaking and admin maps shows the country’s completed-profile count and most-favorited book. Counts include paused profiles, consistently with city dots. Each of the three favorite slots contributes one vote per reader per book; current reads do not vote. Equal counts use title then work ID for a stable choice. Hover or focus a country, or tap it on a phone, to see its summary. City dots sit above the country layer and retain their existing interactions and zoom behavior. The homepage continues to show city labels only.

Migration `20261102000300_country_map_favorites.sql` adds these summaries to the existing community/admin responses through a private helper whose execution is denied to browser roles. No new per-hover calls, polling, external map service, or public book statistics are added. Country summaries share the member dashboard’s 15-minute aggregate cache; admin Refresh reloads them with the other statistics. Static hit areas are generated by `scripts/build-map-countries.mjs` from the same Natural Earth outline, then bundled in `country-shapes.js`. Very small countries/islands omitted by the outline show a labeled country summary alongside their existing city-dot details instead. This fallback is disabled on the public map. Apply the migration before publishing the rebuilt admin and matchmaking bundles and updated HTML/CSS.

The community map zooms from 1× to 8× with shared transforms for the outline and city dots. Desktop has a compact +/− control at the map's top right, mouse dragging, trackpad pinch, and Ctrl+scroll. Touchscreens get larger controls and a reset button; two fingers pinch and pan while one finger retains normal page scrolling. No gesture instructions appear on either layout. Keyboard users can focus the map and use +/−, arrow keys, and 0/Home/Escape to reset. Zoom stays local to the page and resets on sign-out; it requests no additional location data.

## Match cards and introduction history

Apply `20261029000100_match_introductions.sql` before deploying the rebuilt matchmaking bundle. It preserves profiles and existing matches, adds a private per-participant first-reveal time, removes the one-match-per-week constraint, and stores the recommended book and reason on each pair. New releases must have a catalog `recommended_book_id` and a nonempty `recommendation_reason`; the book cannot already be either reader’s favorite or current read. Existing released matches remain readable without a retroactive recommendation. This migration does not generate or release any matches.

`get_my_matchmaking_introductions` returns only the caller’s released two-person introductions, newest release first, with a cursor for older pages (24 per page, maximum 48). Drafts, future releases, outsiders, and deleted/incomplete pairs are excluded. The original `get_my_matchmaking_matches` remains for cached clients. `reveal_matchmaking_match(p_match_id)` records the caller’s first reveal idempotently; the other participant cannot see that timestamp. Clients cannot edit raw match tables, recommendations, or other members’ reveal state.

The dashboard keeps its original empty state until an introduction is released. New cards show only the connection type and “Click to reveal.” The dialog shows the limited match profile, a shared next read, and contact action. Revealed cards retain name, age, location, and recommended book across later drops and devices. Older history loads on demand. There is no polling, profile directory, private browser cache, or external cover request; covers use the same static catalog as the book rankings. Sign-out and account changes clear the dialog and history and invalidate pending responses.

Instagram is the default contact action. If the other member has no Instagram, the new RPC includes their Google account email **only when `share_email_with_matches` is enabled**. This setting is checked by default at signup. The pending migration initializes existing profiles to true; a saved opt-out stays off across edits, logins, and later releases. Members can turn it off in the form or the Settings section below their matches. It is independent of the `email_matches` notification setting. The email button opens the member’s mail app; the site does not send email. A member who has not shared either contact method has a clear pending-contact message. Revocation hides email from subsequent responses; copies already received cannot be recalled. No emails are added to community/map responses or public static catalogs.

Validation: `npm run test:matchmaking`, `npm run test:admin`, and `npm run build:matchmaking`. The in-memory database tests cover paging across more than 60 same-drop introductions, shared recommendations, participant authorization, reveal isolation, contact consent/revocation, and account deletion. Matching algorithms, duplicate-pair prevention, load balancing, recommendation selection, admin review of a batch, scheduling, and notification delivery remain separate release work.

## Private match reviews

Each released introduction has a **Review this match** button. Its smaller dialog stays above the open introduction and collects separate 1–5 star scores for compatibility and the recommended book. A saved review can be edited; it is not shown to the other participant. The book score is tied to the recommendation that was displayed, so a stale page cannot rate a replacement book accidentally. Older introductions without a recommendation can still receive a compatibility rating.

Migration `20261102000100_match_reviews.sql` adds `matchmaking_match_reviews`, `get_my_matchmaking_match_review(uuid)`, and `save_matchmaking_match_review(uuid, integer, integer, text)`. Both RPCs require the signed-in caller to belong to a released two-person introduction. There is one review per match and reviewing member. Raw table access is denied to browser roles; trusted service/database access can read the private feedback. Reviews cascade when their match membership is deleted. No ratings are added to introduction, map, or community responses.

The browser reads a review only when the member opens the review dialog, caches it in memory for the current signed-in session, and writes only on **Save review**. Account changes clear that cache and invalidate pending responses. Apply the migration before publishing the updated HTML, CSS, and rebuilt matchmaking bundle.

Migration `20261102000200_admin_match_reviews.sql` adds aggregate review statistics to the existing admin-only `get_matchmaking_admin_stats()` response. The Matchmaking tab shows separate compatibility and book recommendation averages and 1–5 star distributions, with counts and percentages. Totals cover all currently released two-person matches; each reader’s latest review of each match counts once. Book ratings use their own denominator, excluding reviews without a book score. No reviews is shown as zero counts and an unset average, never a zero-star rating.

These charts load with the rest of the admin statistics and update on **Refresh**. They add no request, polling, browser storage, or public data. The owner still cannot read the raw review table through the browser. Sign-out, account changes, navigation, and failed authorization clear the charts. Apply the migration before publishing the updated admin HTML, CSS, and rebuilt `admin/app.js`.

## Friend matchmaking suggestions

The header’s **Matchmake friends** button is available to signed-in members with a completed profile. Its dialog accepts two Instagram handles or profile links and clearly describes the feature as romance only. Migration `20261029000200_friend_matchmaking_suggestions.sql` stores submissions privately in `matchmaking_friend_suggestions` through `suggest_matchmaking_friends`. Review that table through Supabase’s privileged Table Editor or a service connection; it is not exposed in the public site or member profile directory.

The RPC takes caller identity from Auth, validates and canonicalizes handles, treats the pair in either order as the same suggestion, and limits each member to five new pairs per rolling 24 hours. Repeated submissions return the same acknowledgement without duplicate rows. Only the service role can read or modify the raw table. There is no target-account lookup in the submission path, and the response never discloses whether either friend is a member. Suggestions do not create or release matches, notify friends, or override anyone’s romance selection or mutual preferences. Deleting the submitting account removes its suggestions. No handles are kept in browser storage; sign-out closes and clears the dialog and invalidates pending responses.

Apply both pending October 29 migrations before deploying the rebuilt matchmaking bundle. The profile card now expands through **View more**, and account controls live in **Settings** below the matches.

## Next stage

The current release supports login, profiles, the member dashboard, and displaying released matches. **No weekly scheduler or match emails are running yet.** Next, implement mutual compatibility rules and pair generation using the intersection of both members' `intents`, then add the weekly job and an email provider. Respect `is_active` and `email_matches`, prevent repeat pairings, and populate a shared recommended book and reason before releasing each pair. Email contact follows the setting below; no notifications or introductions are sent by this UI.

The initial test suite covers form flows, failed saves, canonical book handling, the 24-hour interval, deletion authentication, database ownership, anonymous aggregates, match release rules, and cascade deletion. It uses in-memory Postgres (PGlite) and a DOM environment; the final Google OAuth round trip also needs a real enabled Google provider and test account.
