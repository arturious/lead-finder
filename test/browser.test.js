const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseInstallLine,
  isMissingChrome,
  shouldBlockResource,
  reloadUntilClear,
  browserLaunchArgs,
  shouldReuseBrowser,
  CHALLENGE_RELOAD_MESSAGE,
  CHALLENGE_RELOAD_MS
} = require("../src/browser");

test("chromium download progress is a status update", () => {
  const started = parseInstallLine("Downloading Chromium 131.0.6778.33 (playwright build v1148) from https://example.test/chrome");
  assert.equal(started.phase, "download");
  assert.equal(started.progress, 0);

  const bar = parseInstallLine("|■■■■■■■■                                                                                |  10% of 170.2 MiB");
  assert.equal(bar.progress, 10);
  assert.match(bar.message, /10%/);

  const done = parseInstallLine("Chromium 131.0.6778.33 (playwright build v1148) downloaded to /tmp/browsers/chromium");
  assert.equal(done.progress, 100);
  assert.equal(parseInstallLine(""), null);
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

test("only a missing system Chrome falls back to Chromium", () => {
  const missing = new Error("Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\nRun \"npx patchright install chrome\"");
  assert.equal(isMissingChrome(missing), true);
  assert.equal(isMissingChrome(new Error("Chromium distribution 'chrome' is not supported on linux")), true);
  assert.equal(isMissingChrome(new Error("net::ERR_CONNECTION_RESET")), false);
  assert.equal(isMissingChrome(new Error("browserType.launchPersistentContext: Target closed")), false);
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

test("the browser launches headed, off-screen, and is not minimized", () => {
  const args = browserLaunchArgs({ sandbox: true });
  assert.equal(args.includes("--headless=new"), false);
  assert.equal(args.includes("--start-minimized"), false);
  assert.ok(args.includes("--window-position=-32000,-32000"));
  assert.ok(args.includes("--window-size=480,360"));
  assert.ok(args.includes("--disable-backgrounding-occluded-windows"));
  assert.ok(args.includes("--disable-renderer-backgrounding"));
  assert.ok(args.includes("--disable-background-timer-throttling"));
  assert.ok(browserLaunchArgs({ sandbox: false }).includes("--no-sandbox"));
});
