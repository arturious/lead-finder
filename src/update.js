const fs = require("fs");
const https = require("https");

const RELEASE_API = "https://api.github.com/repos/arturious/lead-finder/releases/latest";

function parseVersion(value) {
  const match = String(value || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewer(latest, current) {
  const next = parseVersion(latest);
  const now = parseVersion(current);
  if (!next || !now) return false;
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== now[i]) return next[i] > now[i];
  }
  return false;
}

function pickDmg(release) {
  const assets = release && Array.isArray(release.assets) ? release.assets : [];
  const arm = assets.find((asset) => /arm64/i.test(asset.name || "") && /\.dmg$/i.test(asset.name || ""));
  const any = arm || assets.find((asset) => /\.dmg$/i.test(asset.name || ""));
  return any && any.browser_download_url ? any.browser_download_url : "";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function updateScript({ pid, dmg, bundle }) {
  const id = Number(pid);
  return `#!/bin/bash
set -u
PID=${Number.isFinite(id) ? id : 0}
DMG=${shellQuote(dmg)}
DEST=${shellQuote(bundle)}
case "$DEST" in
  /Volumes/*) DEST="/Applications/Lead Finder.app" ;;
esac
PARENT=$(dirname "$DEST")
if [ ! -d "$PARENT" ] || [ ! -w "$PARENT" ]; then
  DEST="/Applications/Lead Finder.app"
fi
MOUNT=$(mktemp -d)
if ! hdiutil attach -nobrowse -mountpoint "$MOUNT" "$DMG"; then
  open "$DMG"
  rm -rf "$MOUNT"
  exit 0
fi
SRC=$(find "$MOUNT" -name '*.app' -maxdepth 3 -print -quit)
if [ -z "$SRC" ]; then
  hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
  rm -rf "$MOUNT"
  open "$DMG"
  exit 0
fi
while kill -0 "$PID" 2>/dev/null; do
  sleep 0.3
done
rm -rf "$DEST"
ditto "$SRC" "$DEST"
xattr -dr com.apple.quarantine "$DEST" || true
hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
rm -rf "$MOUNT"
open "$DEST"
`;
}

function request(url, dest, redirects) {
  const left = redirects == null ? 5 : redirects;
  return new Promise((resolve, reject) => {
    if (left < 0) {
      reject(new Error("too many redirects"));
      return;
    }
    const req = https.get(url, {
      headers: {
        Accept: dest ? "application/octet-stream" : "application/vnd.github+json",
        "User-Agent": "lead-finder"
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(request(res.headers.location, dest, left - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(dest ? `download ${res.statusCode}` : `GitHub ${res.statusCode}`));
        return;
      }
      if (!dest) {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(dest)));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function checkForUpdate(current, fetchRelease) {
  const load = fetchRelease || (() => request(RELEASE_API));
  try {
    const release = await load();
    const tag = (release && (release.tag_name || release.name)) || "";
    const url = pickDmg(release);
    return {
      ok: true,
      current: String(current || ""),
      latest: String(tag).replace(/^v/i, ""),
      update: Boolean(url) && isNewer(tag, current),
      url
    };
  } catch {
    return {
      ok: false,
      current: String(current || ""),
      latest: "",
      update: false,
      url: "",
      error: "Не удалось проверить обновления"
    };
  }
}

module.exports = {
  RELEASE_API,
  parseVersion,
  isNewer,
  pickDmg,
  updateScript,
  checkForUpdate,
  downloadFile: (url, dest) => request(url, dest)
};
