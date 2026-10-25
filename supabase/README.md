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

- New signup forms require an Instagram username or profile URL. The browser normalizes it to a handle; the database validates the canonical handle, and links always use the fixed Instagram domain. Members can update it without resetting either book-edit clock. Handles are self-reported, not verified against Instagram. Existing members see a popup on each visit until they add one; “Not now” dismisses it for that visit and leaves their other profile settings editable. The dashboard also provides an Add Instagram button. Blank legacy handles remain null for a compatible rollout, including old browser clients, but `validate_matchmaking_release` prevents releasing any new match unless **both** members have a handle. Once supplied, a handle can be replaced but not cleared. Match generation must filter `instagram_handle is not null` alongside `is_active` and mutual preferences.
- Migration `20261024000200` adds Instagram without changing existing member answers, timestamps, book clocks, or totals. A handle is available only through the owner’s profile, the protected admin directory, and the existing participant-only released-introduction RPC. The admin directory can also search handles. Community RPCs do not return them. New signup and popup copy explain sharing with matches; the privacy page records this use. Google sign-in does not request access to Instagram or verify its account ownership.
- Members are 18 or older and choose one or more connection types: romance, friends, and business partners. Signup and editing use the same three steps: shared personal details, shared books, then the questions for every selected type. Each selected type's required answers are enforced in the form and database; questions marked optional remain optional.
- Romance uses Woman, Man, or Other for gender and the people they want to meet, a slider from 18 to 80+, and an optional private ideal-match answer (up to 600 characters). The 80+ maximum is stored as 120 (the platform's oldest permitted age), so it includes every older member. Migration `20261021000400` maps earlier gender choices to Other and preserves retired self-descriptions privately without allowing new client writes.
- Business profiles can include an optional LinkedIn personal or company page. Links are stored as canonical HTTPS URLs and shown only to their owner and released business matches. Saving after deselecting a type clears its current answers, including the LinkedIn link when removing business partners. Answers for retained types stay in place.
- Migration `20261022000000` backfills each existing choice into the owner-only `intents` array without changing answers, edit clocks, or favorite selection dates. Use this array for eligibility. The scalar profile `intent` is retained for older clients: legacy inserts and explicit single-type changes still work, and resubmitting an unchanged scalar does not collapse multiple selections. Older forms cannot save a multi-type profile if they clear answers that are still required; reload the updated site to edit those profiles.
- An introduction still has one specific `intent`, shared by both active members. Released introductions show only the answers for that type, and never expose another member's full selection of connection types. The one-introduction-per-member-per-week limit applies across all types. Multiple selections do not multiply member totals or book votes.
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
- Profiles are readable only by their owners. A separate function exposes limited details of explicitly released matches to their two participants. Birthdays, emails, gender preferences, ideal-match answers, and account IDs are not returned in introductions.
- The account-deletion function deletes only the authenticated user's Supabase Auth account. Foreign-key cascades remove their profile and match memberships.

## Book search and geography

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

The community map zooms from 1× to 8× with shared transforms for the outline and city dots. Desktop has a compact +/− control at the map's top right, mouse dragging, trackpad pinch, and Ctrl+scroll. Touchscreens get larger controls and a reset button; two fingers pinch and pan while one finger retains normal page scrolling. No gesture instructions appear on either layout. Keyboard users can focus the map and use +/−, arrow keys, and 0/Home/Escape to reset. Zoom stays local to the page and resets on sign-out; it requests no additional location data.

## Next stage

The current release supports login, profiles, the member dashboard, and displaying released matches. **No weekly scheduler or match emails are running yet.** Next, implement mutual compatibility rules and pair generation using the intersection of both members' `intents`, then add the weekly job and an email provider. Respect `is_active` and `email_matches`, prevent repeat pairings, and choose how matched people consent to exchanging contact details. No member email address is currently exposed to another member.

The initial test suite covers form flows, failed saves, canonical book handling, the 24-hour interval, deletion authentication, database ownership, anonymous aggregates, match release rules, and cascade deletion. It uses in-memory Postgres (PGlite) and a DOM environment; the final Google OAuth round trip also needs a real enabled Google provider and test account.
