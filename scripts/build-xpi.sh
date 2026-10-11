#!/usr/bin/env bash
#
# Build the Firefox package for self-distribution.
#
#   npm run build:xpi          → dist/media-controller-<version>.xpi  (install / update_url)
#                                dist/media-controller-<version>.zip  (same bytes, for uploads)
#
# Both files contain the Firefox manifest (background.scripts) and are plain
# zips with manifest.json at the root.
#
# Why two names?
#   * `.xpi`  → the file Firefox installs, and what addons.mozilla.org gives you
#               back after signing (this is what `update_url`/`updates.json` must
#               point at).
#   * `.zip`  → the file to hand out / upload. Firefox auto-starts an add-on
#               install for any downloaded `.xpi` and deletes the temporary file
#               if you cancel, so a `.zip` is the safe name for humans.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./manifest.json').version")"
DIST_DIR="$ROOT_DIR/dist"
STAGE_DIR="$DIST_DIR/firefox-build"
OUT_XPI="$DIST_DIR/media-controller-$VERSION.xpi"
OUT_ZIP="$DIST_DIR/media-controller-$VERSION.zip"

# Regenerate dist/firefox (Firefox-specific manifest).
node "$ROOT_DIR/scripts/build-manifests.js" > /dev/null

rm -rf "$STAGE_DIR" "$OUT_XPI" "$OUT_ZIP"
mkdir -p "$STAGE_DIR"

cp -R src assets docs README.md LICENSE "$STAGE_DIR/"
cp dist/firefox/manifest.json "$STAGE_DIR/manifest.json"

# assets/previews/*.png are store-listing screenshots, never referenced at
# runtime — shipping them would only add ~2 MB to every install.
rm -rf "$STAGE_DIR/assets/previews"

( cd "$STAGE_DIR" && zip -q -r -X "$OUT_XPI" . -x '*.DS_Store' -x '*__pycache__*' )
cp "$OUT_XPI" "$OUT_ZIP"

echo "✅ $OUT_XPI"
echo "✅ $OUT_ZIP"
unzip -l "$OUT_ZIP" | tail -n 3
