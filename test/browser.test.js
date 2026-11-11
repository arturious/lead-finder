const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseInstallLine,
  isMissingChrome,
  challengeRetryDelayMs,
  challengeAttemptMessage,
  retryChallengeQuietly,
  browserLaunchArgs,
  shouldRelaunchHeaded,
  HEADLESS_SWITCH_MESSAGE
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

test("only a missing system Chrome falls back to Chromium", () => {
  const missing = new Error("Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\nRun \"npx patchright install chrome\"");
  assert.equal(isMissingChrome(missing), true);
  assert.equal(isMissingChrome(new Error("Chromium distribution 'chrome' is not supported on linux")), true);
  assert.equal(isMissingChrome(new Error("net::ERR_CONNECTION_RESET")), false);
  assert.equal(isMissingChrome(new Error("browserType.launchPersistentContext: Target closed")), false);
});

test("cloudflare challenge reloads with a growing pause before the window is shown", async () => {
  assert.equal(challengeRetryDelayMs(1, () => 0), 5000);
  assert.equal(challengeRetryDelayMs(1, () => 1), 8000);
  assert.equal(challengeRetryDelayMs(2, () => 0), 10000);
  assert.equal(challengeRetryDelayMs(3, () => 1), 24000);
  assert.equal(challengeAttemptMessage(2), "Cloudflare: попытка 2/3…");

  const pauses = [];
  let reloads = 0;
  let challenged = true;
  const cleared = await retryChallengeQuietly({
    looksChallenged: async () => challenged,
    reload: async () => {
      reloads += 1;
      if (reloads === 2) challenged = false;
    },
    sleep: async (ms) => { pauses.push(ms); },
    delayMs: (attempt) => challengeRetryDelayMs(attempt, () => 0),
    onAttempt: (attempt, total) => {
      pauses.push(challengeAttemptMessage(attempt, total));
    }
  });
  assert.equal(cleared, true);
  assert.equal(reloads, 2);
  assert.deepEqual(pauses, [
    "Cloudflare: попытка 1/3…",
    5000,
    "Cloudflare: попытка 2/3…",
    10000
  ]);

  let stuckReloads = 0;
  const stuck = await retryChallengeQuietly({
    looksChallenged: async () => true,
    reload: async () => { stuckReloads += 1; },
    sleep: async () => {},
    delayMs: () => 0,
    onAttempt: () => {}
  });
  assert.equal(stuck, false);
  assert.equal(stuckReloads, 3);

  let stoppedReloads = 0;
  const stopped = await retryChallengeQuietly({
    shouldStop: () => true,
    looksChallenged: async () => true,
    reload: async () => { stoppedReloads += 1; },
    sleep: async () => {},
    onAttempt: () => {}
  });
  assert.equal(stopped, false);
  assert.equal(stoppedReloads, 0);
});

test("search starts in new headless and opens a window only after quiet retries fail", () => {
  assert.deepEqual(browserLaunchArgs({ headed: false, sandbox: true }), ["--headless=new"]);
  assert.deepEqual(browserLaunchArgs({ headed: true, sandbox: true }), ["--start-minimized"]);
  assert.deepEqual(browserLaunchArgs({ headed: false, sandbox: false }), ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage"]);
  assert.equal(shouldRelaunchHeaded(false, true), false);
  assert.equal(shouldRelaunchHeaded(false, false), true);
  assert.equal(shouldRelaunchHeaded(true, false), false);
  assert.match(HEADLESS_SWITCH_MESSAGE, /Открываю окно/);
});
