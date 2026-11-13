const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseContestRows,
  parseForumItems,
  parseSystemsUsernames,
  parseSystemsRows,
  parseProfile,
  parseTotal,
  parseContestIds,
  parseLiveContestId,
  agoDays,
  countryMatches,
  findCountryStart,
  isChallengeHtml,
  isHardBlockHtml,
  decodeCfEmail,
  meetsExperience
} = require("../src/parse");
const { contestPageUrl, systemsPageUrl, SYSTEMS_DAYS, run, eachProfile } = require("../src/sources/myfxbook");
const { leadsToCsv, leadsToXlsx } = require("../src/export");
const {
  createPace,
  paceDelayMs,
  paceOnSuccess,
  paceOnLimit,
  paceKind,
  isPressureStatus,
  backoffMinutes,
  cooldownMs,
  GAP_FLOOR_MS,
  GAP_START_MS
} = require("../src/pacing");
const { createStore } = require("../src/store");
const fs = require("fs");
const os = require("os");
const path = require("path");

function encodeCf(email) {
  const key = 0x42;
  let hex = key.toString(16).padStart(2, "0");
  for (const ch of email) hex += (ch.charCodeAt(0) ^ key).toString(16).padStart(2, "0");
  return hex;
}

test("contest rows carry country, stats and the online flag", () => {
  const html = `
    <input id="totalResultsCount" value="40" />
    <tr class="contests-page even">
      <td>1</td><td>rank</td><td>name</td>
      <td>$640.300</td><td>12%</td><td>41.89%</td><td>-30.0</td><td>6</td><td>Manual</td>
      <td><a href="https://www.myfxbook.com/members/save2009/save/27059">save</a></td>
      <td><span class="flag-icon-th" title="Thailand"></span><i class="onlineModern"></i></td>
    </tr>
    <tr class="contests-page odd">
      <td>2</td><td></td><td></td>
      <td>$10</td><td>1%</td><td>2%</td><td>3</td><td>4</td><td>Automated</td>
      <td><a href="/members/othertrader/sys/9">x</a></td>
      <td><span class="flag-icon-de" title="Germany"></span><i class="offlineModern"></i></td>
    </tr>`;
  assert.equal(parseTotal(html), 40);
  const rows = parseContestRows(html);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    username: "save2009",
    country: "Thailand",
    systemUrl: "https://www.myfxbook.com/members/save2009/save/27059",
    equity: "$640.300",
    gain: "12%",
    drawdown: "41.89%",
    pips: "-30.0",
    trades: "6",
    trading: "Manual",
    online: true,
    experience: ""
  });
  assert.equal(rows[1].online, false);
  assert.equal(rows[1].country, "Germany");
});

test("binary search lands on the target country block", async () => {
  const pages = [
    [{ country: "Argentina" }, { country: "Belgium" }],
    [{ country: "Canada" }, { country: "Germany" }],
    [{ country: "Spain" }, { country: "Thailand" }],
    [{ country: "Thailand" }, { country: "Vietnam" }],
    [{ country: "Zambia" }, { country: "Zimbabwe" }]
  ];
  const seen = [];
  const found = await findCountryStart({
    pages: pages.length,
    target: "Thailand",
    getRows: async (page) => {
      seen.push(page);
      return pages[page - 1];
    }
  });
  assert.equal(found.start, 3);
  assert.ok(seen.length < pages.length);
});

test("forum items keep the post time and skip reserved paths", () => {
  const html = "<table><tr><td><a href=\"/members/getting\">getting</a> said 2 hours ago</td></tr>"
    + "<tr><td><a href=\"/members/login\">nope</a></td></tr></table>";
  const items = parseForumItems(html);
  assert.deepEqual(items, [{ username: "getting", recency: "2 hours ago", country: "", experience: "" }]);
  assert.ok(agoDays("2 hours ago") < 1);
  assert.equal(agoDays("40 days ago") > 30, true);
  assert.equal(agoDays(""), null);
});

test("systems links and paging urls", () => {
  const users = parseSystemsUsernames(
    '<a href="https://www.myfxbook.com/members/alpha">a</a><a href="/members/alpha">dup</a><a href="/members/systems">no</a>'
  );
  assert.deepEqual(users, ["alpha"]);
  const rows = parseSystemsRows(
    '<tr><td><a href="/members/alpha/sys/1">a</a></td><td><span class="flag-icon-de" title="Germany"></span> Less than a year</td></tr>'
  );
  assert.equal(rows[0].country, "Germany");
  assert.match(rows[0].experience, /less than a year/i);
  assert.match(contestPageUrl(51, 2), /pt=24&p=2&id=51&size=&sb=45&st=1/);
  const systems = systemsPageUrl(3);
  assert.match(systems, /pt=6/);
  assert.match(systems, /lastTraded=14/);
  assert.match(systems, /[?&]p=3(?:&|$)/);
  assert.equal(SYSTEMS_DAYS, 14);
});

test("profile fields, online flag, bio contacts and cloudflare email", () => {
  const hex = encodeCf("test@example.com");
  const html = `
    <span class="online-indicator"></span>
    <span class="detail-title">Joined:</span> <span class="actual-detail-data">Jan 01, 2020</span>
    <span class="detail-title">Experience:</span> <span class="actual-detail-data">More than 5 years</span>
    <span class="detail-title">Location:</span> <span class="actual-detail-data">Bangkok, Thailand</span>
    <div class="profile-info-section-header">Bio</div>
    <div>Telegram: @trader_test<br><a class="__cf_email__" data-cfemail="${hex}">[email protected]</a></div>`;
  const profile = parseProfile(html);
  assert.equal(profile.location, "Bangkok, Thailand");
  assert.equal(profile.joined, "Jan 01, 2020");
  assert.equal(profile.experience, "More than 5 years");
  assert.equal(profile.online, true);
  assert.match(profile.contacts, /Telegram: @trader_test/);
  assert.match(profile.contacts, /test@example.com/);
  assert.equal(decodeCfEmail(hex), "test@example.com");
  assert.equal(parseProfile('<span class="online-indicator hidden"></span>').online, false);
});

test("country match is exact on a location part", () => {
  assert.equal(countryMatches("Bangkok, Thailand", "Thailand"), true);
  assert.equal(countryMatches("Nigeria", "Niger"), false);
  assert.equal(countryMatches("Thailand", "thailand"), true);
  assert.equal(countryMatches("", "Thailand"), false);
});

test("contest index and cloudflare pages", () => {
  const html = '<a href="/contests/demo-contest-48">old</a><a href="/contests/live-contest-51">Live contest</a>';
  const ids = parseContestIds(html);
  assert.deepEqual(ids, [48, 51]);
  assert.equal(parseLiveContestId(html, ids), 51);
  const listed = `
    <a href="/contests/moneta-funded/52">Moneta Funded</a> Registration Join Now
    <a href="/contests/onefunded/50">OneFunded</a> Ended
    <a href="/contests/dna-funded/49/rules">DNA Funded</a> Registration ended
    <a href="/contests/live-forex-contest-maxfx/22">Live Forex Contest MaxFX</a> Ended
    <a href="/contests/forex-contest-may-2010-fxdd/1">May 2010</a> Ended`;
  const listedIds = parseContestIds(listed);
  assert.deepEqual(listedIds, [1, 22, 49, 50, 52]);
  assert.equal(parseLiveContestId(listed, listedIds), 52);
  assert.equal(isChallengeHtml("<title>Just a moment...</title><div class=\"challenge-platform\"></div>", "Just a moment..."), true);
  assert.equal(isHardBlockHtml("<h1>Sorry, you have been blocked</h1>"), true);
  assert.equal(isChallengeHtml("<h1>Sorry, you have been blocked</h1> Just a moment challenge-platform", ""), false);
  const contests = `<html><head><title>Forex Contests</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body><h1>Live contests</h1><p>${"trader ".repeat(20)}</p></body></html>`;
  assert.equal(isChallengeHtml(contests, "Forex Contests"), false);
  assert.equal(isChallengeHtml("<html><body><div id=\"challenge-running\"></div></body></html>", ""), true);
  assert.equal(isChallengeHtml("<title>Attention Required! | Cloudflare</title><body></body>", ""), true);
});

test("pacing speeds up after a streak and only parks on repeated 429s", () => {
  const pace = createPace();
  assert.equal(pace.gapMs, GAP_START_MS);
  assert.equal(pace.slots, 2);
  assert.equal(paceDelayMs(pace, () => 0), Math.round(GAP_START_MS * 0.85));
  for (let i = 0; i < 30; i++) paceOnSuccess(pace);
  assert.equal(pace.gapMs, GAP_FLOOR_MS);
  assert.equal(pace.slots, 3);
  assert.equal(isPressureStatus(429), true);
  assert.equal(isPressureStatus(503), true);
  assert.equal(isPressureStatus(403), false);
  assert.equal(paceKind({ challenge: true, status: 403 }), "clear");
  assert.equal(paceKind({ challenge: true, status: 503 }), "clear");
  assert.equal(paceKind({ blocked: true, status: 403 }), "soft");
  assert.equal(paceKind({ blocked: true, status: 429 }), "limit");
  const once = paceOnLimit(pace, { status: 429, retryAfter: "8" });
  assert.equal(once.longBackoff, false);
  assert.equal(once.slots, 2);
  assert.equal(once.waitMs, 8000);
  assert.equal(paceOnLimit(pace, { status: 429 }).longBackoff, false);
  const third = paceOnLimit(pace, { status: 429 });
  assert.equal(third.longBackoff, true);
  assert.equal(third.slots, 1);
  assert.equal(paceOnLimit(createPace(), { status: 503 }).longBackoff, false);
  assert.equal(backoffMinutes(0), 1);
  assert.equal(backoffMinutes(1), 2);
  assert.equal(backoffMinutes(4), 16);
  assert.equal(backoffMinutes(8), 30);
  assert.ok(cooldownMs(() => 0) === 5 * 60 * 1000);
  assert.ok(cooldownMs(() => 1) === 10 * 60 * 1000);
});

test("csv and xlsx exports", () => {
  const leads = [{
    username: "save2009",
    profileUrl: "https://www.myfxbook.com/members/save2009",
    country: "Thailand",
    source: "contest:51",
    liveness: "онлайн",
    online: true,
    joined: "",
    experience: "",
    gain: "12%",
    drawdown: "4%",
    trades: "6",
    equity: "",
    pips: "",
    trading: "",
    contacts: "Telegram: @trader_test",
    foundAt: "2026-11-10 12:00"
  }];
  const csv = leadsToCsv(leads);
  assert.match(csv, /^\uFEFFUsername,Profile,/);
  assert.match(csv, /save2009,https:\/\/www\.myfxbook\.com\/members\/save2009,Thailand/);
  assert.doesNotMatch(csv, /Source|Liveness|Online/);
  const xlsx = leadsToXlsx(leads);
  assert.equal(xlsx.readUInt32LE(0), 0x04034b50);
  assert.match(xlsx.toString("utf8"), /save2009/);
});

test("resetting search memory keeps leads and settings", () => {
  const file = path.join(os.tmpdir(), `lead-finder-memory-${Date.now()}.json`);
  const store = createStore(file);
  store.markChecked("quiet", { country: "Thailand", noContacts: true });
  store.setCursors("Thailand", { forum: 3 });
  store.setCursors("Germany", { systems: 2 });
  store.upsertLead({
    username: "save2009",
    country: "Thailand",
    source: "forum",
    foundAt: "2026-11-10 12:00"
  });
  store.setProxy("socks5://127.0.0.1:1080");
  store.setLast("myfxbook", "Thailand");
  store.setMinExperience("1-3 years");
  store.clearMemory();
  assert.deepEqual(store.data.checked, {});
  assert.deepEqual(store.data.cursors, {});
  assert.equal(store.leadsFor("Thailand")[0].username, "save2009");
  assert.equal(store.data.proxy, "socks5://127.0.0.1:1080");
  assert.equal(store.data.lastCountry, "Thailand");
  assert.equal(store.data.minExperience, "1-3 years");
  const again = createStore(file);
  assert.deepEqual(again.data.checked, {});
  assert.deepEqual(again.data.cursors, {});
  assert.equal(again.data.leads.length, 1);
  fs.unlinkSync(file);
});

test("store remembers checked names and leads per country", () => {
  const file = path.join(os.tmpdir(), `lead-finder-test-${Date.now()}.json`);
  const store = createStore(file);
  store.markChecked("Other", { country: "Germany" });
  assert.equal(store.isChecked("other"), true);
  assert.equal(store.shouldRecheck("other"), false);
  const stale = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  store.markChecked("quiet", { country: "Thailand", noContacts: true, checkedAt: stale });
  assert.equal(store.shouldRecheck("quiet"), true);
  store.markChecked("quiet", { country: "Thailand", noContacts: true });
  assert.equal(store.shouldRecheck("quiet"), false);
  store.markChecked("talky", { country: "Thailand", noContacts: false, checkedAt: stale });
  assert.equal(store.shouldRecheck("talky"), false);
  assert.equal(store.upsertLead({
    username: "save2009",
    country: "Bangkok, Thailand",
    source: "forum",
    liveness: "пост · 2 hours ago",
    online: false,
    foundAt: "2026-11-10 12:00",
    gain: ""
  }), "new");
  assert.equal(store.upsertLead({
    username: "save2009",
    country: "Thailand",
    gain: "9%",
    online: true,
    liveness: "онлайн"
  }), "updated");
  const saved = store.leadsFor("Thailand");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].gain, "9%");
  assert.equal(saved[0].foundAt, "2026-11-10 12:00");
  assert.equal(saved[0].online, true);
  store.setProxy("socks5://127.0.0.1:1080");
  store.setLast("myfxbook", "Thailand");
  store.setCursors("Thailand", { forum: 3 });
  store.saveNow();
  const again = createStore(file);
  assert.equal(again.leadsFor("Thailand")[0].username, "save2009");
  again.clearFound();
  assert.equal(again.data.leads.length, 0);
  assert.deepEqual(again.data.checked, {});
  assert.deepEqual(again.data.cursors, {});
  assert.equal(again.data.proxy, "socks5://127.0.0.1:1080");
  again.setMinExperience("3-5 years");
  again.saveNow();
  assert.equal(again.data.lastCountry, "Thailand");
  assert.equal(again.data.lastSite, "myfxbook");
  assert.equal(again.isChecked("other"), false);
  const kept = createStore(file);
  assert.equal(kept.data.leads.length, 0);
  assert.equal(kept.data.proxy, "socks5://127.0.0.1:1080");
  assert.equal(kept.data.lastCountry, "Thailand");
  assert.equal(kept.data.minExperience, "3-5 years");
  assert.equal(kept.data.httpEngine, "camoufox");
  kept.data.httpEngine = "window";
  kept.saveNow();
  assert.equal(createStore(file).data.httpEngine, "window");
  kept.data.httpEngine = "impit";
  kept.saveNow();
  assert.equal(createStore(file).data.httpEngine, "impit");
  kept.data.httpEngine = "other";
  kept.saveNow();
  assert.equal(createStore(file).data.httpEngine, "camoufox");
  fs.unlinkSync(file);
});

test("experience minimum follows Myfxbook's four profile values", () => {
  assert.equal(meetsExperience("Less than a year", ""), true);
  assert.equal(meetsExperience("", "1-3 years"), false);
  assert.equal(meetsExperience("Less than a year", "1-3 years"), false);
  assert.equal(meetsExperience("Less than 1 year", "Less than a year"), true);
  assert.equal(meetsExperience("1-3 years", "1-3 years"), true);
  assert.equal(meetsExperience("3-5 years", "1-3 years"), true);
  assert.equal(meetsExperience("More than 5 years", "3-5 years"), true);
  assert.equal(meetsExperience("1-3 years", "More than 5 years"), false);
});

test("a round finishes the live contest, then archives, then forum, then systems", async () => {
  const calls = [];
  const leads = [];
  const checked = new Set();
  let stop = false;
  const ctx = {
    country: "Thailand",
    stopped: () => stop,
    async request(url) {
      calls.push(url);
      if (url.endsWith("/contests")) {
        return { status: 200, text: '<div>Registration <a href="/contests/now-3">current</a> Join Now</div><a href="/contests/old-2">past Ended</a>' };
      }
      if (url.includes("pt=24") && url.includes("id=3")) {
        return {
          status: 200,
          text: `<input id="totalResultsCount" value="2" />
            <tr class="contests-page"><td></td><td></td><td></td><td>$1</td><td>2%</td><td>3%</td><td>4</td><td>5</td><td>Manual</td>
            <td><a href="https://www.myfxbook.com/members/thaiuser/s/1">t</a></td>
            <td><span class="flag-icon-th" title="Thailand"></span><i class="onlineModern"></i></td></tr>
            <tr class="contests-page"><td></td><td></td><td></td><td>$1</td><td>1%</td><td>2%</td><td>3</td><td>4</td><td>Manual</td>
            <td><a href="https://www.myfxbook.com/members/deuser/s/2">d</a></td>
            <td><span class="flag-icon-de" title="Germany"></span></td></tr>`
        };
      }
      if (url.includes("/members/")) {
        const name = decodeURIComponent(url.split("/members/")[1]);
        const location = name.startsWith("de") ? "Germany" : "Thailand";
        return {
          status: 200,
          text: `<span class="detail-title">Location:</span> <span>${location}</span>
            <span class="detail-title">Joined:</span> <span>Jan 2020</span>
            <span class="detail-title">Experience:</span> <span>1-3 years</span>`
        };
      }
      if (url.includes("recent-topics")) {
        if (url.endsWith(",1")) {
          return { status: 200, text: '<tr><td><a href="/members/forumthai">f</a> 1 hour ago</td></tr>' };
        }
        return { status: 200, text: '<tr><td><a href="/members/oldforum">f</a> 40 days ago</td></tr>' };
      }
      if (url.includes("pt=6")) {
        if (/(?:^|[?&])p=1(?:&|$)/.test(url)) {
          return { status: 200, text: '<a href="https://www.myfxbook.com/members/systhai">s</a>' };
        }
        return { status: 200, text: "" };
      }
      return { status: 200, text: '<input id="totalResultsCount" value="0" />' };
    },
    async sleep() { stop = true; },
    isChecked: (username) => checked.has(username.toLowerCase()),
    hasLead: (username) => leads.some((lead) => lead.username.toLowerCase() === username.toLowerCase()),
    markChecked: (username) => checked.add(username.toLowerCase()),
    noteProfile() {},
    addLead(lead) { leads.push(lead); return "new"; },
    setSource() {},
    setPhase() {},
    loadCursors: () => null,
    saveCursors() {}
  };

  await run(ctx);
  const order = calls.map((url) => {
    if (url.endsWith("/contests")) return "contests";
    if (url.includes("id=3")) return "live";
    if (url.includes("/members/thaiuser")) return "profile-thai";
    if (url.includes("recent-topics")) return "forum";
    if (url.includes("/members/forumthai")) return "profile-forum";
    if (url.includes("pt=6")) return "systems";
    if (url.includes("/members/systhai")) return "profile-systems";
    if (url.includes("id=2")) return "historical";
    return url;
  });
  assert.deepEqual(order, [
    "contests", "live", "profile-thai", "historical",
    "forum", "profile-forum", "forum",
    "systems", "profile-systems", "systems"
  ]);
  assert.equal(calls.some((url) => url.includes("/members/deuser")), false);
  assert.equal(checked.has("deuser"), true);
  const thai = leads.find((lead) => lead.username === "thaiuser");
  assert.equal(thai.online, true);
  assert.equal(thai.gain, "2%");
  assert.equal(thai.country, "Thailand");
  assert.ok(leads.some((lead) => lead.username === "forumthai" && /пост/.test(lead.liveness)));
  assert.ok(leads.some((lead) => lead.username === "systhai" && /сделка/.test(lead.liveness)));
});

test("a profile below the experience minimum is checked and not saved", async () => {
  const leads = [];
  const checked = new Set();
  let stop = false;
  const ctx = {
    country: "Thailand",
    minExperience: () => "More than 5 years",
    stopped: () => stop,
    async request(url) {
      if (url.endsWith("/contests")) {
        return { status: 200, text: '<div>Live now <a href="/contests/now-3">current</a></div>' };
      }
      if (url.includes("id=3")) {
        return {
          status: 200,
          text: `<input id="totalResultsCount" value="1" />
            <tr class="contests-page"><td></td><td></td><td></td><td>$1</td><td>2%</td><td>3%</td><td>4</td><td>5</td><td>Manual</td>
            <td><a href="https://www.myfxbook.com/members/thaiuser/s/1">t</a></td>
            <td><span class="flag-icon-th" title="Thailand"></span></td></tr>`
        };
      }
      if (url.includes("/members/thaiuser")) {
        return {
          status: 200,
          text: `<span class="detail-title">Location:</span> <span>Thailand</span>
            <span class="detail-title">Experience:</span> <span>1-3 years</span>`
        };
      }
      stop = true;
      return { status: 200, text: "" };
    },
    async sleep() { stop = true; },
    isChecked: (username) => checked.has(username.toLowerCase()),
    hasLead: () => false,
    markChecked: (username) => checked.add(username.toLowerCase()),
    noteProfile() {},
    addLead(lead) { leads.push(lead); return "new"; },
    setSource() {},
    setPhase() {},
    loadCursors: () => null,
    saveCursors() {}
  };
  await run(ctx);
  assert.equal(checked.has("thaiuser"), true);
  assert.equal(leads.length, 0);
});

test("a list row that already fails experience is not opened", async () => {
  const calls = [];
  const checked = new Set();
  let stop = false;
  const ctx = {
    country: "Thailand",
    minExperience: () => "More than 5 years",
    stopped: () => stop,
    async request(url) {
      calls.push(url);
      if (url.endsWith("/contests")) {
        return { status: 200, text: '<div>Live now <a href="/contests/now-3">current</a></div>' };
      }
      if (url.includes("id=3")) {
        return {
          status: 200,
          text: `<input id="totalResultsCount" value="1" />
            <tr class="contests-page"><td></td><td></td><td></td><td>$1</td><td>2%</td><td>3%</td><td>4</td><td>5</td><td>Less than a year</td>
            <td><a href="https://www.myfxbook.com/members/thaiuser/s/1">t</a></td>
            <td><span class="flag-icon-th" title="Thailand"></span></td></tr>`
        };
      }
      stop = true;
      return { status: 200, text: "" };
    },
    async sleep() { stop = true; },
    isChecked: (username) => checked.has(username.toLowerCase()),
    shouldRecheck: () => false,
    hasLead: () => false,
    markChecked: (username) => checked.add(username.toLowerCase()),
    noteProfile() {},
    addLead() { throw new Error("should not save"); },
    setSource() {},
    setPhase() {},
    loadCursors: () => null,
    saveCursors() {}
  };
  await run(ctx);
  assert.equal(checked.has("thaiuser"), true);
  assert.equal(calls.some((url) => url.includes("/members/thaiuser")), false);
});

test("profile fetches run two at a time until the slot count drops", async () => {
  let slots = 2;
  let active = 0;
  let maxOpen = 0;
  let startedAfterDrop = 0;
  let maxAfterDrop = 0;
  const ctx = { stopped: () => false, profileSlots: () => slots };
  await eachProfile(ctx, [1, 2, 3, 4], async (n) => {
    const dropped = slots === 1;
    active += 1;
    if (dropped) {
      startedAfterDrop += 1;
      maxAfterDrop = Math.max(maxAfterDrop, active);
    } else {
      maxOpen = Math.max(maxOpen, active);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (n === 1) slots = 1;
    active -= 1;
  });
  assert.equal(maxOpen, 2);
  assert.ok(startedAfterDrop >= 2);
  assert.equal(maxAfterDrop, 1);
});
