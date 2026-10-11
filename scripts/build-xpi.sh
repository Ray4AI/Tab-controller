#!/usr/bin/env bash
#
# Build a signed-ready Firefox package (.xpi) for self-distribution.
#
#   npm run build:xpi          → dist/media-controller-<version>.xpi
#
# The archive is a plain zip with manifest.json at its root, which is exactly
# what addons.mozilla.org expects when you submit an "on your own" (unlisted)
# add-on for signing.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./manifest.json').version")"
DIST_DIR="$ROOT_DIR/dist"
OUT="$DIST_DIR/media-controller-$VERSION.xpi"

mkdir -p "$DIST_DIR"
rm -f "$OUT"

# Everything the runtime needs; no dev files, no tests, no git metadata.
ITEMS=(manifest.json src assets README.md LICENSE)

zip -q -r -X "$OUT" "${ITEMS[@]}" -x '*.DS_Store' -x '*__pycache__*'

echo "✅ $OUT"
unzip -l "$OUT" | tail -n 3
