# Shared by the deploy scripts: numbered steps, notes, and the dry-run boundary. Everything that changes the system
# goes through `run` or `write_file`, which only print when DRY_RUN is 1. Source it after setting DRY_RUN. It runs on
# Linux and on macOS (deploy/onprem.sh), whose stat differs.

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

# The one rule for PIGUI_MODELS_UNLOAD, shared by both installers and mirrored by the server's
# parseModelsUnload (src/server/config.ts); the held-model test pins the same acceptance set on the server side.
# never (or unset) keeps the models loaded; otherwise decimal idle minutes from 1 to 1440, leading zeros allowed.
unload_valid() {
	local v=$1
	v="${v#"${v%%[![:space:]]*}"}"
	v="${v%"${v##*[![:space:]]}"}"
	[[ $v == never ]] && return 0
	[[ $v =~ ^[0-9]+$ ]] && ((10#$v >= 1 && 10#$v <= 1440))
}

# A file's mode and owner as "644 user:group", with GNU stat or, on macOS, BSD stat.
mode_owner() { stat -c '%a %U:%G' "$1" 2>/dev/null || stat -f '%Lp %Su:%Sg' "$1"; }

# write_file PATH MODE OWNER: content on stdin. Unchanged files are left alone, apart from their mode and owner.
write_file() {
	local path=$1 mode=$2 owner=$3 content
	content=$(cat)
	if [[ -f $path ]] && [[ $(cat "$path") == "$content" ]]; then
		if [[ $(mode_owner "$path") == "${mode#0} $owner" ]]; then
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

# ---- Packages on Debian and Ubuntu, as root: shared by the server installer and OnPrem's installer on a server.

# The release as Debian's and Ubuntu's apt sources name it (debian/trixie, ubuntu/noble), from os-release FILE, or
# nothing when FILE does not say.
apt_release() {
	[[ -r ${1:-/etc/os-release} ]] || return 0
	(
		# shellcheck disable=SC1090
		. "${1:-/etc/os-release}"
		if [[ -n ${ID:-} && -n ${VERSION_CODENAME:-} ]]; then echo "$ID/$VERSION_CODENAME"; fi
	)
}

# apt_install PACKAGE...: installs the ones not installed yet.
apt_install() {
	local missing=() package
	for package in "$@"; do
		dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed" || missing+=("$package")
	done
	if [[ ${#missing[@]} -eq 0 ]]; then
		note "all present: $*"
		return 0
	fi
	run apt-get update
	run env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
}

# install_node MAJOR: Node.js MAJOR from NodeSource's apt repository.
install_node() {
	run install -d -m 0755 /etc/apt/keyrings
	run sh -c "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg"
	write_file /etc/apt/sources.list.d/nodesource.list 0644 root:root <<NODESOURCE
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$1.x nodistro main
NODESOURCE
	run apt-get update
	run env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
}

# install_tailscale RELEASE: Tailscale from the apt source it publishes for RELEASE (such as debian/trixie), running.
install_tailscale() {
	run install -d -m 0755 /usr/share/keyrings
	run sh -c "curl -fsSL https://pkgs.tailscale.com/stable/$1.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg"
	write_file /etc/apt/sources.list.d/tailscale.list 0644 root:root <<TAILSCALE
deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/${1%/*} ${1#*/} main
TAILSCALE
	run apt-get update
	run env DEBIAN_FRONTEND=noninteractive apt-get install -y tailscale
	run systemctl enable --now tailscaled
}
