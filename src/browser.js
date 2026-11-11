const { isChallengeHtml, isHardBlockHtml } = require("./parse");

// launchPersistentContext keeps Cloudflare clearance in userDataDir.
// Headless until a "Just a moment" page shows up; then the window is shown
// so a person can pass the check, and the search continues on its own.

function hookConsole(onLine) {
  const original = console.error;
  console.error = (...args) => {
    const msg = args.map((part) => (typeof part === "string" ? part : (part && part.message) || "")).join(" ");
    if (msg.includes("[cloakbrowser]") || /download progress/i.test(msg)) onLine(msg);
    original.apply(console, args);
  };
  return () => {
    console.error = original;
  };
}

function createBrowser({ userDataDir, entryUrl, onProgress }) {
  let context = null;
  let page = null;
  let headless = true;
  let challengeStrikes = 0;
  let opening = null;
  let generation = 0;

  function note(line) {
    if (onProgress) onProgress(line);
  }

  async function open(nextHeadless) {
    if (opening) return opening;
    const token = ++generation;
    opening = (async () => {
      const restore = hookConsole(note);
      try {
        const { launchPersistentContext } = await import("cloakbrowser");
        const launched = await launchPersistentContext({
          userDataDir,
          headless: !!nextHeadless,
          args: nextHeadless ? [] : ["--window-size=1100,800"]
        });
        if (token !== generation) {
          await launched.close().catch(() => {});
          return;
        }
        context = launched;
        page = context.pages()[0] || await context.newPage();
        context.setDefaultTimeout(70000);
        page.setDefaultTimeout(70000);
        headless = !!nextHeadless;
      } finally {
        restore();
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
  }

  async function ensurePage() {
    if (page && context) return page;
    await open(headless);
    return page;
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
    let current = "";
    try { current = target.url(); } catch { current = ""; }
    const title = await target.title().catch(() => "");
    if (!current.startsWith("https://www.myfxbook.com") || /just a moment/i.test(title)) {
      const ok = await gotoEntry(target);
      if (!ok) return { timeout: true };
      if (await pageLooksChallenged(target)) return { challenge: true };
    }

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

  async function relaunch(nextHeadless, shouldStop) {
    await close();
    if (shouldStop && shouldStop()) return false;
    await open(nextHeadless);
    if (!page) return false;
    const ok = await gotoEntry(page);
    if (!ok) return false;
    return true;
  }

  async function showForChallenge(shouldStop) {
    challengeStrikes += 1;
    const opened = await relaunch(false, shouldStop);
    if (!opened) return false;
    const cleared = await waitUntilClear(shouldStop);
    if (!cleared || (shouldStop && shouldStop())) return false;
    if (challengeStrikes >= 2) return true;
    const back = await relaunch(true, shouldStop);
    if (!back) return false;
    if (await pageLooksChallenged(page)) {
      challengeStrikes = 2;
      const shown = await relaunch(false, shouldStop);
      if (!shown) return false;
      return waitUntilClear(shouldStop);
    }
    return true;
  }

  return { open, close, fetch, showForChallenge };
}

module.exports = { createBrowser };
