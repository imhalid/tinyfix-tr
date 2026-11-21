#!/usr/bin/env bash
# Publishes the model files (and only those) to a Hugging Face model repo.
#
#   npm run build:models
#   hf auth login
#   scripts/publish-hf.sh imhalid/tdk-ai          (the published repo: https://huggingface.co/imhalid/tdk-ai)
#
# Uploads: lexicon.bin, morph.bin, known.tsv, context.onnx, manifest.json from site/public/models, and hf/README.md
# as the model card. No training data or text is uploaded.
set -euo pipefail

repo="${1:?usage: scripts/publish-hf.sh <user>/<repo> [--private]}"
visibility="${2:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
models="$root/site/public/models"

for file in lexicon.bin morph.bin known.tsv context.onnx manifest.json; do
  [[ -f "$models/$file" ]] || { echo "missing $models/$file (run npm run build:models)" >&2; exit 1; }
done

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$models"/{lexicon.bin,morph.bin,known.tsv,context.onnx,manifest.json} "$stage"/
cp "$root/hf/README.md" "$stage/README.md"

hf repos create "$repo" --repo-type model ${visibility:+--private} --exist-ok
hf upload "$repo" "$stage" . --repo-type model --commit-message "autr model $(git -C "$root" rev-parse --short HEAD)"
echo "https://huggingface.co/$repo"
