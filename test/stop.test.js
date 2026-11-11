const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createEngine } = require("../src/engine");
const { createStore } = require("../src/store");

test("stop settles a camoufox run within a second while the sidecar and window are stuck", async () => {
  const file = path.join(os.tmpdir(), `lf-stop-${Date.now()}.json`);
  const mark = path.join(os.tmpdir(), `lf-stop-mark-${Date.now()}`);
  const store = createStore(file);
  let opens = 0;
  const engine = createEngine({
    store,
    profileDir: os.tmpdir(),
    emit() {},
    browserFactory() {
      return {
        open() {
          opens += 1;
          return new Promise(() => {});
        },
        abortLoad() {},
        close: async () => {},
        isOpen: () => false,
        fetch: () => new Promise(() => {}),
        clearUrl: () => new Promise(() => {}),
        showForChallenge: () => new Promise(() => {}),
        showWindow: () => false,
        cookieHeader: async () => "",
        writeCookie: async () => {},
        userAgent: () => "Mozilla/5.0",
        acceptLanguage: () => "en-US",
        proxyUrl: () => ""
      };
    },
    camoufoxCommand: {
      command: process.execPath,
      args: [path.join(__dirname, "fixtures", "hang-sidecar.js")]
    }
  });
  const previous = process.env.HANG_MARK;
  process.env.HANG_MARK = mark;
  const run = engine.start({ siteId: "myfxbook", country: "Thailand" });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(mark)) {
      if (Date.now() > deadline) throw new Error("search never reached the sidecar");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const started = Date.now();
    engine.stop();
    await Promise.race([
      run,
      new Promise((_, reject) => setTimeout(() => reject(new Error("stop too slow")), 1000))
    ]);
    assert.ok(Date.now() - started < 1000);
    assert.equal(opens, 0);
    assert.equal(engine.snapshot().running, false);
  } finally {
    if (previous == null) delete process.env.HANG_MARK;
    else process.env.HANG_MARK = previous;
    await engine.shutdown();
    fs.rmSync(file, { force: true });
    fs.rmSync(mark, { force: true });
  }
});
