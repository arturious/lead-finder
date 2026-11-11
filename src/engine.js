const fs = require("fs");
const os = require("os");
const path = require("path");
const { createBrowser } = require("./browser");
const { getSource } = require("./sources");
const { politeDelayMs, backoffMinutes } = require("./pacing");

function licenseFile() {
  return path.join(os.homedir(), ".cloakbrowser", "license.key");
}

function hasLicenseKey() {
  if ((process.env.CLOAKBROWSER_LICENSE_KEY || "").trim()) return true;
  try {
    return fs.readFileSync(licenseFile(), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function saveLicenseKey(key) {
  const trimmed = String(key || "").trim();
  if (!/^cb_[A-Za-z0-9._-]{8,}$/.test(trimmed)) {
    throw new Error("Ключ CloakBrowser начинается с cb_");
  }
  const file = licenseFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${trimmed}\n`, { mode: 0o600 });
}

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
    license: false,
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

  function noteDownload(line) {
    const progress = line.match(/Download progress:\s*(\d+)%\s*(?:\(([^)]+)\))?/i);
    if (progress) {
      stats.phase = "download";
      stats.progress = Number(progress[1]);
      stats.message = progress[2]
        ? `Загрузка CloakBrowser: ${progress[1]}% (${progress[2]})`
        : `Загрузка CloakBrowser: ${progress[1]}%`;
    } else if (/Downloading/i.test(line)) {
      stats.phase = "download";
      stats.message = "Скачиваю Chromium для CloakBrowser…";
    } else if (/Extracting/i.test(line)) {
      stats.phase = "download";
      stats.message = "Распаковываю CloakBrowser…";
    } else if (/Binary ready/i.test(line)) {
      stats.progress = 100;
      stats.message = "CloakBrowser готов";
    } else {
      return;
    }
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
        stats.message = "Cloudflare «Just a moment». Пройдите проверку в окне CloakBrowser — поиск продолжится сам.";
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

    if (!hasLicenseKey()) {
      stats.running = false;
      stats.phase = "error";
      stats.license = true;
      stats.country = country;
      stats.siteId = siteId;
      stats.message = "Нужен бесплатный ключ CloakBrowser (cb_…). Возьмите его командой npx cloakbrowser login и вставьте сюда. Без ключа браузер не скачивается.";
      store.setLast(siteId, country);
      emitStatus();
      return snapshot();
    }

    stopRequested = false;
    running = true;
    stats.running = true;
    stats.license = false;
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
    stats.message = "Запуск CloakBrowser…";
    store.setLast(siteId, country);
    emitStatus();
    emit("leads", store.leadsFor(country));

    browser = createBrowser({
      userDataDir: profileDir,
      entryUrl: source.entryUrl,
      onProgress: noteDownload
    });

    try {
      await browser.open(true);
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
        const message = error && error.message ? error.message : String(error);
        stats.phase = "error";
        stats.license = /license key/i.test(message);
        stats.message = stats.license
          ? "CloakBrowser не принял ключ. Проверьте CLOAKBROWSER_LICENSE_KEY или вставьте новый ключ."
          : message;
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

  return { start, stop, snapshot, saveLicenseKey, hasLicenseKey };
}

module.exports = { createEngine, saveLicenseKey, hasLicenseKey, backoffMinutes, politeDelayMs };
