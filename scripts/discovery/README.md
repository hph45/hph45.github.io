# Discovery maintenance

Prepared November 22, 2026. Website changes are local and unpublished. No outreach,
search-engine submissions, or scheduled assistant runs have been made.

## Refresh the community figures

Active accounts are completed profiles with matching enabled. Countries and
territories are distinct entries in the city catalog for completed profiles,
including paused profiles. Both exclude deleted, banned, anonymous, and designated
review accounts. A released introduction counts once across all rounds, even
after a participant leaves. Drafts, future releases, and pairs involving review
accounts are excluded. The visible date uses Pacific time.

Run weekly, or before citing the figure in a pitch, from an authorized checkout:

```sh
npm run supabase -- db query --linked --file scripts/community-stats.sql --output json > /private/tmp/zbc-community-aggregate.json
npm run refresh:stats -- /private/tmp/zbc-community-aggregate.json
npm run test:home
git diff -- community-stats press assets/community-stats.json assets/community-readers-map.svg sitemap.xml
```

The SQL is read-only. Its output contains the timestamp, method version, three
figures, and the represented regions. The map uses the club's Natural Earth
outlines. Small regions use a marker at their largest GeoNames catalog city.
The refresh script strips unexpected fields, requires a snapshot from the last
24 hours, rejects older replacements, and updates the HTML and JSON together.
Review and publish through the normal repository workflow. The hourly public-map
job does not update this separate statistic. No database credential is added to
the public site or CI.

## Crawl audit

```sh
node scripts/audit-discovery.mjs https://zebrabookclub.com /private/tmp/zbc-discovery-audit.json
```

The November 22 live check returned 200 for `/` and `/matchmaking/`, without
noindex headers or login redirects, for a normal client, OAI-SearchBot, and
PerplexityBot user-agent strings. Both pages lacked the new static membership
evidence and canonical tags. `/about/`, `/community-stats/`, `/press/`,
`/robots.txt`, and `/sitemap.xml` returned 404 because these changes are not yet
published. The staged preview passed all 17 raw-HTTP checks.

Responses identify GitHub Pages. User-agent checks do not prove access from a
crawler's actual IP, establish firewall settings, or prove indexing. No hosting
or firewall settings were changed. After publication, use the search engines'
own fetch tools below. If a firewall is introduced, verify requests against the
providers' published crawler IP ranges instead of trusting a user-agent string.

`robots.txt` explicitly permits OAI-SearchBot and PerplexityBot and preserves the
previous default access for other crawlers. OAI-SearchBot search access and
GPTBot training access are separate controls. See [OpenAI's bot documentation](https://developers.openai.com/api/docs/bots)
and [Perplexity's crawler documentation](https://docs.perplexity.ai/docs/resources/perplexity-crawlers).

## After the owner publishes

1. Run the HTTP audit again. Follow **Our community** from the signed-out
   matchmaking welcome page and check the three figures in page source. A
   signed-in browser opening the URL returns to matchmaking. Check the public
   screenshot in the press pack as well.
2. Verify the `zebrabookclub.com` property in Google Search Console and Bing
   Webmaster Tools using the owner's existing account. No verification token
   has been supplied or added to this repository.
3. Submit `https://zebrabookclub.com/sitemap.xml` in each service. Inspect `/`,
   `/matchmaking/`, `/about/`, and `/community-stats/` with their live fetch tools.
   Confirm that the matchmaking description and dated community figures are visible on their respective pages,
   then request indexing. Record the fetch date and indexed canonical URL.
4. Keep `lastmod` tied to real content edits. The statistics refresh script
   updates dates only for pages whose content changes; hourly builds do not
   advance dates. Manually update the relevant date for other content edits.
5. Review the existing App Store description and Instagram bio for consistent
   product wording and official links. The app listing already describes the
   three connection types; no external listing or social profile was edited.

References: [Google recrawl requests](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl),
[Bing sitemaps](https://www2.bing.com/webmasters/help/sitemaps-3b5cf6ed),
[Bing URL Inspection](https://www.bing.com/webmasters/help/url-inspection-55a30305).
Submission does not guarantee indexing or inclusion in an assistant's answer.

## Weekly discovery check

After publication, test the four prompts in `prompts.json` on ChatGPT Search and
Perplexity, with web search enabled. Use an isolated testing setup with no prior
Zebra context or personalization. Start a fresh conversation for each prompt.
Do not mention Zebra, supply its URLs, or correct an answer before recording it.
Run each prompt twice per service and retain every result, including misses and
failures. Keep language and location consistent across weeks.

Append one row per run to `results.csv`. Save the answer and its cited URLs
locally; record the exact service/model label, prompt, time, search setting,
personalization setting, and whether the name, category, count, and date are
correct. For count accuracy, compare against the snapshot the answer cites,
then separately note whether it is stale. An answer that calls the statistic
monthly active users is incorrect even if the number matches.

Track inclusion as mentions / successful runs for each prompt and service.
Separate search errors from misses. Review cited sources before choosing a fix:
no inclusion → crawl/index/category evidence; wrong category → product copy;
missing number → accessible statistics; old number → outdated source/recrawl.
This conversation and the HTTP audit are not independent discovery trials.

Press prospects, draft pitches, and member-story collection are in `outreach.md`.
These working files are excluded from the public Pages artifact.
