#!/usr/bin/env bash
# Downloads the model picloud reads replies aloud with: Kokoro-82M, quantized to 8 bits, at a pinned Hugging Face
# revision, checking each file's sha256. The Dockerfile and deploy/install.sh run it; picloud itself never downloads.
#
#   deploy/speech-model.sh DIR
#
# The files land in DIR/onnx-community/Kokoro-82M-v1.0-ONNX, where picloud looks for them when DIR is the app's
# models directory. The voice is not among them: kokoro-js reads it from its own package. Safe to re-run: a file
# already in place with the right checksum is kept.
set -euo pipefail

readonly REPO=onnx-community/Kokoro-82M-v1.0-ONNX
readonly REVISION=1939ad2a8e416c0acfeecc08a694d14ef25f2231
# Everything kokoro-js reads for this model on the CPU: its configuration, its tokenizer and the q8 weights.
readonly FILES=(
	"df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f config.json"
	"77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34 tokenizer.json"
	"be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20 tokenizer_config.json"
	"fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478 onnx/model_quantized.onnx"
)

[[ $# -eq 1 ]] || { echo "Usage: deploy/speech-model.sh DIR" >&2; exit 2; }
dest=$1/$REPO

matches() { echo "$1  $2" | sha256sum --check --status 2>/dev/null; }

for entry in "${FILES[@]}"; do
	sum=${entry%% *}
	file=${entry#* }
	target=$dest/$file
	if [[ -f $target ]] && matches "$sum" "$target"; then
		echo "   $file is in place"
		continue
	fi
	mkdir -p "$(dirname "$target")"
	echo "   downloading $file"
	# curl follows HTTPS_PROXY; Hugging Face redirects large files to its CDN.
	curl --fail --silent --show-error --location --retry 3 --output "$target.part" "https://huggingface.co/$REPO/resolve/$REVISION/$file"
	if ! matches "$sum" "$target.part"; then
		rm -f "$target.part"
		echo "$file from $REPO at $REVISION does not have the expected checksum; nothing was installed in its place." >&2
		exit 1
	fi
	mv "$target.part" "$target"
done
