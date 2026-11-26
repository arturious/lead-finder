#!/usr/bin/env bash
# Build the Camoufox sidecar for the packaged Mac app.
# One PyInstaller binary: CPython plus camoufox[geoip]. The Firefox build is
# not inside it; the app runs `camoufox fetch` into the user cache on first use.
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${PYTHON:-python3.12}"
if ! command -v "$PY" >/dev/null 2>&1; then
  PY=python3
fi

"$PY" -m venv .venv-sidecar-build
# shellcheck disable=SC1091
source .venv-sidecar-build/bin/activate
python -m pip install -U pip
python -m pip install "camoufox[geoip]" pyinstaller
python -m PyInstaller --noconfirm --clean --onefile \
  --name camoufox-sidecar \
  --distpath build/pyinstaller-dist \
  --workpath build/pyinstaller-work \
  --specpath build \
  --collect-all camoufox \
  --collect-all browserforge \
  --collect-all language_tags \
  --collect-all apify_fingerprint_datapoints \
  --hidden-import maxminddb \
  --hidden-import camoufox.async_api \
  sidecar/camoufox_server.py
mkdir -p build/sidecar
cp build/pyinstaller-dist/camoufox-sidecar build/sidecar/camoufox-sidecar
chmod +x build/sidecar/camoufox-sidecar
