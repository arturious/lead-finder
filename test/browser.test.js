const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldBlockResource,
  reloadUntilClear,
  shouldReuseBrowser,
  hiddenWindowOptions,
  chromeUserAgent,
  sessionProxySettings,
  CHALLENGE_RELOAD_MESSAGE,
  CHALLENGE_RELOAD_MS,
  ACCEPT_LANGUAGE
} = require("../src/browser");

test("the search window stays inside the app and hidden", () => {
  const options = hiddenWindowOptions();
  assert.equal(options.show, false);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.paintWhenInitiallyHidden, true);
  assert.equal(options.webPreferences.backgroundThrottling, false);
  assert.equal(options.webPreferences.offscreen, false);
  assert.equal(options.webPreferences.partition, "persist:leadfinder");
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
});

test("the user agent looks like Chrome, without Electron or the app name", () => {
  const raw = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36 Lead Finder/1.0.0";
  assert.equal(
    chromeUserAgent(raw, "Lead Finder"),
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36"
  );
  assert.equal(ACCEPT_LANGUAGE, "en-US,en;q=0.9");
});

test("proxy rules point at the forwarder for authenticated socks and direct otherwise", () => {
  assert.deepEqual(sessionProxySettings(null), { mode: "direct" });
  assert.deepEqual(sessionProxySettings({ proxy: { server: "socks5://127.0.0.1:1080" } }), {
    proxyRules: "socks5://127.0.0.1:1080"
  });
  assert.deepEqual(sessionProxySettings({ proxy: { server: "http://127.0.0.1:54321", username: "u", password: "p" } }), {
    proxyRules: "http://127.0.0.1:54321"
  });
});

test("images, media and fonts are blocked, scripts and styles are not", () => {
  assert.equal(shouldBlockResource("image"), true);
  assert.equal(shouldBlockResource("media"), true);
  assert.equal(shouldBlockResource("font"), true);
  assert.equal(shouldBlockResource("script"), false);
  assert.equal(shouldBlockResource("stylesheet"), false);
  assert.equal(shouldBlockResource("xhr"), false);
  assert.equal(shouldBlockResource("fetch"), false);
  assert.equal(shouldBlockResource("document"), false);
});

test("cloudflare reloads immediately, then every 3 seconds, until it clears", async () => {
  assert.equal(CHALLENGE_RELOAD_MS, 3000);
  assert.equal(CHALLENGE_RELOAD_MESSAGE, "Cloudflare: обновляю страницу…");

  const steps = [];
  let challenged = true;
  const cleared = await reloadUntilClear({
    looksChallenged: async () => challenged,
    reload: async () => {
      steps.push("reload");
      if (steps.filter((step) => step === "reload").length === 2) challenged = false;
    },
    sleep: async (ms) => { steps.push(ms); },
    onReload: () => { steps.push(CHALLENGE_RELOAD_MESSAGE); },
    pauseMs: CHALLENGE_RELOAD_MS
  });
  assert.equal(cleared, true);
  assert.deepEqual(steps, [
    CHALLENGE_RELOAD_MESSAGE,
    "reload",
    3000,
    CHALLENGE_RELOAD_MESSAGE,
    "reload"
  ]);

  let stoppedReloads = 0;
  const stopped = await reloadUntilClear({
    shouldStop: () => true,
    looksChallenged: async () => true,
    reload: async () => { stoppedReloads += 1; },
    sleep: async () => {},
    onReload: () => {}
  });
  assert.equal(stopped, false);
  assert.equal(stoppedReloads, 0);
});

test("the hidden browser is reused until the proxy changes or it closes", () => {
  assert.equal(shouldReuseBrowser(true, "socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080"), true);
  assert.equal(shouldReuseBrowser(true, "", ""), true);
  assert.equal(shouldReuseBrowser(true, "", "socks5://127.0.0.1:1080"), false);
  assert.equal(shouldReuseBrowser(false, "socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080"), false);
});

