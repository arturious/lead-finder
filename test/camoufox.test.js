const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const {
  normalizeHttpEngine,
  engineMode,
  fallbackEngine,
  parseSidecarLine,
  toFetchResult,
  locateCamoufox,
  createCamoufoxClient
} = require("../src/camoufox");

test("camoufox is the default engine and window and impit stay selectable", () => {
  assert.equal(normalizeHttpEngine(undefined), "camoufox");
  assert.equal(normalizeHttpEngine("other"), "camoufox");
  assert.equal(normalizeHttpEngine("camoufox"), "camoufox");
  assert.equal(normalizeHttpEngine("window"), "window");
  assert.equal(normalizeHttpEngine("impit"), "impit");
  assert.equal(engineMode("camoufox"), "camoufox");
  assert.equal(engineMode("window"), "window");
  assert.equal(engineMode("impit"), "http");
  assert.equal(fallbackEngine("camoufox", "no python"), "window");
  assert.equal(fallbackEngine("camoufox", ""), "camoufox");
  assert.equal(fallbackEngine("impit", "no python"), "impit");
});

test("a missing venv tells you to run the setup script", () => {
  const found = locateCamoufox(path.join(os.tmpdir(), "lead-finder-no-venv"));
  assert.match(found.error, /npm run setup:camoufox/);
});

test("sidecar lines become the same fetch result the engine already uses", () => {
  assert.equal(parseSidecarLine("  "), null);
  assert.deepEqual(parseSidecarLine('{"ready":true}'), { type: "ready", ready: true, error: "" });
  assert.equal(parseSidecarLine('{"ready":false,"error":"no module"}').error, "no module");
  const page = parseSidecarLine('{"id":2,"status":200,"html":"<html>a</html>","finalUrl":"https://x","ms":700,"challenge":false}');
  assert.equal(page.type, "response");
  assert.equal(page.ms, 700);
  assert.deepEqual(toFetchResult(page), { status: 200, text: "<html>a</html>", retryAfter: "", ms: 700 });
  const challenge = toFetchResult(parseSidecarLine('{"id":1,"status":403,"html":"Just a moment","ms":1200,"challenge":true}'));
  assert.equal(challenge.challenge, true);
  assert.equal(challenge.blocked, undefined);
  const limited = toFetchResult(parseSidecarLine('{"id":3,"status":429,"html":"slow","ms":10,"challenge":false}'));
  assert.equal(limited.blocked, true);
  const broken = toFetchResult(parseSidecarLine('{"id":4,"status":0,"html":"","ms":5,"error":"timeout"}'));
  assert.equal(broken.timeout, true);
});

test("the client pairs responses by id and restarts when the proxy changes", async () => {
  const client = createCamoufoxClient({
    command: process.execPath,
    args: [path.join(__dirname, "fixtures", "fake-sidecar.js")],
    profileDir: os.tmpdir(),
    proxy: "socks5://user:secret@127.0.0.1:1080",
    log() {}
  });
  try {
    const [first, second] = await Promise.all([
      client.fetch("https://www.myfxbook.com/members/a"),
      client.fetch("https://www.myfxbook.com/members/b")
    ]);
    assert.equal(first.status, 200);
    assert.match(first.text, /socks5:\/\/user:secret@127\.0\.0\.1:1080/);
    assert.equal(second.status, 200);
    const blocked = await client.fetch("https://www.myfxbook.com/cdn-cgi/challenge");
    assert.equal(blocked.challenge, true);
    assert.equal(blocked.status, 403);
    await client.useProxy("http://127.0.0.1:8080");
    const next = await client.fetch("https://www.myfxbook.com/contests");
    assert.match(next.text, /http:\/\/127\.0\.0\.1:8080/);
  } finally {
    await client.close();
  }
});
