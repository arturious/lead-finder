// HTML parsers for Myfxbook pages. The shapes follow contest_leads.py,
// live_leads.py, and the extension's profile field / bio extraction.

const { extractContacts, decodeCfEmail } = require("./contacts");

const RESERVED = new Set([
  "edit-profile", "settings", "logout", "login", "register", "messages",
  "notifications", "my-portfolio", "user-agreement", "contests", "custom-search",
  "community", "systems", "reviews", "forex-brokers", "forex-charts", "economic-calendar",
  "forex-news", "help", "about", "contact", "privacy-policy", "widgets", "mobile", "api",
  "members"
]);

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function stripTags(html) {
  return decodeEntities(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function validUser(name) {
  return /^[A-Za-z0-9_.-]{2,32}$/.test(name || "") && !RESERVED.has(name.toLowerCase());
}

function countryMatches(location, target) {
  const t = String(target || "").trim().toLowerCase();
  if (!t) return false;
  const loc = String(location || "").trim().toLowerCase();
  if (!loc || loc === "не указано" || loc === "unknown" || loc === "n/a") return false;
  const parts = [loc, ...loc.split(",").map((s) => s.trim())];
  return parts.includes(t);
}

function parseTotal(html) {
  const text = String(html || "");
  const m = text.match(/id="totalResultsCount"[^>]*value="(\d+)"/i)
    || text.match(/value="(\d+)"[^>]*id="totalResultsCount"/i);
  return m ? Number(m[1]) : 0;
}

function parseContestIds(html) {
  const ids = new Set();
  const re = /\/contests\/(?:[a-z0-9-]*-)?(\d+)\b/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const id = Number(m[1]);
    if (id >= 1 && id < 500) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

function parseLiveContestId(html, ids) {
  const text = String(html || "");
  const linkRe = /\/contests\/(?:[a-z0-9-]*-)?(\d+)\b/gi;
  let best = null;
  let m;
  while ((m = linkRe.exec(text))) {
    const start = Math.max(0, m.index - 400);
    const around = text.slice(start, m.index + 400);
    if (/\b(live|ongoing|in progress|current)\b/i.test(around)) best = Number(m[1]);
  }
  if (best) return best;
  return ids && ids.length ? ids[ids.length - 1] : null;
}

function parseContestRows(html) {
  const rows = [];
  const rowRe = /<tr class="contests-page[^"]*">([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(String(html || "")))) {
    const tr = row[1];
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let td;
    while ((td = tdRe.exec(tr))) tds.push(td[1]);
    const user = tr.match(/href="(?:https:\/\/www\.myfxbook\.com)?\/members\/([^"/]+)\/[^"]+\/(\d+)"/i);
    if (!user || !validUser(user[1])) continue;
    const flag = tr.match(/flag-icon-[a-z]{2}[^>]*title="([^"]+)"/i)
      || tr.match(/title="([^"]+)"[^>]*flag-icon-[a-z]{2}/i);
    const lastTd = tds.length ? tds[tds.length - 1] : "";
    const lastTitle = lastTd.match(/title="([^"]+)"/);
    const country = (flag && flag[1]) || (lastTitle && lastTitle[1]) || "";
    const text = tds.map(stripTags);
    const system = tr.match(/href="((?:https:\/\/www\.myfxbook\.com)?\/members\/[^"]+\/\d+)"/i);
    rows.push({
      username: user[1],
      country: decodeEntities(country).trim(),
      systemUrl: system ? system[1] : "",
      equity: text[3] || "",
      gain: text[4] || "",
      drawdown: text[5] || "",
      pips: text[6] || "",
      trades: text[7] || "",
      trading: text[8] || "",
      online: /onlineModern/.test(tr)
    });
  }
  return rows;
}

function parseForumItems(html) {
  const out = [];
  const seen = new Set();
  for (const part of String(html || "").split(/<tr/i).slice(1)) {
    const user = part.match(/\/members\/([A-Za-z0-9_.-]+)/);
    if (!user || !validUser(user[1])) continue;
    const key = user[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const text = stripTags(part);
    const when = text.match(/(\d+\s+\w+\s+ago|[A-Z][a-z]{2} \d{2}(?:, \d{4})? at)/);
    out.push({ username: user[1], recency: when ? when[1] : "" });
  }
  return out;
}

function parseSystemsUsernames(html) {
  const out = [];
  const seen = new Set();
  const re = /href="(?:https:\/\/www\.myfxbook\.com)?\/members\/([A-Za-z0-9_.-]+)"/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    if (!validUser(m[1])) continue;
    const key = m[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m[1]);
  }
  return out;
}

function fieldValue(html, label) {
  const re = new RegExp(
    `detail-title">\\s*${label}:?\\s*</span>\\s*<span[^>]*>([^<]+)`,
    "i"
  );
  const m = String(html || "").match(re);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

function extractBio(html) {
  const m = String(html || "").match(
    /profile-info-section-header[^>]*>\s*Bio\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/i
  );
  if (!m) return "";
  let chunk = m[1];
  // Cloudflare hides the address in an attribute; the visible text stays "[email protected]".
  chunk = chunk.replace(/<[^>]*data-cfemail="([0-9a-fA-F]+)"[^>]*>[\s\S]*?<\/[^>]+>/gi, (_, hex) => decodeCfEmail(hex));
  chunk = chunk.replace(/<a[^>]*email-protection#([0-9a-fA-F]+)[^>]*>[\s\S]*?<\/a>/gi, (_, hex) => decodeCfEmail(hex));
  const links = [...chunk.matchAll(/href="(https?:\/\/[^"]+)"/gi)]
    .map((x) => x[1])
    .filter((href) => !href.includes("/cdn-cgi/"));
  const text = decodeEntities(
    chunk
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );
  return [text, ...links]
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function parseProfile(html) {
  const bio = extractBio(html);
  const online = /class="online-indicator\s*"/.test(html || "")
    || /class="online-indicator"/.test(html || "");
  return {
    location: fieldValue(html, "Location"),
    joined: fieldValue(html, "Joined"),
    experience: fieldValue(html, "Experience"),
    online,
    bio,
    contacts: extractContacts(bio)
  };
}

function agoDays(txt, now = Date.now()) {
  const m = String(txt || "").match(/(\d+)\s+(minute|hour|day|week|month|year)/i);
  if (m) {
    const n = Number(m[1]);
    const factor = { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 };
    return n * factor[m[2].toLowerCase()];
  }
  const d = String(txt || "").match(/([A-Z][a-z]{2} \d{2})(?:, (\d{4}))? at/);
  if (!d) return null;
  const year = d[2] || new Date(now).getUTCFullYear();
  const t = Date.parse(`${d[1]} ${year} UTC`);
  if (Number.isNaN(t)) return null;
  return (now - t) / 86400000;
}

function isChallengeHtml(html, title) {
  const blob = `${title || ""}\n${html || ""}`;
  if (/you have been blocked/i.test(blob)) return false;
  if (/just a moment/i.test(blob) && /cloudflare|challenge-platform|cf-challenge|turnstile/i.test(blob)) return true;
  if (/just a moment/i.test(title || "")) return true;
  return /challenge-platform|cf-turnstile|cf-challenge-running|Attention Required! \| Cloudflare/i.test(html || "");
}

function isHardBlockHtml(html) {
  const text = html || "";
  return /you have been blocked/i.test(text) || /error code:\s*10(20|15|06)/i.test(text);
}

// Pages of a contest are sorted by country A→Z (sb=45). Returns the first page
// whose last country is >= target. `getRows(page)` may be called more than once;
// results are cached.
async function findCountryStart({ pages, target, getRows }) {
  const cache = new Map();
  const t = String(target || "").toLowerCase();
  async function rows(p) {
    if (!cache.has(p)) cache.set(p, await getRows(p));
    return cache.get(p);
  }
  let lo = 1;
  let hi = Math.max(1, pages | 0);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const list = await rows(mid);
    const last = list.length ? String(list[list.length - 1].country || "").toLowerCase() : "";
    if (list.length && last < t) lo = mid + 1;
    else hi = mid;
  }
  return { start: lo, cache };
}

module.exports = {
  RESERVED,
  countryMatches,
  parseTotal,
  parseContestIds,
  parseLiveContestId,
  parseContestRows,
  parseForumItems,
  parseSystemsUsernames,
  parseProfile,
  agoDays,
  isChallengeHtml,
  isHardBlockHtml,
  findCountryStart,
  decodeCfEmail
};
