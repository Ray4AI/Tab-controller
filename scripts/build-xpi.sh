#!/usr/bin/env bash
#
# Build a signed-ready Firefox package (.xpi) for self-distribution.
#
#   npm run build:xpi          → dist/media-controller-<version>.xpi
#
# The archive is a plain zip with manifest.json at its root, which is exactly
# what addons.mozilla.org expects when you submit an "on your own" (unlisted)
# add-on for signing. Ships the Firefox manifest (background.scripts), not the
# Chrome one.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./manifest.json').version")"
DIST_DIR="$ROOT_DIR/dist"
STAGE_DIR="$DIST_DIR/firefox-build"
OUT="$DIST_DIR/media-controller-$VERSION.xpi"

# Regenerate dist/firefox (Firefox-specific manifest).
node "$ROOT_DIR/scripts/build-manifests.js" > /dev/null

rm -rf "$STAGE_DIR" "$OUT"
mkdir -p "$STAGE_DIR"

cp -R src assets README.md LICENSE "$STAGE_DIR/"
cp dist/firefox/manifest.json "$STAGE_DIR/manifest.json"

( cd "$STAGE_DIR" && zip -q -r -X "$OUT" . -x '*.DS_Store' -x '*__pycache__*' )

echo "✅ $OUT"
unzip -l "$OUT" | tail -n 3
