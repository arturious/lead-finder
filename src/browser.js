const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { isChallengeHtml, isHardBlockHtml } = require("./parse");
const { prepareChromeProxy } = require("./proxy");

const BLOCKED_TYPES = new Set(["image", "media", "font"]);

function shouldBlockResource(type) {
  return BLOCKED_TYPES.has(type);
}

// Headless by default (Chrome's new headless, same binary and profile).
// A Cloudflare page is reloaded up to three times while still headless.
// Only then is a headed window opened, minimized until the click is needed.
// viewport stays null and userAgent is unset: both overrides are a fingerprint.

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

const CHALLENGE_ATTEMPTS = 3;

// 5–8 s on the first try, then the same span times the attempt number.
function challengeRetryDelayMs(attempt, random = Math.random) {
  const n = Math.min(CHALLENGE_ATTEMPTS, Math.max(1, Number(attempt) || 1));
  const roll = typeof random === "function" ? Number(random()) : Number(random);
  const unit = 5000 + 3000 * Math.min(1, Math.max(0, roll));
  return Math.round(unit * n);
}

function challengeAttemptMessage(attempt, total = CHALLENGE_ATTEMPTS) {
  return `Cloudflare: попытка ${attempt}/${total}…`;
}

// Playwright's headless:true swaps bundled Chromium for chromium-headless-shell,
// a different binary than the installed Google Chrome for Testing. Passing
// --headless=new keeps that binary and uses Chrome's new headless mode.
const HEADLESS_SWITCH_MESSAGE = "Проверка Cloudflare не прошла сама. Открываю окно браузера…";

function browserLaunchArgs({ headed, sandbox }) {
  const args = headed ? ["--start-minimized"] : ["--headless=new"];
  if (!sandbox) args.push("--no-sandbox", "--disable-dev-shm-usage");
  return args;
}

function shouldRelaunchHeaded(headed, clearedQuietly) {
  return !clearedQuietly && !headed;
}

// Wait, then reload. No clicks. True when the existing challenge check clears.
async function retryChallengeQuietly({
  looksChallenged,
  reload,
  sleep,
  shouldStop,
  onAttempt,
  attempts = CHALLENGE_ATTEMPTS,
  delayMs = challengeRetryDelayMs
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (shouldStop && shouldStop()) return false;
    if (onAttempt) onAttempt(attempt, attempts);
    await sleep(delayMs(attempt));
    if (shouldStop && shouldStop()) return false;
    if (!(await looksChallenged())) return true;
    await reload();
    if (shouldStop && shouldStop()) return false;
    if (!(await looksChallenged())) return true;
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
  let headed = false;
  let browserKind = "chrome";
  let siteChain = Promise.resolve();

  function report(update) {
    if (onProgress) onProgress(update);
  }

  async function placeWindow(target, visible) {
    if (!context || !target) return;
    try {
      const session = await context.newCDPSession(target);
      const { windowId } = await session.send("Browser.getWindowForTarget");
      if (visible) {
        await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
        await session.send("Browser.setWindowBounds", {
          windowId,
          bounds: { left: 80, top: 60, width: 1100, height: 800 }
        });
        await target.bringToFront().catch(() => {});
      } else {
        await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
      }
      await session.detach().catch(() => {});
    } catch {
      if (visible && target) await target.bringToFront().catch(() => {});
    }
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
      // false so Patchright keeps the full browser; new headless is an arg.
      headless: false,
      viewport: null,
      chromiumSandbox: sandbox,
      args: browserLaunchArgs({ headed, sandbox })
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
        headed = false;
        try {
          browserKind = "chrome";
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
          browserKind = "chromium";
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
        if (headed) await placeWindow(page, false);
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

  async function ensurePage() {
    if (page && context) return page;
    await open();
    return page;
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
    if (!target) return { timeout: true };
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

  async function waitUntilClear(shouldStop) {
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      if (shouldStop && shouldStop()) return false;
      if (!page) return false;
      if (!(await pageLooksChallenged(page))) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return false;
  }

  async function relaunchHeaded() {
    const token = generation;
    const current = context;
    context = null;
    page = null;
    if (current) await current.close().catch(() => {});
    if (token !== generation) return false;
    headed = true;
    let launched = null;
    try {
      launched = await launch(browserKind || "chromium");
    } catch {
      if (launched) await launched.close().catch(() => {});
      headed = false;
      return false;
    }
    if (token !== generation) {
      await launched.close().catch(() => {});
      return false;
    }
    context = launched;
    page = context.pages()[0] || await context.newPage();
    context.setDefaultTimeout(70000);
    page.setDefaultTimeout(70000);
    await blockHeavy(context);
    await placeWindow(page, false);
    return true;
  }

  async function showForChallenge(shouldStop) {
    const target = await ensurePage();
    if (!target) return false;
    if (headed) await placeWindow(target, false);
    if (!(await pageLooksChallenged(target))) {
      const ok = await gotoEntry(target);
      if (!ok) return false;
    }
    if (!(await pageLooksChallenged(target))) return true;
    const clearedQuietly = await retryChallengeQuietly({
      looksChallenged: () => pageLooksChallenged(target),
      reload: () => target.reload({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {}),
      sleep: (ms) => waitMs(ms, shouldStop),
      shouldStop,
      onAttempt: (attempt, total) => {
        report({ phase: "challenge", message: challengeAttemptMessage(attempt, total) });
      }
    });
    if (shouldStop && shouldStop()) return false;
    if (clearedQuietly) {
      if (headed) await placeWindow(target, false);
      report({ phase: "running", message: "Проверка Cloudflare прошла, продолжаю поиск." });
      return true;
    }
    if (shouldRelaunchHeaded(headed, clearedQuietly)) {
      report({ phase: "challenge", message: HEADLESS_SWITCH_MESSAGE });
      const switched = await relaunchHeaded();
      if (!switched || (shouldStop && shouldStop())) return false;
      if (!(await pageLooksChallenged(page))) {
        const ok = await gotoEntry(page);
        if (!ok) return false;
      }
    }
    await placeWindow(page, true);
    report({
      phase: "challenge",
      message: "Cloudflare «Just a moment». Пройдите проверку в окне браузера — поиск продолжится сам."
    });
    const cleared = await waitUntilClear(shouldStop);
    if (cleared && !(shouldStop && shouldStop())) await placeWindow(page, false);
    return cleared;
  }

  return { open, close, fetch, showForChallenge };
}

patchDriverFork();

module.exports = {
  createBrowser,
  parseInstallLine,
  isMissingChrome,
  shouldBlockResource,
  challengeRetryDelayMs,
  challengeAttemptMessage,
  retryChallengeQuietly,
  browserLaunchArgs,
  shouldRelaunchHeaded,
  HEADLESS_SWITCH_MESSAGE,
  CHALLENGE_ATTEMPTS
};
