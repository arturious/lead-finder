const path = require("path");
const { createBrowser, shouldReuseBrowser } = require("./browser");
const { createHttpClient, freshHttpState, httpFallbackState } = require("./http");
const { getSource } = require("./sources");
const { createPace, paceDelayMs, paceOnSuccess, paceOnLimit, paceOnSoft, paceKind, backoffMinutes } = require("./pacing");
const { assertProxyReachable } = require("./proxy");
const { createCamoufoxClient, locateCamoufox, normalizeHttpEngine, engineMode, fallbackEngine } = require("./camoufox");

function createEngine({ store, profileDir, emit }) {
  let stopRequested = false;
  let running = false;
  let browser = null;
  let launchedProxy = null;
  let browserOpening = null;
  let shuttingDown = false;
  let pace = createPace();
  let httpState = freshHttpState();
  let httpClient = null;
  let camoufox = null;
  let camoufoxReady = false;
  let settleUntil = 0;
  const CLEAR_SETTLE_MS = 1500;
  let backoffTask = null;
  let challengeTask = null;
  const wakes = new Set();
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
      const done = () => {
        clearTimeout(timer);
        wakes.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      wakes.add(done);
    });
  }

  function stop() {
    stopRequested = true;
    for (const wake of [...wakes]) wake();
    if (camoufox) camoufox.cancel();
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

  function backoff(reason) {
    if (backoffTask) return backoffTask;
    backoffTask = (async () => {
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
    })().finally(() => {
      backoffTask = null;
    });
    return backoffTask;
  }

  function engineName() {
    if (httpState.mode === "http") return "impit";
    if (httpState.mode === "window") return "window";
    return "camoufox";
  }

  function camoufoxProfileDir() {
    return path.join(path.dirname(profileDir), "camoufox-profile");
  }

  function camoufoxClient() {
    if (camoufox) return camoufox;
    const found = locateCamoufox(path.join(__dirname, ".."));
    if (found.error) return null;
    camoufox = createCamoufoxClient({
      command: found.python,
      args: [found.script],
      profileDir: camoufoxProfileDir(),
      proxy: currentProxy(),
      log(line) {
        const text = String(line || "").trim();
        if (text && /error|traceback|modulenotfound|not supported/i.test(text)) {
          logLine(`camoufox: ${text.split("\n")[0]}`);
        }
      }
    });
    return camoufox;
  }

  async function ensureCamoufox() {
    if (camoufoxReady) return "";
    const found = locateCamoufox(path.join(__dirname, ".."));
    if (found.error) return found.error;
    const client = camoufoxClient();
    if (!client) return found.error || "camoufox unavailable";
    try {
      await client.useProxy(currentProxy());
      await client.start();
      camoufoxReady = true;
      return "";
    } catch (error) {
      camoufoxReady = false;
      await client.close().catch(() => {});
      return error && error.message ? error.message : String(error);
    }
  }

  function logLine(message) {
    console.log(`[lead-finder] ${message}`);
  }

  function clearChallenge(url) {
    if (!challengeTask) {
      const started = Date.now();
      logLine(`cf challenge start engine=${engineName()} url=${url}`);
      const run = browser.clearUrl
        ? browser.clearUrl(url, () => stopRequested)
        : browser.showForChallenge(() => stopRequested);
      challengeTask = Promise.resolve(run).then((ok) => {
        logLine(`cf challenge clear engine=${engineName()} url=${url} ms=${Date.now() - started} ok=${Boolean(ok)}`);
        return ok;
      }).finally(() => {
        challengeTask = null;
      });
    }
    return challengeTask;
  }

  function switchToWindow(reason) {
    const message = reason === "challenge"
      ? "Быстрые запросы не проходят Cloudflare, продолжаю в окне."
      : "Быстрые запросы недоступны, продолжаю в окне.";
    stats.message = message;
    emitStatus();
  }

  function httpClientFor(current) {
    if (!httpClient) {
      httpClient = createHttpClient({
        cookieHeader: (url) => current.cookieHeader(url),
        setCookie: (line, url) => current.writeCookie(line, url),
        userAgent: () => current.userAgent(),
        acceptLanguage: () => current.acceptLanguage(),
        proxyUrl: () => current.proxyUrl()
      });
    }
    return httpClient;
  }

  async function fetchPage(url, options) {
    if (httpState.mode === "camoufox") {
      try {
        const startError = await ensureCamoufox();
        if (startError) {
          logLine(`camoufox unavailable: ${startError}; engine=window`);
          httpState.mode = "window";
        } else {
          return await camoufox.fetch(url);
        }
      } catch (error) {
        const code = error && error.code;
        if (code === "STOP" || stopRequested) throw error;
        if (code === "CAMOUFOX_CLOSED" || code === "CAMOUFOX_TIMEOUT") {
          return { timeout: true, error: error.message || String(error) };
        }
        logLine(`camoufox unavailable: ${error && error.message ? error.message : error}; engine=window`);
        httpState.mode = "window";
        camoufoxReady = false;
      }
      if (!browser || !browser.isOpen()) {
        try { await ensureBrowser(); } catch (error) {
          return { timeout: true, error: error && error.message ? error.message : String(error) };
        }
      }
      return browser.fetch(url, options);
    }
    if (httpState.mode === "window" || !browser || !browser.cookieHeader) return browser.fetch(url, options);
    try {
      return await httpClientFor(browser).fetch(url, options);
    } catch (error) {
      const event = error && error.code === "IMPIT_LOAD" ? "load-failed" : "client-error";
      const next = httpFallbackState(httpState, event);
      const switched = next.switched;
      httpState = next;
      if (switched) switchToWindow(next.reason);
      if (httpState.mode === "window") return browser.fetch(url, options);
      return { timeout: true, error: error && error.message ? error.message : String(error) };
    }
  }

  async function request(url, options) {
    while (!stopRequested) {
      const settleLeft = settleUntil - Date.now();
      if (settleLeft > 0) await sleep(settleLeft);
      await sleep(paceDelayMs(pace));
      if (stopRequested) break;
      if (httpState.mode !== "camoufox" && (!browser || !browser.isOpen())) {
        try {
          await ensureBrowser();
        } catch (error) {
          if (stopRequested) break;
          await backoff(error && error.message ? error.message : "Браузер закрылся");
          continue;
        }
        if (stopRequested || !browser || !browser.isOpen()) continue;
      }
      stats.requests += 1;
      if (stats.phase !== "challenge") stats.phase = "running";
      emitStatus();
      let result;
      try {
        result = await fetchPage(url, options || {});
      } catch (error) {
        if (stopRequested) break;
        await backoff("Таймаут или обрыв");
        continue;
      }
      if (result.closed || (httpState.mode !== "camoufox" && browser && !browser.isOpen())) {
        try {
          await ensureBrowser();
        } catch (error) {
          if (stopRequested) break;
          await backoff(error && error.message ? error.message : "Браузер закрылся");
        }
        continue;
      }
      if (result.status === 403 || result.status === 429 || httpState.mode === "camoufox") {
        const ms = result.ms != null ? ` ms=${result.ms}` : "";
        logLine(`http ${result.status} challenge=${Boolean(result.challenge)} engine=${engineName()}${ms} url=${url}`);
      }
      const kind = paceKind(result);
      if (kind === "clear") {
        if (httpState.mode === "http") {
          const next = httpFallbackState(httpState, "challenge");
          const switched = next.switched;
          httpState = next;
          if (switched) switchToWindow(next.reason);
        }
        if (!browser || !browser.isOpen()) {
          try {
            await ensureBrowser();
          } catch (error) {
            if (stopRequested) break;
            await backoff(error && error.message ? error.message : "Браузер закрылся");
            continue;
          }
        }
        stats.phase = "challenge";
        stats.blocked = true;
        emitStatus();
        const cleared = await clearChallenge(url);
        stats.blocked = false;
        if (stopRequested) break;
        if (!cleared) {
          await backoff("Проверка Cloudflare не пройдена");
        } else {
          settleUntil = Date.now() + CLEAR_SETTLE_MS;
          if (httpState.mode === "http") httpState = httpFallbackState(httpState, "cleared");
        }
        continue;
      }
      if (kind === "limit" || kind === "soft") {
        if (kind === "limit") {
          const decision = paceOnLimit(pace, { status: result.status, retryAfter: result.retryAfter });
          if (decision.longBackoff) {
            await backoff(`Ответ ${result.status}`);
          } else {
            stats.phase = "running";
            stats.blocked = false;
            stats.message = `Ответ ${result.status}. Пауза ${Math.ceil(decision.waitMs / 1000)} с`;
            emitStatus();
            await sleep(decision.waitMs);
          }
          continue;
        }
        const waitMs = paceOnSoft(pace);
        let why = result.status ? `Ответ ${result.status}` : "Таймаут";
        if (!result.status && !String(store.data.proxy || "").trim()) {
          why += ". Сайт не открылся — укажите прокси socks5://host:port, если Myfxbook недоступен из вашей страны";
        }
        stats.phase = "running";
        stats.blocked = false;
        stats.message = `${why}. Пауза ${Math.ceil(waitMs / 1000)} с`;
        emitStatus();
        await sleep(waitMs);
        continue;
      }
      if (httpState.mode === "http") httpState = httpFallbackState(httpState, "ok");
      paceOnSuccess(pace);
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
      profileSlots: () => pace.slots,
      shouldRecheck: (username) => store.shouldRecheck(username),
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
      minExperience: () => store.data.minExperience || "",
      loadCursors: () => store.getCursors(country),
      saveCursors: (cursors) => store.setCursors(country, cursors),
      entryUrl: source.entryUrl
    };
  }

  function entryUrl() {
    const source = getSource(stats.siteId) || getSource("myfxbook");
    return source ? source.entryUrl : "https://www.myfxbook.com/contests";
  }

  function currentProxy() {
    return String(store.data.proxy || "").trim();
  }

  async function relaunch(proxy) {
    const previous = browser;
    browser = null;
    httpClient = null;
    if (previous) await previous.close().catch(() => {});
    if (shuttingDown) return;
    if (proxy) await assertProxyReachable(proxy);
    if (shuttingDown) return;
    const created = createBrowser({
      userDataDir: profileDir,
      entryUrl: entryUrl(),
      onProgress: noteProgress,
      proxy
    });
    browser = created;
    launchedProxy = proxy;
    await created.open();
  }

  async function ensureBrowser() {
    if (browserOpening) {
      await browserOpening.catch(() => {});
      if (shuttingDown) return;
    }
    const proxy = currentProxy();
    if (shouldReuseBrowser(browser && browser.isOpen(), launchedProxy, proxy)) return;
    browserOpening = relaunch(proxy).finally(() => {
      browserOpening = null;
    });
    await browserOpening;
    if (!shuttingDown && launchedProxy !== currentProxy()) return ensureBrowser();
  }

  function warm() {
    return ensureBrowser().then(() => {
      if (running || shuttingDown) return snapshot();
      stats.phase = "idle";
      stats.message = "Выберите страну и нажмите «Начать поиск».";
      stats.progress = null;
      emitStatus();
      return snapshot();
    }).catch((error) => {
      if (!running && !shuttingDown) {
        stats.phase = "error";
        stats.message = error && error.message ? error.message : String(error);
        emitStatus();
      }
      return snapshot();
    });
  }

  async function useProxy(value) {
    store.setProxy(value);
    if (browser || browserOpening) await ensureBrowser();
    if (camoufox) {
      camoufoxReady = false;
      await camoufox.useProxy(currentProxy()).catch(() => {});
    }
    return snapshot();
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    stop();
    if (browserOpening) await browserOpening.catch(() => {});
    const current = browser;
    browser = null;
    launchedProxy = null;
    if (current) await current.close().catch(() => {});
    camoufoxReady = false;
    if (camoufox) await camoufox.close().catch(() => {});
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
    pace = createPace();
    const selected = normalizeHttpEngine(store.data.httpEngine);
    const startError = selected === "camoufox" ? await ensureCamoufox() : "";
    const chosen = fallbackEngine(selected, startError);
    httpState = freshHttpState();
    httpState.mode = engineMode(chosen);
    httpClient = null;
    settleUntil = 0;
    if (startError) logLine(`camoufox unavailable: ${startError}; engine=window`);
    logLine(`engine ${engineName()}`);
    stats.country = country;
    stats.siteId = siteId;
    stats.phase = "running";
    stats.message = "Открываю Myfxbook…";
    store.setLast(siteId, country);
    emitStatus();
    emit("leads", store.leadsFor(country));

    try {
      await ensureBrowser();
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

  async function showBrowser() {
    try {
      await ensureBrowser();
    } catch {
      return false;
    }
    if (!browser || typeof browser.showWindow !== "function") return false;
    return browser.showWindow();
  }

  return { start, stop, snapshot, showBrowser, warm, useProxy, shutdown };
}

module.exports = { createEngine, backoffMinutes };
