const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isNewer, pickDmg, updateScript, checkForUpdate, fetchCamoufoxBrowser } = (() => {
  const update = require("../src/update");
  return { ...update, fetchCamoufoxBrowser: require("../src/camoufox").fetchCamoufoxBrowser };
})();
const { locateCamoufox } = require("../src/camoufox");

test("a release is newer only when its version is greater", () => {
  assert.equal(isNewer("v1.0.1", "1.0.0"), true);
  assert.equal(isNewer("2.0.0", "v1.9.9"), true);
  assert.equal(isNewer("v1.0.0", "1.0.0"), false);
  assert.equal(isNewer("1.0.0", "1.0.1"), false);
  assert.equal(isNewer("latest", "1.0.0"), false);
  assert.equal(isNewer("1.0.0", ""), false);
});

test("the arm64 dmg is the update asset", () => {
  const release = {
    tag_name: "v1.1.0",
    assets: [
      { name: "Lead-Finder-x64-mac.dmg", browser_download_url: "https://example.test/x64.dmg" },
      { name: "Lead-Finder-arm64-mac.zip", browser_download_url: "https://example.test/arm.zip" },
      { name: "Lead-Finder-arm64-mac.dmg", browser_download_url: "https://example.test/arm.dmg" }
    ]
  };
  assert.equal(pickDmg(release), "https://example.test/arm.dmg");
  assert.equal(pickDmg({ assets: [] }), "");
  assert.equal(pickDmg({ assets: [{ name: "Lead-Finder.dmg", browser_download_url: "https://example.test/any.dmg" }] }), "https://example.test/any.dmg");
});

test("checking a release compares it with the running version", async () => {
  const newer = await checkForUpdate("1.0.0", async () => ({
    tag_name: "v1.2.0",
    assets: [{ name: "Lead-Finder-arm64-mac.dmg", browser_download_url: "https://example.test/arm.dmg" }]
  }));
  assert.equal(newer.ok, true);
  assert.equal(newer.update, true);
  assert.equal(newer.latest, "1.2.0");
  assert.equal(newer.url, "https://example.test/arm.dmg");

  const same = await checkForUpdate("1.2.0", async () => ({
    tag_name: "v1.2.0",
    assets: [{ name: "Lead-Finder-arm64-mac.dmg", browser_download_url: "https://example.test/arm.dmg" }]
  }));
  assert.equal(same.update, false);

  const failed = await checkForUpdate("1.0.0", async () => {
    throw new Error("offline");
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.update, false);
  assert.match(failed.error, /Не удалось проверить/);
});

test("the unsigned updater mounts the dmg, replaces the bundle, and strips quarantine", () => {
  const script = updateScript({
    pid: 42,
    dmg: "/tmp/Lead Finder.dmg",
    bundle: "/Applications/Lead Finder.app"
  });
  assert.match(script, /hdiutil attach/);
  assert.match(script, /ditto "\$SRC" "\$DEST"/);
  assert.match(script, /xattr -dr com\.apple\.quarantine/);
  assert.match(script, /open "\$DMG"/);
  assert.match(script, /\/tmp\/Lead Finder\.dmg/);
  assert.match(script, /\/Applications\/Lead Finder\.app/);
  assert.match(script, /\/Volumes\/\*\) DEST="\/Applications\/Lead Finder\.app"/);
});

test("a bundled sidecar is used when the venv is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lf-sidecar-"));
  const resources = path.join(root, "Resources");
  fs.mkdirSync(resources);
  const bin = path.join(resources, "camoufox-sidecar");
  fs.writeFileSync(bin, "");
  const found = locateCamoufox(path.join(root, "app"), resources);
  assert.equal(found.command, bin);
  assert.deepEqual(found.args, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("fetch-browser exits before the sidecar serves", () => {
  const script = path.join(os.tmpdir(), `lf-fetch-${Date.now()}.js`);
  fs.writeFileSync(script, "process.exit(process.argv.includes('--fetch-browser') ? 0 : 7);\n");
  const job = fetchCamoufoxBrowser(process.execPath, [script]);
  return job.promise.finally(() => fs.rmSync(script, { force: true }));
});
