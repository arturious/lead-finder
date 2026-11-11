const test = require("node:test");
const assert = require("node:assert/strict");
const { parseInstallLine, isMissingChrome } = require("../src/browser");

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
