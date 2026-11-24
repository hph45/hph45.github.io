// Check the signed-out HTML that each public page actually serves.
import { writeFile } from "node:fs/promises";
import { Window } from "happy-dom";

const origin = new URL(process.argv[2] || "https://zebrabookclub.com");
if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("Use an HTTP(S) origin without credentials.");
const pages = ["/", "/matchmaking/", "/about/", "/community-stats/", "/press/"];
const agents = ["ZebraPublicPageCheck/1.0", "OAI-SearchBot", "PerplexityBot"];
const tasks = agents.flatMap(agent => pages.map(path => ({ agent, path })));
tasks.push({ agent: agents[0], path: "/robots.txt" }, { agent: agents[0], path: "/sitemap.xml" });
const window = new Window();
const parser = new window.DOMParser();

function inspectPage(path, html, headers) {
  const doc = parser.parseFromString(html, "text/html");
  const robots = [...doc.querySelectorAll('meta[name="robots" i], meta[name="googlebot" i], meta[name="bingbot" i]')].map(meta => meta.content);
  const noindex = /\b(?:noindex|none)\b/i.test([headers.get("x-robots-tag"), ...robots].join(" "));
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const guestLinks = [...doc.querySelectorAll('a[href="/community-stats/"]')];
  let content;
  switch (path) {
    case "/":
      content = doc.title === "Zebra Book Club" && doc.querySelector('a[href="/matchmaking/"]');
      break;
    case "/matchmaking/":
      content = guestLinks.length === 1 && guestLinks[0].closest("#welcome-view") && /book-based matchmaking/i.test(doc.title);
      break;
    case "/community-stats/": {
      const totals = [...doc.querySelectorAll(".totals dd")];
      content = totals.length === 3 && totals.every(el => /^\d[\d,]*$/.test(el.textContent.trim())) && doc.querySelector("main time[datetime]");
      break;
    }
    case "/press/":
      content = /\d[\d,]* active accounts/i.test(doc.body.textContent) && doc.querySelector("main time[datetime]");
      break;
    case "/about/":
      content = /favorite books/i.test(doc.body.textContent) && doc.querySelector('script[type="application/ld+json"]');
      break;
  }
  const expectedCanonical = path === "/" || canonical === `https://zebrabookclub.com${path}`;
  const guestEntry = path === "/matchmaking/" || guestLinks.length === 0;
  return { title: doc.title, canonical, noindex, pass: Boolean(content && expectedCanonical && guestEntry && !noindex) };
}

const results = await Promise.all(tasks.map(async ({ agent, path }) => {
  try {
    const response = await fetch(new URL(path, origin), { headers: { "User-Agent": agent }, signal: AbortSignal.timeout(20_000) });
    const body = await response.text();
    let checks;
    if (pages.includes(path)) checks = inspectPage(path, body, response.headers);
    else if (path === "/robots.txt") checks = { pass: body.includes("Sitemap: https://zebrabookclub.com/sitemap.xml") };
    else checks = { pass: body.includes("<urlset ") };
    return { path, agent, status: response.status, final_url: response.url, ...checks, pass: checks.pass && response.status === 200 };
  } catch (error) { return { path, agent, pass: false, error: error.message }; }
}));
await window.close();
const report = { checked_at: new Date().toISOString(), origin: origin.origin, note: "Client user-agent checks do not verify crawler IPs or indexing.", results };
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2) + "\n");
for (const result of results) console.log(`${result.pass ? "PASS" : "CHECK"} ${result.status || "ERROR"} ${result.agent} ${result.path}`);
if (results.some(result => !result.pass)) process.exitCode = 1;
