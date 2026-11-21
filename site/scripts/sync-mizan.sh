#!/usr/bin/env bash
# Copies the built mizan (pano-ui) stylesheet into the site. The pano-ui repo itself is left untouched: it is copied
# to a temporary folder, built there, and only dist/mizan.css and dist/tokens.json are taken.
#   bash scripts/sync-mizan.sh [path to pano-ui, default ../../pano-ui]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
source_dir="$(cd "${1:-$here/../../pano-ui}" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
rsync -a --exclude node_modules --exclude dist --exclude .git --exclude sandbox --exclude deploy "$source_dir/" "$work/"
(cd "$work" && npm install --silent --no-audit --no-fund && npm run build:lib >/dev/null)
mkdir -p "$here/src/vendor/mizan"
cp "$work/dist/mizan.css" "$work/dist/tokens.json" "$source_dir/LICENSE" "$here/src/vendor/mizan/"
echo "mizan stilleri güncellendi: $(git -C "$source_dir" rev-parse --short HEAD 2>/dev/null || echo bilinmiyor)"
