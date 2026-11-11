// Myfxbook public pages only. No login, no messages.
// Round order: live contest (target country) → recent forum → systems with a
// short lastTraded window → one slice of a historical contest. Profile pages
// are opened only for usernames that are not already in the on-disk cache.
// When every source is exhausted, sleep 5–10 minutes and start again from the newest.

const {
  countryMatches,
  parseTotal,
  parseContestIds,
  parseLiveContestId,
  parseContestRows,
  parseForumItems,
  parseSystemsRows,
  parseProfile,
  meetsExperience,
  agoDays,
  findCountryStart
} = require("../parse");
const { cooldownMs } = require("../pacing");

const BASE = "https://www.myfxbook.com";
const SYSTEMS_DAYS = 14;
const FORUM_MAX_DAYS = 30;
const CONTEST_PAGES_PER_TURN = 3;

function contestPageUrl(id, page) {
  return `${BASE}/paging.html?pt=24&p=${page}&id=${id}&size=&sb=45&st=1`;
}

function systemsPageUrl(page, days = SYSTEMS_DAYS) {
  const q = new URLSearchParams({
    pt: "6",
    p: String(page),
    profitType: "0",
    profitValue: "0.0",
    drawType: "1",
    drawValue: "100.0",
    profitabilityType: "0",
    profitabilityValue: "0.0",
    ageType: "0",
    ageValue: "30",
    tradingType: "0",
    systemType: "0",
    symbols: "",
    accountType: "2",
    size: "15",
    sb: "19",
    st: "2",
    lastTraded: String(days),
    tradesType: "0",
    pipsType: "1",
    pipsValue: "30",
    equityType: "1",
    equityValue: "30",
    serverOid: "0",
    propFirmOid: "0",
    platformOid: "0",
    regulationType: "1"
  });
  return `${BASE}/paging.html?${q}`;
}

function profileUrl(username) {
  return `${BASE}/members/${encodeURIComponent(username)}`;
}

function freshState() {
  return {
    refreshContests: true,
    liveId: null,
    liveLocated: false,
    liveDone: false,
    liveNext: 1,
    livePages: 0,
    forumPage: 1,
    forumDone: false,
    systemsPage: 1,
    systemsDone: false,
    histIds: [],
    histIndex: 0,
    histLocated: false,
    histNext: 1,
    histPages: 0
  };
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function livenessText(kind, recency, online) {
  const parts = [];
  if (online) parts.push("онлайн");
  if (kind === "forum" && recency) parts.push(`пост · ${recency}`);
  else if (kind === "systems") parts.push(`сделка · <${SYSTEMS_DAYS}д`);
  else if (kind === "contest" && !online) parts.push("конкурс");
  return parts.join(" · ") || (online ? "онлайн" : "конкурс");
}

function leadFrom(username, country, source, kind, recency, online, profile, stats) {
  const resolvedCountry = profile && countryMatches(profile.location, country) ? profile.location : country;
  const isOnline = Boolean(online || (profile && profile.online));
  return {
    username,
    profileUrl: `${BASE}/members/${username}`,
    country: resolvedCountry || country || (profile && profile.location) || "",
    source,
    liveness: livenessText(kind, recency, isOnline),
    online: isOnline,
    joined: (profile && profile.joined) || "",
    experience: (profile && profile.experience) || "",
    equity: (stats && stats.equity) || "",
    gain: (stats && stats.gain) || "",
    drawdown: (stats && stats.drawdown) || "",
    pips: (stats && stats.pips) || "",
    trades: (stats && stats.trades) || "",
    trading: (stats && stats.trading) || "",
    systemUrl: (stats && stats.systemUrl) || "",
    contacts: (profile && profile.contacts) || "",
    foundAt: stamp()
  };
}

function slotsNow(ctx) {
  if (typeof ctx.profileSlots !== "function") return 2;
  const n = Number(ctx.profileSlots());
  return n >= 1 ? n : 1;
}

// As many profile fetches as the current pace allows. The width is read
// again after each finish, so a slowdown takes effect on the next start.
function eachProfile(ctx, items, fn) {
  const list = items || [];
  let next = 0;
  let active = 0;
  let error = null;
  let settled = false;
  return new Promise((resolve, reject) => {
    const settle = () => {
      if (settled || active > 0) return;
      if (!error && !ctx.stopped() && next < list.length) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const pump = () => {
      if (settled || error) {
        settle();
        return;
      }
      if (ctx.stopped()) {
        settle();
        return;
      }
      while (active < slotsNow(ctx) && next < list.length) {
        const item = list[next++];
        active += 1;
        Promise.resolve()
          .then(() => fn(item))
          .then(() => {
            active -= 1;
            if (error || ctx.stopped() || next >= list.length) settle();
            else pump();
          }, (err) => {
            active -= 1;
            if (!error) error = err;
            settle();
          });
      }
      settle();
    };
    pump();
  });
}

function minimumOf(ctx) {
  return typeof ctx.minExperience === "function" ? ctx.minExperience() : "";
}

async function consider(ctx, item) {
  const key = item.username.toLowerCase();
  const recheck = typeof ctx.shouldRecheck === "function" && ctx.shouldRecheck(key);
  if (ctx.isChecked(key) && !recheck) {
    if (ctx.hasLead(item.username)) {
      ctx.addLead(leadFrom(
        item.username,
        item.country || ctx.country,
        item.source,
        item.kind,
        item.recency,
        item.online,
        null,
        item.stats
      ));
    }
    return;
  }

  // The list already knows this trader cannot pass. Skip the profile page.
  if (item.country && !countryMatches(item.country, ctx.country)) {
    ctx.markChecked(item.username, { country: item.country });
    return;
  }
  if (item.experience && !meetsExperience(item.experience, minimumOf(ctx))) {
    ctx.markChecked(item.username, { country: item.country || "" });
    return;
  }

  ctx.noteProfile();
  const res = await ctx.request(profileUrl(item.username));
  const profile = res.status === 200 ? parseProfile(res.text) : null;
  const location = (profile && profile.location) || item.country || "";
  const contacts = (profile && profile.contacts) || "";
  const experienced = meetsExperience(profile && profile.experience, minimumOf(ctx));
  const lead = leadFrom(item.username, location, item.source, item.kind, item.recency, item.online, profile, item.stats);

  if (item.country) {
    if (experienced) ctx.addLead(lead);
    ctx.markChecked(item.username, { country: item.country, noContacts: profile ? !contacts : false });
    return;
  }

  ctx.markChecked(item.username, { country: location, noContacts: profile ? !contacts : false });
  if (!countryMatches(location, ctx.country) || !experienced) return;
  ctx.addLead(lead);
}

async function loadContestPage(ctx, contestId, page, cache) {
  if (cache && cache.has(page)) return cache.get(page);
  const res = await ctx.request(contestPageUrl(contestId, page), { xhr: true });
  const rows = res.status === 200 ? parseContestRows(res.text) : [];
  if (cache) cache.set(page, rows);
  return rows;
}

async function locateContest(ctx, contestId, target) {
  const first = await ctx.request(contestPageUrl(contestId, 1), { xhr: true });
  const rows1 = first.status === 200 ? parseContestRows(first.text) : [];
  const total = first.status === 200 ? parseTotal(first.text) : 0;
  const pages = total > 0 ? Math.ceil(total / 20) : (rows1.length ? 1 : 0);
  if (!pages) return { start: 1, pages: 0, cache: new Map() };
  const found = await findCountryStart({
    pages,
    target,
    getRows: async (page) => {
      if (page === 1) return rows1;
      return loadContestPage(ctx, contestId, page, null);
    }
  });
  if (!found.cache.has(1)) found.cache.set(1, rows1);
  return { start: found.start, pages, cache: found.cache };
}

// Read a few pages of the country block. Non-matching usernames are cached
// without a profile request. Returns true when the block is finished.
async function readContestSlice(ctx, contestId, cursor, sourceLabel) {
  const cache = cursor.cache || new Map();
  cursor.cache = cache;
  let finished = false;
  for (let n = 0; n < CONTEST_PAGES_PER_TURN && !finished && !ctx.stopped(); n++) {
    const page = cursor.next;
    if (cursor.pages && page > cursor.pages) {
      finished = true;
      break;
    }
    ctx.setSource(`${sourceLabel}, стр. ${page}`);
    const rows = await loadContestPage(ctx, contestId, page, cache);
    await eachProfile(ctx, rows, (row) => consider(ctx, {
      username: row.username,
      country: row.country,
      experience: row.experience || "",
      source: `contest:${contestId}`,
      kind: "contest",
      recency: row.online ? "online" : "",
      online: row.online,
      stats: row
    }));
    if (ctx.stopped()) return false;
    const last = rows.length ? String(rows[rows.length - 1].country || "").toLowerCase() : "";
    const target = ctx.country.toLowerCase();
    cursor.next = page + 1;
    if (!rows.length || last !== target) finished = true;
  }
  return finished;
}

async function ensureContests(ctx, state) {
  if (ctx.stopped()) return;
  if (!state.refreshContests && state.liveId) return;
  ctx.setSource("список конкурсов");
  const res = await ctx.request(`${BASE}/contests`);
  let ids = res.status === 200 ? parseContestIds(res.text) : [];
  let live = res.status === 200 ? parseLiveContestId(res.text, ids) : null;
  if (!live) {
    for (let id = 70; id >= 40 && !ctx.stopped(); id--) {
      ctx.setSource(`конкурс ${id}?`);
      const probe = await ctx.request(contestPageUrl(id, 1), { xhr: true });
      if (probe.status === 200 && parseTotal(probe.text) > 0) {
        live = id;
        break;
      }
    }
  }
  if (!live) live = ids.length ? ids[ids.length - 1] : 51;
  if (ids.length <= 1) {
    ids = [];
    for (let id = Math.max(1, live - 60); id <= live; id++) ids.push(id);
  }
  const known = new Set([...(state.histIds || []), state.liveId].filter(Boolean));
  const extra = ids.filter((id) => id !== live && !known.has(id));
  if (state.liveId && state.liveId !== live && !(state.histIds || []).includes(state.liveId)) {
    extra.push(state.liveId);
  }
  if (!state.histIds || !state.histIds.length) {
    state.histIds = ids.filter((id) => id !== live).sort((a, b) => b - a);
    state.histIndex = 0;
  } else if (extra.length) {
    const pending = state.histIds.slice(state.histIndex);
    const done = state.histIds.slice(0, state.histIndex);
    const merged = [...new Set([...extra.sort((a, b) => b - a), ...pending])];
    state.histIds = [...done, ...merged];
  }
  if (state.liveId !== live) {
    state.liveId = live;
    state.liveLocated = false;
    state.liveDone = false;
    state.liveNext = 1;
    state.livePages = 0;
    state.liveCache = null;
  }
  state.refreshContests = false;
}

function rememberOtherCountries(ctx, cache, start) {
  if (!cache) return;
  for (const [page, rows] of cache) {
    if (page >= start) continue;
    for (const row of rows) {
      if (!ctx.isChecked(row.username)) ctx.markChecked(row.username, { country: row.country });
    }
  }
}

async function stepLive(ctx, state) {
  if (ctx.stopped() || state.liveDone) return;
  if (!state.liveLocated) {
    ctx.setSource(`конкурс ${state.liveId}`);
    const located = await locateContest(ctx, state.liveId, ctx.country);
    state.liveLocated = true;
    state.livePages = located.pages;
    state.liveNext = located.start;
    state.liveCache = located.cache;
    rememberOtherCountries(ctx, located.cache, located.start);
    if (!located.pages) {
      state.liveDone = true;
      return;
    }
  }
  const bag = { next: state.liveNext, pages: state.livePages, cache: state.liveCache };
  const done = await readContestSlice(ctx, state.liveId, bag, `конкурс ${state.liveId}`);
  state.liveNext = bag.next;
  state.liveCache = bag.cache;
  if (done) state.liveDone = true;
}

async function stepForum(ctx, state) {
  if (ctx.stopped() || state.forumDone) return;
  const page = state.forumPage;
  ctx.setSource(`форум, стр. ${page}`);
  const res = await ctx.request(`${BASE}/community/recent-topics-discussed/1,${page}`);
  const items = res.status === 200 ? parseForumItems(res.text) : [];
  const fresh = items.filter((item) => {
    const age = agoDays(item.recency);
    return !(age != null && age > FORUM_MAX_DAYS);
  });
  await eachProfile(ctx, fresh, (item) => consider(ctx, {
    username: item.username,
    country: item.country || null,
    experience: item.experience || "",
    source: "forum",
    kind: "forum",
    recency: item.recency,
    online: false,
    stats: null
  }));
  if (ctx.stopped()) return;
  const lastAge = items.length ? agoDays(items[items.length - 1].recency) : null;
  if (!items.length || (lastAge != null && lastAge > FORUM_MAX_DAYS)) state.forumDone = true;
  else state.forumPage = page + 1;
}

async function stepSystems(ctx, state) {
  if (ctx.stopped() || state.systemsDone) return;
  const page = state.systemsPage;
  ctx.setSource(`системы, стр. ${page}`);
  const res = await ctx.request(systemsPageUrl(page), { xhr: true });
  const rows = res.status === 200 ? parseSystemsRows(res.text) : [];
  if (!rows.length) {
    state.systemsDone = true;
    return;
  }
  await eachProfile(ctx, rows, (row) => consider(ctx, {
    username: row.username,
    country: row.country || null,
    experience: row.experience || "",
    source: "systems",
    kind: "systems",
    recency: `traded<${SYSTEMS_DAYS}d`,
    online: false,
    stats: null
  }));
  if (ctx.stopped()) return;
  state.systemsPage = page + 1;
}

async function stepHistorical(ctx, state) {
  if (ctx.stopped() || state.histIndex >= state.histIds.length) return;
  const contestId = state.histIds[state.histIndex];
  if (!state.histLocated) {
    ctx.setSource(`конкурс ${contestId} (архив)`);
    const located = await locateContest(ctx, contestId, ctx.country);
    state.histLocated = true;
    state.histPages = located.pages;
    state.histNext = located.start;
    state.histCache = located.cache;
    rememberOtherCountries(ctx, located.cache, located.start);
    if (!located.pages) {
      state.histIndex += 1;
      state.histLocated = false;
      state.histCache = null;
      return;
    }
  }
  const bag = { next: state.histNext, pages: state.histPages, cache: state.histCache };
  const done = await readContestSlice(ctx, contestId, bag, `конкурс ${contestId} (архив)`);
  state.histNext = bag.next;
  state.histCache = bag.cache;
  if (done) {
    state.histIndex += 1;
    state.histLocated = false;
    state.histNext = 1;
    state.histPages = 0;
    state.histCache = null;
  }
}

function persistable(state) {
  return {
    refreshContests: state.refreshContests,
    liveId: state.liveId,
    liveLocated: state.liveLocated,
    liveDone: state.liveDone,
    liveNext: state.liveNext,
    livePages: state.livePages,
    forumPage: state.forumPage,
    forumDone: state.forumDone,
    systemsPage: state.systemsPage,
    systemsDone: state.systemsDone,
    histIds: state.histIds,
    histIndex: state.histIndex,
    histLocated: state.histLocated,
    histNext: state.histNext,
    histPages: state.histPages
  };
}

function exhausted(state) {
  return state.liveDone
    && state.forumDone
    && state.systemsDone
    && state.histIndex >= state.histIds.length;
}

async function run(ctx) {
  const state = { ...freshState(), ...(ctx.loadCursors() || {}) };
  state.liveCache = null;
  state.histCache = null;

  while (!ctx.stopped()) {
    await ensureContests(ctx, state);
    if (ctx.stopped()) break;
    await stepLive(ctx, state);
    ctx.saveCursors(persistable(state));
    if (ctx.stopped()) break;
    await stepForum(ctx, state);
    ctx.saveCursors(persistable(state));
    if (ctx.stopped()) break;
    await stepSystems(ctx, state);
    ctx.saveCursors(persistable(state));
    if (ctx.stopped()) break;
    await stepHistorical(ctx, state);
    ctx.saveCursors(persistable(state));
    if (ctx.stopped()) break;

    if (exhausted(state)) {
      const wait = cooldownMs();
      const minutes = Math.max(1, Math.round(wait / 60000));
      ctx.setSource("пауза");
      ctx.setPhase("cooldown", `Источники пройдены. Следующий круг через ~${minutes} мин`);
      await ctx.sleep(wait);
      state.liveLocated = false;
      state.liveDone = false;
      state.liveCache = null;
      state.forumPage = 1;
      state.forumDone = false;
      state.systemsPage = 1;
      state.systemsDone = false;
      state.refreshContests = true;
      ctx.saveCursors(persistable(state));
    }
  }
}

module.exports = {
  id: "myfxbook",
  label: "Myfxbook",
  entryUrl: `${BASE}/contests`,
  run,
  eachProfile,
  contestPageUrl,
  systemsPageUrl,
  findCountryStart,
  SYSTEMS_DAYS,
  FORUM_MAX_DAYS,
  BASE
};
