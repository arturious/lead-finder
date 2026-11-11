// npm 11 skips a dependency install script until allowScripts lists it, and on
// Node 26 electron's extract-zip can exit 0 after writing only a fragment and
// no path.txt. This puts the cached zip back with ditto (macOS) or unzip.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const MIN_BINARY = 1024 * 1024;

function platformPath(platform) {
  if (platform === "darwin" || platform === "mas") return "Electron.app/Contents/MacOS/Electron";
  if (platform === "win32") return "electron.exe";
  return "electron";
}

function defaultCacheRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.env.electron_config_cache) roots.push(process.env.electron_config_cache);
  if (process.platform === "darwin") roots.push(path.join(home, "Library", "Caches", "electron"));
  else if (process.platform === "win32") {
    roots.push(path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "electron", "Cache"));
  } else {
    roots.push(path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "electron"));
  }
  return roots;
}

function zipName(version, platform, arch) {
  return `electron-v${String(version).replace(/^v/, "")}-${platform}-${arch}.zip`;
}

function extractTool(platform = process.platform) {
  return platform === "darwin" ? "ditto" : "unzip";
}

function findZip(name, roots) {
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name === name) return full;
      }
    }
  }
  return null;
}

function installLooksGood(electronDir, version, rel) {
  try {
    const got = fs.readFileSync(path.join(electronDir, "dist", "version"), "utf8").replace(/^v/, "").trim();
    if (got !== String(version).replace(/^v/, "")) return false;
    if (fs.readFileSync(path.join(electronDir, "path.txt"), "utf8") !== rel) return false;
    const stat = fs.statSync(path.join(electronDir, "dist", rel));
    return stat.isFile() && stat.size >= MIN_BINARY;
  } catch {
    return false;
  }
}

function extractZip(zipPath, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const attempts = process.platform === "darwin"
    ? [["ditto", ["-x", "-k", zipPath, dest]], ["unzip", ["-q", "-o", zipPath, "-d", dest]]]
    : [["unzip", ["-q", "-o", zipPath, "-d", dest]]];
  let detail = "";
  for (const [cmd, args] of attempts) {
    const result = spawnSync(cmd, args, { encoding: "utf8" });
    if (result.status === 0) return;
    detail = (result.stderr || (result.error && result.error.message) || "").trim();
    if (result.error && result.error.code === "ENOENT") continue;
  }
  throw new Error(`Could not extract Electron${detail ? `: ${detail}` : ""}`);
}

async function downloadZip(version, platform, arch) {
  const { downloadArtifact } = require("@electron/get");
  return downloadArtifact({
    version: String(version).replace(/^v/, ""),
    artifactName: "electron",
    platform,
    arch
  });
}

async function repairElectron(options = {}) {
  const electronDir = options.electronDir || path.dirname(require.resolve("electron/package.json"));
  const version = String(options.version || require(path.join(electronDir, "package.json")).version).replace(/^v/, "");
  const platform = options.platform || process.env.npm_config_platform || process.platform;
  const arch = options.arch || process.env.npm_config_arch || process.arch;
  const rel = platformPath(platform);
  if (installLooksGood(electronDir, version, rel)) return { ok: true, repaired: false };

  const name = zipName(version, platform, arch);
  let zipPath = findZip(name, options.cacheRoots || defaultCacheRoots());
  if (!zipPath && options.download !== false) zipPath = await downloadZip(version, platform, arch);
  if (!zipPath) throw new Error(`Electron zip ${name} is not in the cache and could not be downloaded.`);

  const dist = path.join(electronDir, "dist");
  extractZip(zipPath, dist);
  const typeSrc = path.join(dist, "electron.d.ts");
  if (fs.existsSync(typeSrc)) fs.renameSync(typeSrc, path.join(electronDir, "electron.d.ts"));
  fs.writeFileSync(path.join(electronDir, "path.txt"), rel);
  if (!installLooksGood(electronDir, version, rel)) {
    throw new Error("Electron archive extracted, but the binary is still missing.");
  }
  return { ok: true, repaired: true };
}

if (require.main === module) {
  repairElectron().then((result) => {
    if (result.repaired) console.log("Repaired the Electron binary from the cached zip.");
  }).catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  repairElectron,
  installLooksGood,
  platformPath,
  zipName,
  extractTool,
  findZip,
  MIN_BINARY
};
