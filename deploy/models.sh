#!/usr/bin/env bash
# Makes DIR hold the models picloud runs on this machine's CPU for the features named, and only those: each model at a
# pinned Hugging Face revision with every file's sha256 checked, and the model of a feature not named removed, since
# picloud turns a feature on wherever it finds its model. The Dockerfile, deploy/install.sh and deploy/onprem.sh run it;
# picloud itself never downloads.
#
#   deploy/models.sh DIR [speech] [memory]
#
#   speech  Kokoro-82M, which reads replies aloud. The voice is not among its files: kokoro-js reads it from its own
#           package.
#   memory  mdbr-leaf-ir-asym, which embeds long-term memory on this machine: MongoDB's LEAF for searches, Snowflake's
#           arctic-embed-m-v1.5 for the memories searched.
#
# Each model lands in DIR/<repo>, where picloud looks for it when DIR is the app's models directory. Only what
# transformers.js reads on the CPU is fetched: the configuration, the tokenizer and the weights quantized to 8 bits.
# Safe to re-run: a file already in place with the right checksum is kept.
set -euo pipefail

readonly SETS=(speech memory)

# One line per file: repo, revision, sha256, path in the repo.
speech() {
	local at="onnx-community/Kokoro-82M-v1.0-ONNX 1939ad2a8e416c0acfeecc08a694d14ef25f2231"
	cat <<-EOF
		$at df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f config.json
		$at 77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34 tokenizer.json
		$at be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20 tokenizer_config.json
		$at fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478 onnx/model_quantized.onnx
	EOF
}

memory() {
	local query="MongoDB/mdbr-leaf-ir 4262131b32c3182bd06e67e92ae69d7bd66e0c5c"
	local document="Snowflake/snowflake-arctic-embed-m-v1.5 e58a8f756156a1293d763f17e3aae643474e9b8a"
	# LEAF's export keeps its weights beside the graph, in onnx_data; its pooling and projection are inside the graph.
	cat <<-EOF
		$query 258407cfa27c7e1e502a9c312abebb4f5241bf226972ffc366287f370a3567f1 config.json
		$query da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0 tokenizer.json
		$query 46ac231e9b955a8af80fc7f23a0ecc65b524f1df84a02c2c82cbca354fb207b4 tokenizer_config.json
		$query 5aa43c2f985a25296d5a5ce621c2f77376ca8091a47993c492fd5460b895b140 special_tokens_map.json
		$query 8c08cb4ecc00bad721b117a85738c537ceb9b85b3eedc52d9c6906fddaa55718 onnx/model_quantized.onnx
		$query e77ea96a124230e23e5bac8e26c3ffe5410154973d8635673fa0220b06c13f8b onnx/model_quantized.onnx_data
		$document d2dddc06af0aeeb7fd3289a3dee1ac76dce0c3df2467cadd26f5f731f8d7919b config.json
		$document 91f1def9b9391fdabe028cd3f3fcc4efd34e5d1f08c3bf2de513ebb5911a1854 tokenizer.json
		$document 0e83e9d7206b3ade43f8f2aeef523cf5d5b4a25b67af21b273de21972c0f58b7 tokenizer_config.json
		$document 5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a special_tokens_map.json
		$document a18f437b2466863901a0bdc14904cf93246f5ecce0b656fc773bc2b7b2f84f6e onnx/model_quantized.onnx
	EOF
}

[[ $# -ge 1 ]] || { echo "Usage: deploy/models.sh DIR [speech] [memory]" >&2; exit 2; }
dir=$1
shift
for name in "$@"; do
	[[ " ${SETS[*]} " == *" $name "* ]] || { echo "There is no model set '$name'; the sets are: ${SETS[*]}." >&2; exit 2; }
done

# sha256sum where there is one (Linux); macOS has shasum instead, which reads the same checksum lines.
if command -v sha256sum >/dev/null; then
	sha256() { sha256sum "$@"; }
else
	sha256() { shasum -a 256 "$@"; }
fi
matches() { echo "$1  $2" | sha256 --check --status 2>/dev/null; }

fetch() {
	local repo=$1 revision=$2 sum=$3 file=$4
	local target=$dir/$repo/$file
	if [[ -f $target ]] && matches "$sum" "$target"; then
		echo "   $repo/$file is in place"
		return
	fi
	mkdir -p "$(dirname "$target")"
	echo "   downloading $repo/$file"
	# curl follows HTTPS_PROXY; Hugging Face redirects large files to its CDN.
	curl --fail --silent --show-error --location --retry 3 --output "$target.part" "https://huggingface.co/$repo/resolve/$revision/$file"
	if ! matches "$sum" "$target.part"; then
		rm -f "$target.part"
		echo "$file from $repo at $revision does not have the expected checksum; nothing was installed in its place." >&2
		exit 1
	fi
	mv "$target.part" "$target"
}

for name in "${SETS[@]}"; do
	if [[ " $* " == *" $name "* ]]; then
		while read -r repo revision sum file; do fetch "$repo" "$revision" "$sum" "$file"; done < <("$name")
		continue
	fi
	while read -r repo; do
		if [[ -d $dir/$repo ]]; then
			echo "   removing $repo ($name is off)"
			rm -rf "${dir:?}/$repo"
		fi
	done < <("$name" | cut -d' ' -f1 | sort -u)
done
# The owners' directories a removal left empty.
if [[ -d $dir ]]; then find "$dir" -mindepth 1 -type d -empty -delete; fi
