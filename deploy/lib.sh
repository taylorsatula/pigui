# Shared by the deploy scripts: numbered steps, notes, and the dry-run boundary. Everything that changes the system
# goes through `run` or `write_file`, which only print when DRY_RUN is 1. Source it after setting DRY_RUN.

STEP=0

step() {
	STEP=$((STEP + 1))
	printf '\n== %d. %s\n' "$STEP" "$*"
}

note() { printf '   %s\n' "$*"; }

run() {
	if [[ $DRY_RUN == 1 ]]; then
		printf '   [dry run] %s\n' "$*"
	else
		printf '   $ %s\n' "$*"
		"$@"
	fi
}

# write_file PATH MODE OWNER: content on stdin. Unchanged files are left alone, apart from their mode and owner.
write_file() {
	local path=$1 mode=$2 owner=$3 content
	content=$(cat)
	if [[ -f $path ]] && [[ $(cat "$path") == "$content" ]]; then
		if [[ $(stat -c '%a %U:%G' "$path") == "${mode#0} $owner" ]]; then
			note "$path is up to date"
		else
			run chmod "$mode" "$path"
			run chown "$owner" "$path"
		fi
		return
	fi
	if [[ $DRY_RUN == 1 ]]; then
		printf '   [dry run] write %s (mode %s, owner %s):\n' "$path" "$mode" "$owner"
		printf '%s\n' "$content" | sed 's/^/      | /'
		return
	fi
	install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" /dev/null "$path"
	printf '%s\n' "$content" >"$path"
	note "wrote $path"
}
