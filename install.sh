#!/usr/bin/env bash
# Install the latest unsigned Lead Finder build into /Applications.
#   curl -fsSL https://raw.githubusercontent.com/arturious/lead-finder/main/install.sh | bash
set -euo pipefail

REPO="arturious/lead-finder"
DEST="/Applications/Lead Finder.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Этот установщик только для macOS." >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Эта сборка для Apple Silicon (arm64)." >&2
  exit 1
fi

API="https://api.github.com/repos/${REPO}/releases/latest"
URL="$(curl -fsSL "$API" | python3 -c '
import json, sys
data = json.load(sys.stdin)
assets = data.get("assets") or []

def pick(ext):
    for asset in assets:
        name = asset.get("name") or ""
        if name.endswith(ext) and "arm64" in name:
            print(asset["browser_download_url"])
            return True
    return False

if pick(".dmg") or pick(".zip"):
    raise SystemExit
raise SystemExit(1)
')" || {
  echo "В последнем релизе ${REPO} нет DMG или zip для arm64." >&2
  exit 1
}

TMP="$(mktemp -d)"
trap 'hdiutil detach "$TMP/mnt" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
if [[ "$URL" == *.dmg ]]; then
  mkdir -p "$TMP/mnt"
  curl -fL --progress-bar "$URL" -o "$TMP/LeadFinder.dmg"
  hdiutil attach -nobrowse -mountpoint "$TMP/mnt" "$TMP/LeadFinder.dmg"
  APP="$(find "$TMP/mnt" -name '*.app' -maxdepth 3 -print -quit)"
else
  curl -fL --progress-bar "$URL" -o "$TMP/LeadFinder.zip"
  unzip -q "$TMP/LeadFinder.zip" -d "$TMP/unpacked"
  APP="$(find "$TMP/unpacked" -name '*.app' -maxdepth 3 -print -quit)"
fi
if [[ -z "${APP}" ]]; then
  echo "В сборке нет .app" >&2
  exit 1
fi
rm -rf "$DEST"
ditto "$APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" || true
echo "Готово: $DEST"
echo "Поиск идёт внутри приложения, отдельный Chrome не нужен. Ключ не нужен."
echo "Если macOS не даёт открыть непроверенное приложение, выполните:"
echo "  xattr -dr com.apple.quarantine \"$DEST\""
echo "или щёлкните по приложению правой кнопкой и выберите «Открыть»."
