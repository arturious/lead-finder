const { isChallengeHtml, isHardBlockHtml } = require("./parse");
const { prepareChromeProxy } = require("./proxy");
const { parseSetCookie, proxyUrlForImpit, isCloudflareChallenge } = require("./http");

const BLOCKED_TYPES = new Set(["image", "media", "font"]);
const CHALLENGE_RELOAD_MS = 3000;
const CHALLENGE_RELOAD_MESSAGE = "Cloudflare: обновляю страницу…";
const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

const sessionsHooked = new WeakSet();
const proxyAuthByContents = new Map();
let loginHooked = false;

function isChallengeScript(url) {
  return /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform\/|turnstile/i.test(String(url || ""));
}

function shouldBlockResource(type, url) {
  if (BLOCKED_TYPES.has(type)) return true;
  return type === "script" && !isChallengeScript(url);
}

function shouldReuseBrowser(open, launchedProxy, proxy) {
  return Boolean(open) && String(launchedProxy || "") === String(proxy || "");
}

function hiddenWindowOptions() {
  return {
    show: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    width: 1100,
    height: 800,
    webPreferences: {
      backgroundThrottling: false,
      offscreen: false,
      partition: "persist:leadfinder",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  };
}

function chromeUserAgent(raw, appName) {
  let ua = String(raw || "").replace(/\sElectron\/\S+/gi, "");
  const name = String(appName || "").trim();
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    ua = ua.replace(new RegExp(`\\s${escaped}\\/\\S+`, "gi"), "");
  }
  return ua.replace(/\s{2,}/g, " ").trim();
}

function sessionProxySettings(prepared) {
  if (!prepared || !prepared.proxy || !prepared.proxy.server) return { mode: "direct" };
  return { proxyRules: prepared.proxy.server };
}

// Reload immediately, then every few seconds. No clicks and no extra window.
async function reloadUntilClear({
  looksChallenged,
  reload,
  sleep,
  shouldStop,
  onReload,
  pauseMs = CHALLENGE_RELOAD_MS
}) {
  while (!(shouldStop && shouldStop())) {
    if (onReload) onReload();
    await reload();
    if (shouldStop && shouldStop()) return false;
    if (!(await looksChallenged())) return true;
    await sleep(pauseMs);
  }
  return false;
}

function waitMs(ms, shouldStop) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if ((shouldStop && shouldStop()) || Date.now() - started >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(200, ms - (Date.now() - started)));
    };
    tick();
  });
}

function electronApi() {
  const electron = require("electron");
  if (!electron || typeof electron !== "object" || !electron.BrowserWindow) {
    throw new Error("Скрытое окно доступно только внутри приложения");
  }
  return electron;
}

function hookProxyLogin(electron) {
  if (loginHooked) return;
  loginHooked = true;
  electron.app.on("login", (event, webContents, _details, authInfo, callback) => {
    if (!authInfo || !authInfo.isProxy || !webContents) return;
    const creds = proxyAuthByContents.get(webContents.id);
    if (!creds) return;
    event.preventDefault();
    callback(creds.username, creds.password);
  });
}

function blockHeavy(session) {
  if (!session || sessionsHooked.has(session)) return;
  sessionsHooked.add(session);
  session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    callback(shouldBlockResource(details.resourceType, details.url) ? { cancel: true } : {});
  });
}

function waitForLoad(contents, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contents.removeListener("did-finish-load", onFinish);
      contents.removeListener("did-fail-load", onFail);
      resolve();
    };
    const onFinish = () => finish();
    const onFail = (_event, _code, _desc, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    contents.once("did-finish-load", onFinish);
    contents.on("did-fail-load", onFail);
  });
}

function createBrowser({ entryUrl, onProgress, proxy }) {
  let win = null;
  let relay = null;
  let opening = null;
  let generation = 0;
  let crashed = false;
  let allowDestroy = false;
  const discarding = new WeakSet();
  let siteChain = Promise.resolve();
  let pageUa = "";
  let httpProxyUrl = "";

  function report(update) {
    if (onProgress) onProgress(update);
  }

  function discard(target) {
    if (!target || target.isDestroyed()) return;
    discarding.add(target);
    target.destroy();
  }

  function contents() {
    if (!win || win.isDestroyed()) return null;
    return win.webContents;
  }

  function isOpen() {
    return Boolean(contents() && !crashed);
  }

  function onSite(task) {
    const run = siteChain.then(task, task);
    siteChain = run.then(() => {}, () => {});
    return run;
  }

  async function applyProxy(target) {
    if (relay) {
      await relay.close().catch(() => {});
      relay = null;
    }
    const prepared = await prepareChromeProxy(proxy);
    relay = prepared;
    const page = target.webContents;
    if (prepared && prepared.proxy && prepared.proxy.username) {
      proxyAuthByContents.set(page.id, {
        username: prepared.proxy.username,
        password: prepared.proxy.password || ""
      });
    } else {
      proxyAuthByContents.delete(page.id);
    }
    await page.session.setProxy(sessionProxySettings(prepared));
    httpProxyUrl = proxyUrlForImpit(prepared);
  }

  async function open() {
    if (opening) return opening;
    const token = ++generation;
    opening = (async () => {
      let created = null;
      try {
        const { BrowserWindow, app } = electronApi();
        hookProxyLogin(require("electron"));
        if (token !== generation) return;
        report({ phase: "starting", message: "Запуск браузера…", progress: null });
        created = new BrowserWindow(hiddenWindowOptions());
        created.on("close", (event) => {
          if (allowDestroy || discarding.has(created)) return;
          event.preventDefault();
          if (!created.isDestroyed()) created.hide();
        });
        created.webContents.on("render-process-gone", () => {
          crashed = true;
        });
        created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        created.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
        const ua = chromeUserAgent(created.webContents.getUserAgent(), app.getName());
        pageUa = ua;
        created.webContents.setUserAgent(ua);
        await created.webContents.session.setUserAgent(ua, ACCEPT_LANGUAGE);
        blockHeavy(created.webContents.session);
        await applyProxy(created);
        if (token !== generation) return;
        win = created;
        crashed = false;
        const pending = waitForLoad(created.webContents, 90000);
        await created.loadURL(entryUrl).catch(() => {});
        await pending;
      } catch (error) {
        if (created && created !== win) discard(created);
        throw error;
      } finally {
        if (!win && created) discard(created);
        if (!win && relay) {
          await relay.close().catch(() => {});
          relay = null;
        }
        opening = null;
      }
    })();
    return opening;
  }

  async function close() {
    generation += 1;
    allowDestroy = true;
    const pending = opening;
    const current = win;
    win = null;
    crashed = true;
    if (pending) await pending.catch(() => {});
    if (current && !current.isDestroyed()) {
      proxyAuthByContents.delete(current.webContents.id);
      current.destroy();
    }
    if (relay) {
      const currentRelay = relay;
      relay = null;
      await currentRelay.close().catch(() => {});
    }
  }

  async function gotoEntry(target) {
    try {
      const pending = waitForLoad(target, 90000);
      await target.loadURL(entryUrl);
      await pending;
      return true;
    } catch {
      return false;
    }
  }

  async function pageLooksChallenged(target) {
    let title = "";
    try { title = target.getTitle() || ""; } catch { return true; }
    if (/just a moment/i.test(title)) return true;
    const html = await target.executeJavaScript(
      "document.documentElement ? document.documentElement.outerHTML : ''"
    ).catch(() => "");
    if (!html) {
      let loading = true;
      try { loading = target.isLoading(); } catch { loading = true; }
      if (loading || !title) return true;
    }
    return isChallengeHtml(html, title);
  }

  // Resolves on did-finish-load, or sooner once the challenge markup is gone.
  function waitForClearOrLoad(target, shouldStop) {
    return new Promise((resolve) => {
      let settled = false;
      let pollTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(pollTimer);
        target.removeListener("did-finish-load", onFinish);
        target.removeListener("did-fail-load", onFail);
        resolve();
      };
      const onFinish = () => finish();
      const onFail = (_event, _code, _desc, _url, isMainFrame) => {
        if (isMainFrame === false) return;
        finish();
      };
      const poll = () => {
        if (settled) return;
        if (shouldStop && shouldStop()) return finish();
        pageLooksChallenged(target).then((challenged) => {
          if (settled) return;
          if (!challenged) return finish();
          pollTimer = setTimeout(poll, 400);
        }).catch(() => {
          if (!settled) pollTimer = setTimeout(poll, 400);
        });
      };
      const timer = setTimeout(finish, 90000);
      pollTimer = setTimeout(poll, 400);
      target.once("did-finish-load", onFinish);
      target.on("did-fail-load", onFail);
    });
  }

  function documentUrl(target) {
    let current = "";
    try { current = target.getURL(); } catch { current = ""; }
    return /^https?:/i.test(current) ? current : entryUrl;
  }

  async function fetch(url, { xhr = false } = {}) {
    const target = contents();
    if (!isOpen() || !target) return { closed: true };
    const prelude = await onSite(async () => {
      let current = "";
      try { current = target.getURL(); } catch { current = ""; }
      const title = target.getTitle();
      if (!current.startsWith("https://www.myfxbook.com") || /just a moment/i.test(title)) {
        const ok = await gotoEntry(target);
        if (!ok) return { timeout: true };
        if (await pageLooksChallenged(target)) return { challenge: true };
      }
      return null;
    });
    if (prelude) return prelude;

    const script = `(() => {
      const targetUrl = ${JSON.stringify(url)};
      const useXhr = ${xhr ? "true" : "false"};
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      const headers = { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
      if (useXhr) headers["X-Requested-With"] = "XMLHttpRequest";
      return fetch(targetUrl, { credentials: "include", redirect: "follow", signal: ctrl.signal, headers })
        .then(async (res) => ({
          status: res.status,
          text: await res.text(),
          retryAfter: res.headers.get("retry-after") || "",
          cfMitigated: res.headers.get("cf-mitigated") || ""
        }))
        .catch((error) => ({ error: String(error && error.name || error), message: String(error && error.message || error) }))
        .finally(() => clearTimeout(timer));
    })()`;

    let result;
    try {
      result = await target.executeJavaScript(script, true);
    } catch (error) {
      if (!isOpen()) return { closed: true, error: String(error && error.message || error) };
      return { timeout: true, error: String(error && error.message || error) };
    }

    if (!result || result.error) return { timeout: true, error: result && result.message };
    const retryAfter = result.retryAfter || "";
    const body = { status: result.status, text: result.text, retryAfter };
    if (isHardBlockHtml(result.text)) return { blocked: true, ...body };
    if (isCloudflareChallenge({ ...body, headers: { "cf-mitigated": result.cfMitigated || "" } })) {
      return { challenge: true, ...body };
    }
    if (result.status === 403 || result.status === 429 || result.status === 408 || result.status >= 500) {
      return { blocked: true, status: result.status, text: result.text, retryAfter };
    }
    return { status: result.status, text: result.text, retryAfter };
  }

  async function showForChallenge(shouldStop) {
    const target = contents();
    if (!isOpen() || !target) return false;
    const cleared = await reloadUntilClear({
      looksChallenged: () => pageLooksChallenged(target),
      reload: async () => {
        if (target.isLoading()) {
          await waitForClearOrLoad(target, shouldStop);
          return;
        }
        const pending = waitForClearOrLoad(target, shouldStop);
        try { await target.loadURL(documentUrl(target)); } catch { /* did-fail-load settles the wait */ }
        await pending;
      },
      sleep: (ms) => waitMs(ms, shouldStop),
      shouldStop,
      onReload: () => report({ phase: "challenge", message: CHALLENGE_RELOAD_MESSAGE })
    });
    if (cleared) report({ phase: "running", message: "Проверка Cloudflare прошла, продолжаю поиск." });
    return cleared;
  }

  function sessionOf() {
    const page = contents();
    return page ? page.session : null;
  }

  async function cookieHeader(url) {
    const ses = sessionOf();
    if (!ses) return "";
    const list = await ses.cookies.get({ url });
    return list.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  async function writeCookie(line, url) {
    const ses = sessionOf();
    if (!ses) return;
    const details = parseSetCookie(line, url);
    if (!details) return;
    await ses.cookies.set(details).catch(() => {});
  }

  async function clearUrl(url, shouldStop) {
    const target = contents();
    if (!isOpen() || !target) return false;
    if (shouldStop && shouldStop()) return false;
    let current = "";
    try { current = target.getURL(); } catch { current = ""; }
    if (url && current !== url) {
      const pending = waitForClearOrLoad(target, shouldStop);
      try { await target.loadURL(url); } catch { /* did-fail-load settles the wait */ }
      await pending;
    }
    if (shouldStop && shouldStop()) return false;
    if (!(await pageLooksChallenged(target))) return true;
    return showForChallenge(shouldStop);
  }

  function showWindow() {
    if (!win || win.isDestroyed()) return false;
    win.show();
    return true;
  }

  return {
    open,
    close,
    fetch,
    showForChallenge,
    clearUrl,
    showWindow,
    isOpen,
    cookieHeader,
    writeCookie,
    userAgent: () => pageUa,
    acceptLanguage: () => ACCEPT_LANGUAGE,
    proxyUrl: () => httpProxyUrl
  };
}

module.exports = {
  createBrowser,
  shouldBlockResource,
  reloadUntilClear,
  shouldReuseBrowser,
  hiddenWindowOptions,
  chromeUserAgent,
  sessionProxySettings,
  CHALLENGE_RELOAD_MESSAGE,
  CHALLENGE_RELOAD_MS,
  ACCEPT_LANGUAGE
};
