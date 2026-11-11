const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseContestRows,
  parseForumItems,
  parseSystemsUsernames,
  parseProfile,
  parseTotal,
  parseContestIds,
  parseLiveContestId,
  agoDays,
  countryMatches,
  findCountryStart,
  isChallengeHtml,
  isHardBlockHtml,
  decodeCfEmail
} = require("../src/parse");
const { contestPageUrl, systemsPageUrl, SYSTEMS_DAYS, run } = require("../src/sources/myfxbook");
const { leadsToCsv, leadsToXlsx } = require("../src/export");
const { politeDelayMs, backoffMinutes, cooldownMs } = require("../src/pacing");
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
    online: true
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
  assert.deepEqual(items, [{ username: "getting", recency: "2 hours ago" }]);
  assert.ok(agoDays("2 hours ago") < 1);
  assert.equal(agoDays("40 days ago") > 30, true);
  assert.equal(agoDays(""), null);
});

test("systems links and paging urls", () => {
  const users = parseSystemsUsernames(
    '<a href="https://www.myfxbook.com/members/alpha">a</a><a href="/members/alpha">dup</a><a href="/members/systems">no</a>'
  );
  assert.deepEqual(users, ["alpha"]);
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
  assert.equal(isChallengeHtml("<title>Just a moment...</title><div class=\"challenge-platform\"></div>", "Just a moment..."), true);
  assert.equal(isHardBlockHtml("<h1>Sorry, you have been blocked</h1>"), true);
  assert.equal(isChallengeHtml("<h1>Sorry, you have been blocked</h1> Just a moment challenge-platform", ""), false);
});

test("pacing stays slow and backs off in minutes", () => {
  assert.equal(politeDelayMs(() => 0), 2000);
  assert.equal(politeDelayMs(() => 0.9995), 3000);
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
  assert.match(csv, /,yes,/);
  const xlsx = leadsToXlsx(leads);
  assert.equal(xlsx.readUInt32LE(0), 0x04034b50);
  assert.match(xlsx.toString("utf8"), /save2009/);
});

test("store remembers checked names and leads per country", () => {
  const file = path.join(os.tmpdir(), `lead-finder-test-${Date.now()}.json`);
  const store = createStore(file);
  store.markChecked("Other", { country: "Germany" });
  assert.equal(store.isChecked("other"), true);
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
  store.saveNow();
  const again = createStore(file);
  assert.equal(again.leadsFor("Thailand")[0].username, "save2009");
  fs.unlinkSync(file);
});

test("a round checks the live contest, then forum, then systems, and skips other countries", async () => {
  const calls = [];
  const leads = [];
  const checked = new Set();
  let stop = false;
  const ctx = {
    country: "Thailand",
    stopped: () => stop,
    async request(url) {
      calls.push(url);
      if (calls.length >= 8) stop = true;
      if (url.endsWith("/contests")) {
        return { status: 200, text: '<a href="/contests/old-2">past</a><div>Live now <a href="/contests/now-3">current</a></div>' };
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
        return { status: 200, text: '<tr><td><a href="/members/forumthai">f</a> 1 hour ago</td></tr>' };
      }
      if (url.includes("pt=6")) return { status: 200, text: '<a href="https://www.myfxbook.com/members/systhai">s</a>' };
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
  assert.deepEqual(order.slice(0, 7), [
    "contests", "live", "profile-thai", "forum", "profile-forum", "systems", "profile-systems"
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
