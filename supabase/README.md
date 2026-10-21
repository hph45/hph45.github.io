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

- Members are 18 or older and choose one current intent: romance, friends, or business partners.
- Romance uses Woman, Man, or Other for gender and the people they want to meet, a slider from 18 to 80+, and an optional private ideal-match answer (up to 600 characters). The 80+ maximum is stored as 120 (the platform's oldest permitted age), so it includes every older member. Migration `20261021000400` maps earlier gender choices to Other and preserves retired self-descriptions privately without allowing new client writes.
- Business profiles can include an optional LinkedIn personal or company page. Links are stored as canonical HTTPS URLs and shown only to their owner and released business matches. Changing connection type clears the current type-specific answers and LinkedIn link.
- Members select a city from the catalog. The community map returns anonymous city totals and city-center coordinates, with no names or profile links. The total counts completed member profiles, including paused members. Deleting a profile removes it from future totals.
- Each profile has one required favorite and up to two additional favorites. Book selection uses an Open Library **work ID**, so editions of the same work group together. Catalog duplicates can still exist upstream; a future alias table can merge those if needed.
- The database resolves book titles/authors and city labels from their catalog IDs. Clients cannot insert arbitrary books or locations into the catalogs.
- Book IDs can change once every rolling 24 hours, starting at profile creation or the last actual book change. Other preferences remain editable. The database enforces the interval using its own clock; sign-out, another browser, or a direct API request does not reset it.
- The book-explanation question is retired. Migration `20261021000300` allows new profiles without it, prevents client writes to the legacy column, and excludes old answers from introductions. Previously submitted answers are retained privately with their owner's account rather than deleted by the migration.
- The top ten counts each saved favorite once per member, with equal weight for all three positions. Ties are sorted by title and work ID. It shows fewer than ten entries until enough distinct books have been selected.
- Top Ten reuses covers and Amazon affiliate links from `reviews.csv`, `book_club_current.csv`, and the review-cover manifest. Matching uses work IDs or an unambiguous title-and-author pair; `matchmaking/src/review-catalog.js` also records known original-language work aliases. These presentation aliases do not merge ranking totals. Books without review assets use Open Library covers and a regular Amazon title-and-author search link. Missing covers display a small book placeholder.
- Profiles are readable only by their owners. A separate function exposes limited details of explicitly released matches to their two participants. Birthdays, emails, gender preferences, ideal-match answers, and account IDs are not returned in introductions.
- The account-deletion function deletes only the authenticated user's Supabase Auth account. Foreign-key cascades remove their profile and match memberships.

## Book search and geography

Book autocomplete calls the authenticated `search-books` function. It uses [Open Library's Search API](https://openlibrary.org/dev/docs/api/search) for human searches, caches results for 24 hours, and stores canonical work records in Supabase. A shared database throttle limits upstream requests to less than three per second across all function instances. The function identifies Zebra Book Club with its public contact email. This follows [Open Library's API guidelines](https://openlibrary.org/developers/api); large-scale catalog ingestion should use their data dumps instead.

The same function accepts an exact `work_id` for cover lookup and caches the returned cover ID. The browser queues those lookups and loads images from the [Open Library Covers API](https://openlibrary.org/dev/docs/api/covers). Deploy `search-books` together with the updated browser bundle when changing this response format; no database migration is needed for cover IDs in the JSON search cache.

The city catalog contains 34,174 records from the [GeoNames cities15000 extract](https://download.geonames.org/export/dump/), downloaded October 21, 2026, plus region names from `admin1CodesASCII.txt`. GeoNames is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Records were transformed into SQL and country names localized into English. Members in smaller towns can choose a nearby city.

The world outline uses [Natural Earth 1:110m countries](https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/), a public-domain dataset. Country geometry comes from the [Natural Earth source repository](https://github.com/nvkelso/natural-earth-vector). Both outlines and dots use D3's Natural Earth projection. `scripts/build-matchmaking-geography.mjs` records the transformation; do not regenerate its migration after deployment. Source credits also appear in the site footer.

## Next stage

The current release supports login, profiles, the member dashboard, and displaying released matches. **No weekly scheduler or match emails are running yet.** Next, implement mutual compatibility rules and pair generation, then add the weekly job and an email provider. Respect `is_active` and `email_matches`, prevent repeat pairings, and choose how matched people consent to exchanging contact details. No member email address is currently exposed to another member.

The initial test suite covers form flows, failed saves, canonical book handling, the 24-hour interval, deletion authentication, database ownership, anonymous aggregates, match release rules, and cascade deletion. It uses in-memory Postgres (PGlite) and a DOM environment; the final Google OAuth round trip also needs a real enabled Google provider and test account.
