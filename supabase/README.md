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

## Private admin dashboard

`/admin/` is an unlinked dashboard on the main domain. Sign in with the owner’s existing Google account at `/matchmaking/`, then open `/admin/` on that same origin. Signed-out visitors and other members are redirected to matchmaking. The page is marked `noindex` and is not included in public navigation.

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

- Members are 18 or older and choose one or more connection types: romance, friends, and business partners. Signup and editing use the same three steps: shared personal details, shared books, then the questions for every selected type. Each selected type's required answers are enforced in the form and database; questions marked optional remain optional.
- Romance uses Woman, Man, or Other for gender and the people they want to meet, a slider from 18 to 80+, and an optional private ideal-match answer (up to 600 characters). The 80+ maximum is stored as 120 (the platform's oldest permitted age), so it includes every older member. Migration `20261021000400` maps earlier gender choices to Other and preserves retired self-descriptions privately without allowing new client writes.
- Business profiles can include an optional LinkedIn personal or company page. Links are stored as canonical HTTPS URLs and shown only to their owner and released business matches. Saving after deselecting a type clears its current answers, including the LinkedIn link when removing business partners. Answers for retained types stay in place.
- Migration `20261022000000` backfills each existing choice into the owner-only `intents` array without changing answers, edit clocks, or favorite selection dates. Use this array for eligibility. The scalar profile `intent` is retained for older clients: legacy inserts and explicit single-type changes still work, and resubmitting an unchanged scalar does not collapse multiple selections. Older forms cannot save a multi-type profile if they clear answers that are still required; reload the updated site to edit those profiles.
- An introduction still has one specific `intent`, shared by both active members. Released introductions show only the answers for that type, and never expose another member's full selection of connection types. The one-introduction-per-member-per-week limit applies across all types. Multiple selections do not multiply member totals or book votes.
- Members select a city from the catalog. The community map returns anonymous city totals and city-center coordinates, with no names or profile links. The total counts completed member profiles, including paused members. Deleting a profile removes it from future totals.
- Each profile has one required favorite and up to two additional favorites. Book selection uses an Open Library **work ID**, so editions of the same work group together. Catalog duplicates can still exist upstream; a future alias table can merge those if needed.
- Members can optionally select one **Currently reading** book in the same books step. It uses the same catalog autocomplete. Adding, replacing, or clearing a current read is limited to once every rolling 24 hours, independently from the favorites limit. Migration `20261023000100` adds the catalog ID and canonical title/author without changing existing profiles' timestamps. A current read can also be a favorite; it does not add a favorite vote, change recent-favorite dates, or reset the 24-hour favorites clock. It appears on the member's profile, in released introductions, and in the protected admin directory, where its title and author are searchable. Blank selections stay hidden; a cleared selection still retains its edit timer. Migration `20261023000200` adds the server-owned `current_book_updated_at` clock. Signup with a current read starts this clock; skipping it allows a first selection later. Existing selections from before this limit may be changed once before their clock starts, because no earlier current-read timestamps were recorded. Unchanged reads and other profile edits never reset either clock. Existing profile RLS and introduction access checks still apply.
- The database resolves book titles/authors and city labels from their catalog IDs. Clients cannot insert arbitrary books or locations into the catalogs.
- Favorite book IDs can change once every rolling 24 hours, starting at profile creation or the last actual book change. Other preferences remain editable. The database enforces the interval using its own clock; sign-out, another browser, or a direct API request does not reset it.
- The book-explanation question is retired. Migration `20261021000300` allows new profiles without it, prevents client writes to the legacy column, and excludes old answers from introductions. Previously submitted answers are retained privately with their owner's account rather than deleted by the migration.
- The top ten counts each saved favorite once per member, with equal weight for all three positions. Counts are labeled **favorite/favorites**. Ties are sorted by title and work ID. It shows fewer than ten entries until enough distinct books have been selected.
- Rising favorites ranks current selections added in the preceding seven days, counting each member once per book. A shared snapshot refreshes on the first dashboard request after 48 hours; ties use title and work ID. The dashboard takes the first two candidates outside the **current** Top Ten, skipping books no longer on any bookshelf. It shows fewer than two if there are not enough eligible books.
- Migration `20261021000500` tracks addition dates privately for each current favorite. Reordering favorites, keeping a book while replacing another, and editing other profile fields do not change its date. Removing and re-adding a book starts a new selection, with at most one vote per member. Deleting an account cascades its selections. Historical per-book dates were not recorded: the migration conservatively seeds existing selections with profile creation dates, so older accounts' recent changes may initially be undercounted. All additions after migration use the server's exact date.
- Top Ten reuses covers and Amazon affiliate links from `reviews.csv`, `book_club_current.csv`, and the review-cover manifest. Matching uses work IDs or an unambiguous title-and-author pair; `matchmaking/src/review-catalog.js` also records known original-language work aliases. These presentation aliases do not merge ranking totals. Books without review assets use Open Library covers and a regular Amazon title-and-author search link. Missing covers display a small book placeholder.
- Add curated Top Ten links and covers to `matchmaking/books.csv`, keyed by Open Library work ID. It can add unreviewed books or fill in missing links for reviewed books. Store new covers under `assets/matchmaking-covers/` and record the edition ISBN and source URL in the CSV. Existing Amazon URLs are preserved, including `amzn.to` and `link.amazon` short links; a blank cover field retains any matching review cover.
- Profiles are readable only by their owners. A separate function exposes limited details of explicitly released matches to their two participants. Birthdays, emails, gender preferences, ideal-match answers, and account IDs are not returned in introductions.
- The account-deletion function deletes only the authenticated user's Supabase Auth account. Foreign-key cascades remove their profile and match memberships.

## Book search and geography

Book autocomplete calls the authenticated `search-books` function. It uses [Open Library's Search API](https://openlibrary.org/dev/docs/api/search) for human searches, caches results for 24 hours, and stores canonical work records in Supabase. A shared database throttle limits upstream requests to less than three per second across all function instances. The function identifies Zebra Book Club with its public contact email. This follows [Open Library's API guidelines](https://openlibrary.org/developers/api); large-scale catalog ingestion should use their data dumps instead.

The same function accepts an exact `work_id` for cover lookup and caches the returned cover ID. The browser queues those lookups and loads images from the [Open Library Covers API](https://openlibrary.org/dev/docs/api/covers). Deploy `search-books` together with the updated browser bundle when changing this response format; no database migration is needed for cover IDs in the JSON search cache.

The city catalog contains 34,174 records from the [GeoNames cities15000 extract](https://download.geonames.org/export/dump/), downloaded October 21, 2026, plus region names from `admin1CodesASCII.txt`. GeoNames is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Records were transformed into SQL and country names localized into English. Members in smaller towns can choose a nearby city.

The world outline uses [Natural Earth 1:110m countries](https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/), a public-domain dataset. Country geometry comes from the [Natural Earth source repository](https://github.com/nvkelso/natural-earth-vector). Both outlines and dots use D3's Natural Earth projection. `scripts/build-matchmaking-geography.mjs` records the transformation; do not regenerate its migration after deployment. Source credits also appear in the site footer.

The community map zooms from 1× to 8× with shared transforms for the outline and city dots. Desktop has a compact +/− control at the map's top right, mouse dragging, trackpad pinch, and Ctrl+scroll. Touchscreens get larger controls and a reset button; two fingers pinch and pan while one finger retains normal page scrolling. No gesture instructions appear on either layout. Keyboard users can focus the map and use +/−, arrow keys, and 0/Home/Escape to reset. Zoom stays local to the page and resets on sign-out; it requests no additional location data.

## Next stage

The current release supports login, profiles, the member dashboard, and displaying released matches. **No weekly scheduler or match emails are running yet.** Next, implement mutual compatibility rules and pair generation using the intersection of both members' `intents`, then add the weekly job and an email provider. Respect `is_active` and `email_matches`, prevent repeat pairings, and choose how matched people consent to exchanging contact details. No member email address is currently exposed to another member.

The initial test suite covers form flows, failed saves, canonical book handling, the 24-hour interval, deletion authentication, database ownership, anonymous aggregates, match release rules, and cascade deletion. It uses in-memory Postgres (PGlite) and a DOM environment; the final Google OAuth round trip also needs a real enabled Google provider and test account.
