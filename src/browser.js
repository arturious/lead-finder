const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { isChallengeHtml, isHardBlockHtml } = require("./parse");
const { prepareChromeProxy } = require("./proxy");

const BLOCKED_TYPES = new Set(["image", "media", "font"]);

function shouldBlockResource(type) {
  return BLOCKED_TYPES.has(type);
}

// Headed Chrome, parked off-screen for the whole app lifetime. A minimized
// window gets throttled and Cloudflare stalls, so the window stays normal
// and is never brought forward on its own. viewport stays null and userAgent
// is unset: both overrides are a fingerprint.

function parseInstallLine(line) {
  const text = String(line || "").replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!text) return null;
  const percent = text.match(/(\d{1,3})\s*%/);
  if (percent) {
    const value = Math.min(100, Number(percent[1]));
    return { phase: "download", progress: value, message: `Скачиваю Chromium: ${value}%` };
  }
  if (/^Downloading\b/i.test(text)) {
    return { phase: "download", progress: 0, message: "Скачиваю Chromium…" };
  }
  if (/downloaded to /i.test(text)) {
    return { phase: "download", progress: 100, message: "Chromium скачан" };
  }
  return null;
}

function isMissingChrome(error) {
  const msg = String((error && error.message) || error || "");
  return /Chromium distribution 'chrome' is not found/.test(msg)
    || /Chromium distribution 'chrome' is not supported/.test(msg);
}

function unpacked(file) {
  const marker = `${path.sep}app.asar${path.sep}`;
  if (!file.includes(marker)) return file;
  const candidate = file.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(candidate) ? candidate : file;
}

let forkPatched = false;
function patchDriverFork() {
  if (forkPatched) return;
  forkPatched = true;
  const childProcess = require("child_process");
  const original = childProcess.fork;
  childProcess.fork = function (modulePath, args, options) {
    if (typeof modulePath === "string" && modulePath.includes(`${path.sep}patchright`)) {
      modulePath = unpacked(modulePath);
      const baseEnv = (options && options.env) || process.env;
      options = { ...options, env: { ...baseEnv, ELECTRON_RUN_AS_NODE: "1" } };
    }
    return original.call(this, modulePath, args, options);
  };
}

function browsersDir(userDataDir) {
  return path.join(path.dirname(userDataDir), "browsers");
}

function chromiumProfileDir(userDataDir) {
  return path.join(path.dirname(userDataDir), "chromium-profile");
}

function patchrightCli() {
  return unpacked(path.join(path.dirname(require.resolve("patchright/package.json")), "cli.js"));
}

// Patchright leaves the sandbox off unless asked. Chrome then shows a bar
// about --no-sandbox. Keep the sandbox on. Only a Linux root process, which
// cannot start the sandbox, falls back. The Mac app does not.
function wantsSandbox() {
  if (process.platform !== "linux") return true;
  return typeof process.getuid !== "function" || process.getuid() !== 0;
}

const CHALLENGE_RELOAD_MS = 3000;
const CHALLENGE_RELOAD_MESSAGE = "Cloudflare: обновляю страницу…";

function shouldReuseBrowser(open, launchedProxy, proxy) {
  return Boolean(open) && String(launchedProxy || "") === String(proxy || "");
}

function browserLaunchArgs({ sandbox }) {
  const args = [
    "--window-position=-32000,-32000",
    "--window-size=480,360",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling"
  ];
  if (!sandbox) args.push("--no-sandbox", "--disable-dev-shm-usage");
  return args;
}

// Reload immediately, then every few seconds. No clicks and no window.
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

function installChromium(browsersPath, onProgress, isCancelled) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [patchrightCli(), "install", "chromium"], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PLAYWRIGHT_BROWSERS_PATH: browsersPath
      }
    });
    const take = (buf) => {
      for (const line of buf.toString().split(/[\r\n]+/)) {
        const parsed = parseInstallLine(line);
        if (parsed && onProgress) onProgress(parsed);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal || (isCancelled && isCancelled())) {
        resolve(false);
        return;
      }
      if (code === 0) resolve(true);
      else reject(new Error(`Не удалось скачать Chromium (код ${code == null ? "?" : code})`));
    });
    if (isCancelled) {
      const watch = setInterval(() => {
        if (!isCancelled()) return;
        clearInterval(watch);
        child.kill("SIGTERM");
      }, 200);
      child.on("exit", () => clearInterval(watch));
    }
  });
}

function createBrowser({ userDataDir, entryUrl, onProgress, proxy }) {
  let context = null;
  let page = null;
  let opening = null;
  let generation = 0;
  let relay = null;
  let siteChain = Promise.resolve();

  function report(update) {
    if (onProgress) onProgress(update);
  }

  async function setWindowBounds(target, bounds) {
    if (!context || !target) return false;
    try {
      const session = await context.newCDPSession(target);
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal", ...bounds }
      });
      await session.detach().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  function parkWindow(target) {
    return setWindowBounds(target, { left: -32000, top: -32000, width: 480, height: 360 });
  }

  function showWindow() {
    return setWindowBounds(page, { left: 80, top: 60, width: 1100, height: 800 });
  }

  async function launch(kind) {
    patchDriverFork();
    const browsersPath = browsersDir(userDataDir);
    fs.mkdirSync(browsersPath, { recursive: true });
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
    }
    const { chromium } = require("patchright");
    const dir = kind === "chrome" ? userDataDir : chromiumProfileDir(userDataDir);
    fs.mkdirSync(dir, { recursive: true });
    const sandbox = wantsSandbox();
    const options = {
      headless: false,
      viewport: null,
      chromiumSandbox: sandbox,
      args: browserLaunchArgs({ sandbox })
    };
    if (kind === "chrome") options.channel = "chrome";
    if (relay) options.proxy = relay.proxy;
    return chromium.launchPersistentContext(dir, options);
  }

  async function open() {
    if (opening) return opening;
    const token = ++generation;
    opening = (async () => {
      let launched = null;
      try {
        relay = await prepareChromeProxy(proxy);
        if (token !== generation) return;
        report({ phase: "starting", message: "Запуск Chrome…", progress: null });
        try {
          launched = await launch("chrome");
        } catch (error) {
          if (!isMissingChrome(error)) throw error;
          report({ phase: "download", message: "Google Chrome не найден. Скачиваю Chromium…", progress: 0 });
          const installed = await installChromium(
            process.env.PLAYWRIGHT_BROWSERS_PATH || browsersDir(userDataDir),
            report,
            () => token !== generation
          );
          if (!installed || token !== generation) return;
          report({ phase: "starting", message: "Запуск Chromium…", progress: null });
          launched = await launch("chromium");
        }
        if (token !== generation) {
          if (launched) await launched.close().catch(() => {});
          return;
        }
        context = launched;
        page = context.pages()[0] || await context.newPage();
        context.setDefaultTimeout(70000);
        page.setDefaultTimeout(70000);
        await blockHeavy(context);
        await parkWindow(page);
      } finally {
        if (!context && relay) {
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
    const pending = opening;
    const current = context;
    context = null;
    page = null;
    if (pending) await pending.catch(() => {});
    if (context) {
      const extra = context;
      context = null;
      page = null;
      await extra.close().catch(() => {});
    }
    if (current) await current.close().catch(() => {});
    if (relay) {
      const currentRelay = relay;
      relay = null;
      await currentRelay.close().catch(() => {});
    }
  }

  function isOpen() {
    try {
      return Boolean(context && page && !page.isClosed());
    } catch {
      return false;
    }
  }

  async function ensurePage() {
    if (isOpen()) return page;
    return null;
  }

  function onSite(task) {
    const run = siteChain.then(task, task);
    siteChain = run.then(() => {}, () => {});
    return run;
  }

  async function blockHeavy(ctx) {
    await ctx.route("**/*", (route) => {
      if (shouldBlockResource(route.request().resourceType())) return route.abort();
      return route.continue();
    }).catch(() => {});
  }

  async function gotoEntry(target) {
    try {
      await target.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
      return true;
    } catch {
      return false;
    }
  }

  async function pageLooksChallenged(target) {
    const title = await target.title().catch(() => "");
    if (/just a moment/i.test(title)) return true;
    const html = await target.content().catch(() => "");
    return isChallengeHtml(html, title);
  }

  async function fetch(url, { xhr = false } = {}) {
    const target = await ensurePage();
    if (!target) return { closed: true };
    const prelude = await onSite(async () => {
      let current = "";
      try { current = target.url(); } catch { current = ""; }
      const title = await target.title().catch(() => "");
      if (!current.startsWith("https://www.myfxbook.com") || /just a moment/i.test(title)) {
        const ok = await gotoEntry(target);
        if (!ok) return { timeout: true };
        if (await pageLooksChallenged(target)) return { challenge: true };
      }
      return null;
    });
    if (prelude) return prelude;

    let result;
    try {
      result = await target.evaluate(async ({ url: targetUrl, xhr: useXhr }) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 45000);
        try {
          const res = await fetch(targetUrl, {
            credentials: "include",
            redirect: "follow",
            signal: ctrl.signal,
            headers: Object.assign(
              { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
              useXhr ? { "X-Requested-With": "XMLHttpRequest" } : {}
            )
          });
          const text = await res.text();
          return { status: res.status, text };
        } catch (error) {
          return { error: String(error && error.name || error), message: String(error && error.message || error) };
        } finally {
          clearTimeout(timer);
        }
      }, { url, xhr: !!xhr });
    } catch (error) {
      if (!isOpen()) return { closed: true, error: String(error && error.message || error) };
      return { timeout: true, error: String(error && error.message || error) };
    }

    if (!result || result.error) return { timeout: true, error: result && result.message };
    if (isHardBlockHtml(result.text)) return { blocked: true, status: result.status, text: result.text };
    if (isChallengeHtml(result.text)) return { challenge: true, status: result.status, text: result.text };
    if (result.status === 403 || result.status === 429 || result.status === 408 || result.status >= 500) {
      return { blocked: true, status: result.status, text: result.text };
    }
    return { status: result.status, text: result.text };
  }

  async function showForChallenge(shouldStop) {
    const target = await ensurePage();
    if (!target) return false;
    const cleared = await reloadUntilClear({
      looksChallenged: () => pageLooksChallenged(target),
      reload: () => target.reload({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {}),
      sleep: (ms) => waitMs(ms, shouldStop),
      shouldStop,
      onReload: () => report({ phase: "challenge", message: CHALLENGE_RELOAD_MESSAGE })
    });
    if (cleared) report({ phase: "running", message: "Проверка Cloudflare прошла, продолжаю поиск." });
    return cleared;
  }

  return { open, close, fetch, showForChallenge, showWindow, isOpen };
}

patchDriverFork();

module.exports = {
  createBrowser,
  parseInstallLine,
  isMissingChrome,
  shouldBlockResource,
  reloadUntilClear,
  browserLaunchArgs,
  shouldReuseBrowser,
  CHALLENGE_RELOAD_MESSAGE,
  CHALLENGE_RELOAD_MS
};
