const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { repairElectron, extractTool, installLooksGood, MIN_BINARY } = require("../scripts/repair-electron");

function makeZip(dir) {
  const stage = path.join(dir, "stage");
  fs.mkdirSync(path.join(stage, "Electron.app", "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(stage, "version"), "9.9.9\n");
  fs.writeFileSync(
    path.join(stage, "Electron.app", "Contents", "MacOS", "Electron"),
    Buffer.alloc(MIN_BINARY + 8)
  );
  const zipPath = path.join(dir, "cache", "ab", "electron-v9.9.9-darwin-arm64.zip");
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const packed = spawnSync("python3", ["-c", `
import zipfile, sys
root, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dest, "w") as z:
    for base, dirs, files in __import__("os").walk(root):
        for name in files:
            full = __import__("os").path.join(base, name)
            z.write(full, __import__("os").path.relpath(full, root))
`, stage, zipPath], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  return zipPath;
}

test("extract tool is ditto on macOS and unzip elsewhere", () => {
  assert.equal(extractTool("darwin"), "ditto");
  assert.equal(extractTool("linux"), "unzip");
});

test("a partial electron install is replaced from the cached zip", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lf-electron-"));
  const electronDir = path.join(root, "electron");
  fs.mkdirSync(path.join(electronDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(electronDir, "package.json"), JSON.stringify({ version: "9.9.9" }));
  fs.writeFileSync(path.join(electronDir, "dist", "version"), "9.9.9");
  fs.writeFileSync(path.join(electronDir, "dist", "fragment"), Buffer.alloc(256 * 1024));
  makeZip(root);

  const first = await repairElectron({
    electronDir,
    version: "9.9.9",
    platform: "darwin",
    arch: "arm64",
    cacheRoots: [path.join(root, "cache")],
    download: false
  });
  assert.equal(first.repaired, true);
  assert.equal(fs.readFileSync(path.join(electronDir, "path.txt"), "utf8"), "Electron.app/Contents/MacOS/Electron");
  assert.equal(installLooksGood(electronDir, "9.9.9", "Electron.app/Contents/MacOS/Electron"), true);
  assert.equal(fs.existsSync(path.join(electronDir, "dist", "fragment")), false);

  const second = await repairElectron({
    electronDir,
    version: "9.9.9",
    platform: "darwin",
    arch: "arm64",
    cacheRoots: [path.join(root, "cache")],
    download: false
  });
  assert.equal(second.repaired, false);
});
