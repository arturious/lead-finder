const path = require("path");
const { createBrowser, shouldReuseBrowser } = require("./browser");
const { createHttpClient, freshHttpState, httpFallbackState } = require("./http");
const { getSource } = require("./sources");
const { createPace, paceDelayMs, paceOnSuccess, paceOnLimit, paceOnSoft, paceKind, backoffMinutes } = require("./pacing");
const { assertProxyReachable } = require("./proxy");
const { createCamoufoxClient, locateCamoufox, normalizeHttpEngine, engineMode, fallbackEngine, camoufoxSlots } = require("./camoufox");

function createEngine({ store, profileDir, emit, browserFactory, camoufoxCommand }) {
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
  let stopMark = 0;
  let pendingLabel = "";
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

  function sleep(ms, label = "sleep") {
    if (stopRequested || ms <= 0) return Promise.resolve();
    const previous = pendingLabel;
    pendingLabel = label;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wakes.delete(done);
        if (pendingLabel === label) pendingLabel = previous;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wakes.add(done);
    });
  }

  // Resolves when `promise` settles, or as soon as Stop is pressed, whichever
  // is first. The underlying work may still finish; Stop does not wait for it.
  function abandonable(label, promise) {
    const previous = pendingLabel;
    pendingLabel = label;
    let wake;
    const stopped = new Promise((resolve) => {
      wake = () => resolve({ stopped: true });
      if (stopRequested) wake();
      else wakes.add(wake);
    });
    const work = Promise.resolve(promise).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    return Promise.race([work, stopped]).finally(() => {
      if (wake) wakes.delete(wake);
      if (pendingLabel === label) pendingLabel = previous;
    });
  }

  function stopError() {
    const error = new Error("stopped");
    error.code = "STOP";
    return error;
  }

  function stop() {
    const first = !stopRequested;
    stopRequested = true;
    if (first) {
      stopMark = Date.now();
      logLine("stop requested");
      const label = pendingLabel;
      const timer = setTimeout(() => {
        if (stopRequested && running && label && pendingLabel === label) {
          logLine(`stop waiting on ${label} ${Date.now() - stopMark}ms`);
        }
      }, 1000);
      if (timer.unref) timer.unref();
    }
    // Publish "stopping" before waking the run. The run can finish inside
    // wake() and emit idle; a status sent after that would stick on screen.
    if (running && stats.phase !== "error") {
      stats.phase = "stopping";
      stats.message = "Останавливаю…";
      emitStatus();
    }
    for (const wake of [...wakes]) wake();
    if (camoufox) camoufox.cancel();
    if (browser && typeof browser.abortLoad === "function") {
      try { browser.abortLoad(); } catch { /* the window is already gone */ }
    }
  }

  function noteProgress(update) {
    if (!update || typeof update !== "object" || stopRequested) return;
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
        await sleep(Math.min(1000, Math.max(0, end - Date.now())), "backoff");
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

  function camoufoxLaunch() {
    if (typeof camoufoxCommand === "function") return camoufoxCommand();
    if (camoufoxCommand && camoufoxCommand.command) {
      return { command: camoufoxCommand.command, args: camoufoxCommand.args || [] };
    }
    const found = locateCamoufox(path.join(__dirname, ".."));
    if (found.error) return { error: found.error };
    return { command: found.python, args: [found.script] };
  }

  function camoufoxClient() {
    if (camoufox) return camoufox;
    const found = camoufoxLaunch();
    if (!found || found.error || !found.command) return null;
    camoufox = createCamoufoxClient({
      command: found.command,
      args: found.args || [],
      profileDir: camoufoxProfileDir(),
      proxy: currentProxy(),
      log(line) {
        const text = String(line || "").trim();
        if (text && /error|traceback|modulenotfound|not supported|recycle/i.test(text)) {
          logLine(`camoufox: ${text.split("\n")[0]}`);
        }
      }
    });
    return camoufox;
  }

  async function ensureCamoufox() {
    if (camoufoxReady) return "";
    if (stopRequested) return "";
    const found = camoufoxLaunch();
    if (!found || found.error) return (found && found.error) || "camoufox unavailable";
    const client = camoufoxClient();
    if (!client) return found.error || "camoufox unavailable";
    try {
      await client.useProxy(currentProxy());
      const starting = client.start();
      starting.catch(() => {});
      const outcome = await abandonable("camoufox.start", starting);
      if (outcome.stopped || stopRequested) return "";
      if (outcome.error) throw outcome.error;
      camoufoxReady = true;
      return "";
    } catch (error) {
      camoufoxReady = false;
      const closing = client.close();
      closing.catch(() => {});
      const outcome = await abandonable("camoufox.close", closing);
      if (outcome.stopped || stopRequested) return "";
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
          return await camoufox.fetch(url, options || {});
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
      if (stopRequested) throw stopError();
      if (!browser || !browser.isOpen()) {
        try { await ensureBrowser(); } catch (error) {
          if (stopRequested) throw stopError();
          return { timeout: true, error: error && error.message ? error.message : String(error) };
        }
      }
      if (stopRequested) throw stopError();
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
      if (settleLeft > 0) await sleep(settleLeft, "settle");
      await sleep(paceDelayMs(pace), "pace");
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
      const pendingFetch = fetchPage(url, options || {});
      pendingFetch.catch(() => {});
      const fetched = await abandonable(`fetch ${url}`, pendingFetch);
      if (fetched.stopped || stopRequested) break;
      let result;
      if (fetched.error) {
        if (fetched.error.code === "STOP") break;
        await backoff("Таймаут или обрыв");
        continue;
      }
      result = fetched.value;
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
          if (stopRequested) break;
        }
        stats.phase = "challenge";
        stats.blocked = true;
        emitStatus();
        const challenge = clearChallenge(url);
        challenge.catch(() => {});
        const clearedWait = await abandonable("clearChallenge", challenge);
        if (clearedWait.stopped || stopRequested) break;
        const cleared = clearedWait.value;
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
            await sleep(decision.waitMs, "backoff");
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
        await sleep(waitMs, "backoff");
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
      log(line) {
        logLine(String(line || ""));
      },
      profileSlots: () => (httpState.mode === "camoufox" ? camoufoxSlots(pace.slots) : pace.slots),
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
    const created = (browserFactory || createBrowser)({
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
    if (stopRequested || shuttingDown) return;
    if (browserOpening) {
      const pending = browserOpening;
      pending.catch(() => {});
      const outcome = await abandonable("ensureBrowser", pending);
      if (outcome.stopped || stopRequested || shuttingDown) return;
      if (outcome.error && !(browser && browser.isOpen())) throw outcome.error;
    }
    const proxy = currentProxy();
    if (shouldReuseBrowser(browser && browser.isOpen(), launchedProxy, proxy)) return;
    if (stopRequested || shuttingDown) return;
    const opening = relaunch(proxy).finally(() => {
      if (browserOpening === opening) browserOpening = null;
    });
    opening.catch(() => {});
    browserOpening = opening;
    const outcome = await abandonable("relaunch", opening);
    if (outcome.stopped || stopRequested || shuttingDown) return;
    if (outcome.error) throw outcome.error;
    if (launchedProxy !== currentProxy()) return ensureBrowser();
  }

  function warm() {
    if (normalizeHttpEngine(store.data.httpEngine) === "camoufox") {
      return Promise.resolve(snapshot());
    }
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
    stopMark = 0;
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
    stats.country = country;
    stats.siteId = siteId;
    stats.phase = "running";
    stats.message = "Открываю Myfxbook…";
    store.setLast(siteId, country);
    emitStatus();
    emit("leads", store.leadsFor(country));

    try {
      const selected = normalizeHttpEngine(store.data.httpEngine);
      const startError = selected === "camoufox" ? await ensureCamoufox() : "";
      if (stopRequested) throw stopError();
      const chosen = fallbackEngine(selected, startError);
      httpState = freshHttpState();
      httpState.mode = engineMode(chosen);
      httpClient = null;
      settleUntil = 0;
      if (startError) logLine(`camoufox unavailable: ${startError}; engine=window`);
      logLine(`engine ${engineName()}`);
      if (httpState.mode !== "camoufox") await ensureBrowser();
      if (stopRequested) throw stopError();
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
        stats.message = "";
        stats.source = "";
      }
      store.saveNow();
      if (stopMark) logLine(`stopped after ${Date.now() - stopMark}ms`);
      emitStatus();
    }
    return snapshot();
  }

  return { start, stop, snapshot, warm, useProxy, shutdown };
}

module.exports = { createEngine, backoffMinutes };
