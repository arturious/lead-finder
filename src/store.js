const fs = require("fs");
const path = require("path");
const { countryMatches } = require("./parse");
const { normalizeHttpEngine } = require("./camoufox");

const RECHECK_MS = 3 * 24 * 60 * 60 * 1000;

function emptyData() {
  return {
    checked: {},
    leads: [],
    cursors: {},
    lastCountry: "",
    lastSite: "myfxbook",
    proxy: "",
    minExperience: "",
    httpEngine: "camoufox"
  };
}

function createStore(file) {
  const data = load(file);
  let timer = null;
  let dirty = false;

  function scheduleSave() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty) saveNow();
    }, 1500);
    if (timer.unref) timer.unref();
  }

  function saveNow() {
    dirty = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  return {
    data,
    saveNow,
    isChecked(username) {
      return Boolean(data.checked[String(username || "").toLowerCase()]);
    },
    checkedCountry(username) {
      const row = data.checked[String(username || "").toLowerCase()];
      return row ? row.country || "" : "";
    },
    markChecked(username, info) {
      const key = String(username || "").toLowerCase();
      if (!key) return;
      const prev = data.checked[key] || {};
      data.checked[key] = {
        country: (info && info.country) || prev.country || "",
        checkedAt: (info && info.checkedAt) || new Date().toISOString(),
        noContacts: Boolean(info && info.noContacts)
      };
      scheduleSave();
    },
    shouldRecheck(username, now = Date.now()) {
      const row = data.checked[String(username || "").toLowerCase()];
      if (!row || !row.noContacts) return false;
      const at = Date.parse(row.checkedAt || row.at || "");
      if (!Number.isFinite(at)) return true;
      return now - at >= RECHECK_MS;
    },
    hasLead(username) {
      const key = String(username || "").toLowerCase();
      return data.leads.some((lead) => lead.username.toLowerCase() === key);
    },
    upsertLead(lead) {
      const key = String(lead.username || "").toLowerCase();
      const idx = data.leads.findIndex((item) => item.username.toLowerCase() === key);
      if (idx === -1) {
        data.leads.push(lead);
        saveNow();
        return "new";
      }
      const prev = data.leads[idx];
      const next = { ...prev };
      for (const field of ["country", "equity", "gain", "drawdown", "pips", "trades", "trading", "joined", "experience", "contacts", "systemUrl"]) {
        if (!next[field] && lead[field]) next[field] = lead[field];
      }
      if (lead.online) next.online = true;
      if (lead.liveness && lead.liveness !== prev.liveness) {
        const prevText = prev.liveness || "";
        const keepPrev = (/онлайн/.test(prevText) && !/онлайн/.test(lead.liveness))
          || (/пост|сделка/.test(prevText) && lead.liveness === "конкурс");
        if (!keepPrev) next.liveness = lead.liveness;
      }
      if (JSON.stringify(next) === JSON.stringify(prev)) return "same";
      data.leads[idx] = next;
      saveNow();
      return "updated";
    },
    leadsFor(country) {
      return data.leads.filter((lead) => countryMatches(lead.country, country));
    },
    getCursors(country) {
      return data.cursors[String(country || "").toLowerCase()] || null;
    },
    setCursors(country, cursors) {
      data.cursors[String(country || "").toLowerCase()] = cursors;
      scheduleSave();
    },
    setLast(site, country) {
      data.lastSite = site;
      data.lastCountry = country;
      scheduleSave();
    },
    setProxy(value) {
      data.proxy = String(value || "").trim();
      scheduleSave();
    },
    setMinExperience(value) {
      data.minExperience = String(value || "");
      scheduleSave();
    },
    clearFound() {
      data.leads = [];
      data.checked = {};
      data.cursors = {};
      saveNow();
    }
  };
}

function load(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...emptyData(),
      ...parsed,
      checked: parsed.checked || {},
      leads: Array.isArray(parsed.leads) ? parsed.leads : [],
      cursors: parsed.cursors || {},
      httpEngine: normalizeHttpEngine(parsed.httpEngine)
    };
  } catch {
    return emptyData();
  }
}

module.exports = { createStore, RECHECK_MS };
