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
for asset in data.get("assets") or []:
    name = asset.get("name") or ""
    if name.endswith(".zip") and "arm64" in name:
        print(asset["browser_download_url"])
        raise SystemExit
raise SystemExit(1)
')" || {
  echo "В последнем релизе ${REPO} нет zip для arm64." >&2
  exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fL --progress-bar "$URL" -o "$TMP/LeadFinder.zip"
unzip -q "$TMP/LeadFinder.zip" -d "$TMP/unpacked"
APP="$(find "$TMP/unpacked" -name '*.app' -maxdepth 3 -print -quit)"
if [[ -z "${APP}" ]]; then
  echo "В архиве нет .app" >&2
  exit 1
fi
rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" || true
echo "Готово: $DEST"
echo "Поиск идёт внутри приложения, отдельный Chrome не нужен. Ключ не нужен."
echo "Если macOS не даёт открыть непроверенное приложение, щёлкните по нему правой кнопкой и выберите «Открыть»."
