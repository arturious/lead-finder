const { createBrowser } = require("./browser");
const { getSource } = require("./sources");
const { politeDelayMs, backoffMinutes } = require("./pacing");

function createEngine({ store, profileDir, emit }) {
  let stopRequested = false;
  let running = false;
  let wake = null;
  let browser = null;
  const stats = {
    running: false,
    phase: "idle",
    message: "Выберите страну и нажмите «Начать поиск».",
    requests: 0,
    profiles: 0,
    leads: 0,
    source: "",
    progress: null,
    blocked: false,
    country: store.data.lastCountry || "",
    siteId: store.data.lastSite || "myfxbook"
  };

  function snapshot() {
    return { ...stats, running };
  }

  function emitStatus() {
    emit("status", snapshot());
  }

  function sleep(ms) {
    if (stopRequested || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }

  function stop() {
    stopRequested = true;
    if (wake) wake();
    if (stats.phase !== "error") {
      stats.phase = "stopping";
      stats.message = "Останавливаю…";
      emitStatus();
    }
  }

  function noteProgress(update) {
    if (!update || typeof update !== "object") return;
    if (update.phase) stats.phase = update.phase;
    if (update.message) stats.message = update.message;
    if (Object.prototype.hasOwnProperty.call(update, "progress")) stats.progress = update.progress;
    emitStatus();
  }

  async function backoff(reason) {
    const minutes = backoffMinutes(stats.backoffStep || 0);
    stats.backoffStep = Math.min((stats.backoffStep || 0) + 1, 8);
    stats.blocked = true;
    stats.phase = "blocked";
    const end = Date.now() + minutes * 60 * 1000;
    while (!stopRequested && Date.now() < end) {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      const m = Math.floor(left / 60);
      const s = String(left % 60).padStart(2, "0");
      stats.message = `${reason}. Повтор через ${m}:${s}`;
      emitStatus();
      await sleep(Math.min(1000, Math.max(0, end - Date.now())));
    }
    stats.blocked = false;
  }

  async function request(url, options) {
    while (!stopRequested) {
      await sleep(politeDelayMs());
      if (stopRequested) break;
      stats.requests += 1;
      if (stats.phase !== "challenge") stats.phase = "running";
      emitStatus();
      let result;
      try {
        result = await browser.fetch(url, options || {});
      } catch (error) {
        if (stopRequested) break;
        await backoff("Таймаут или обрыв");
        continue;
      }
      if (result.challenge) {
        stats.phase = "challenge";
        stats.blocked = true;
        stats.message = "Cloudflare «Just a moment». Пройдите проверку в окне браузера — поиск продолжится сам.";
        emitStatus();
        const cleared = await browser.showForChallenge(() => stopRequested);
        stats.blocked = false;
        if (stopRequested) break;
        if (!cleared) {
          await backoff("Проверка Cloudflare не пройдена");
        }
        continue;
      }
      if (result.blocked || result.timeout) {
        const why = result.status ? `Ответ ${result.status}` : "Таймаут";
        await backoff(why);
        continue;
      }
      stats.backoffStep = 0;
      stats.blocked = false;
      return result;
    }
    const error = new Error("stopped");
    error.code = "STOP";
    throw error;
  }

  function makeCtx(source, country) {
    return {
      country,
      stopped: () => stopRequested,
      request,
      sleep,
      isChecked: (username) => store.isChecked(username),
      hasLead: (username) => store.hasLead(username),
      markChecked: (username, info) => store.markChecked(username, info),
      noteProfile() {
        stats.profiles += 1;
        emitStatus();
      },
      addLead(lead) {
        const fresh = store.upsertLead(lead);
        stats.leads = store.leadsFor(country).length;
        if (fresh !== "same") emit("lead", { lead: store.data.leads.find((item) => item.username.toLowerCase() === lead.username.toLowerCase()), fresh });
        emitStatus();
        return fresh;
      },
      setSource(label) {
        stats.source = label;
        if (stats.phase === "running" || stats.phase === "starting" || stats.phase === "cooldown") {
          stats.message = label;
        }
        emitStatus();
      },
      setPhase(phase, message) {
        stats.phase = phase;
        stats.message = message || stats.message;
        stats.blocked = phase === "blocked" || phase === "challenge";
        emitStatus();
      },
      loadCursors: () => store.getCursors(country),
      saveCursors: (cursors) => store.setCursors(country, cursors),
      entryUrl: source.entryUrl
    };
  }

  async function start({ siteId, country }) {
    if (running) return snapshot();
    const source = getSource(siteId);
    if (!source) throw new Error("Неизвестный сайт");
    if (!country) throw new Error("Выберите страну");

    stopRequested = false;
    running = true;
    stats.running = true;
    stats.requests = 0;
    stats.profiles = 0;
    stats.leads = store.leadsFor(country).length;
    stats.source = "";
    stats.progress = null;
    stats.blocked = false;
    stats.backoffStep = 0;
    stats.country = country;
    stats.siteId = siteId;
    stats.phase = "starting";
    stats.message = "Запуск Chrome…";
    store.setLast(siteId, country);
    emitStatus();
    emit("leads", store.leadsFor(country));

    browser = createBrowser({
      userDataDir: profileDir,
      entryUrl: source.entryUrl,
      onProgress: noteProgress
    });

    try {
      await browser.open();
      if (stopRequested) {
        const error = new Error("stopped");
        error.code = "STOP";
        throw error;
      }
      stats.phase = "running";
      stats.message = "Открываю Myfxbook…";
      emitStatus();
      await source.run(makeCtx(source, country));
    } catch (error) {
      if (error.code !== "STOP") {
        stats.phase = "error";
        stats.message = error && error.message ? error.message : String(error);
        emitStatus();
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
      browser = null;
      running = false;
      stats.running = false;
      stats.blocked = false;
      stats.progress = null;
      if (stats.phase !== "error") {
        stats.phase = "idle";
        stats.message = "Остановлено. Найденные лиды сохранены.";
        stats.source = "";
      }
      store.saveNow();
      emitStatus();
    }
    return snapshot();
  }

  return { start, stop, snapshot };
}

module.exports = { createEngine, backoffMinutes, politeDelayMs };
