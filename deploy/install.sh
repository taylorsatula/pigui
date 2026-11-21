#!/usr/bin/env bash
# picloud installer for Ubuntu 24.04. Turns a fresh machine into a running picloud, and upgrades an existing install
# in place when run again. Every step checks before it changes anything, so re-running is safe.
#
#   sudo deploy/install.sh [options]
#
# Options (each may also be given as the environment variable in brackets):
#   --dry-run                     show every step without changing anything            [PICLOUD_DRY_RUN=1]
#   --tailscale-auth-key KEY      join the tailnet without a browser login             [TS_AUTHKEY]
#   --github-token-file FILE      sign gh in with a fine-grained token from FILE       [GITHUB_TOKEN_FILE]
#   --push-subject URL            mailto: or https: contact for push services          [PICLOUD_PUSH_SUBJECT]
#   --allowed-logins LIST         comma-separated Tailscale logins allowed in          [PICLOUD_ALLOWED_LOGINS]
#   --spend-cap DOLLARS           default per-session spend cap                        [PICLOUD_SPEND_CAP]
#   --port PORT                   loopback port picloud listens on (default 8787)      [PICLOUD_PORT]
#   --hostname NAME               Tailscale machine name (default picloud)             [PICLOUD_TS_HOSTNAME]
#   -h, --help                    show this help
set -euo pipefail

readonly SERVICE_USER=picloud
readonly INSTALL_DIR=/opt/picloud
readonly APP_DIR=$INSTALL_DIR/app
readonly DATA_DIR=/var/lib/picloud
readonly CONFIG_DIR=/etc/picloud
readonly ENV_FILE=$CONFIG_DIR/picloud.env
readonly UNIT_FILE=/etc/systemd/system/picloud.service
readonly NODE_MAJOR=22
readonly NODE_MINIMUM=22.19.0
readonly PI_VERSION=1.6.0
readonly SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

DRY_RUN=${PICLOUD_DRY_RUN:-0}
TS_AUTHKEY=${TS_AUTHKEY:-}
GITHUB_TOKEN_FILE=${GITHUB_TOKEN_FILE:-}
PUSH_SUBJECT=${PICLOUD_PUSH_SUBJECT:-}
ALLOWED_LOGINS=${PICLOUD_ALLOWED_LOGINS:-}
SPEND_CAP=${PICLOUD_SPEND_CAP:-}
PORT_OPTION=${PICLOUD_PORT:-}
TS_HOSTNAME=${PICLOUD_TS_HOSTNAME:-picloud}
HUMAN_STEPS=()
STEP=0

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
	case $1 in
		--dry-run) DRY_RUN=1 ;;
		--tailscale-auth-key) TS_AUTHKEY=${2:?}; shift ;;
		--github-token-file) GITHUB_TOKEN_FILE=${2:?}; shift ;;
		--push-subject) PUSH_SUBJECT=${2:?}; shift ;;
		--allowed-logins) ALLOWED_LOGINS=${2:?}; shift ;;
		--spend-cap) SPEND_CAP=${2:?}; shift ;;
		--port) PORT_OPTION=${2:?}; shift ;;
		--hostname) TS_HOSTNAME=${2:?}; shift ;;
		-h | --help) usage; exit 0 ;;
		*) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
	esac
	shift
done

# ---- Output and the dry-run boundary: everything that changes the system goes through `run` or `write_file`.

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

# Run as the service user, from its home, with its environment.
as_user() { run sudo -u "$SERVICE_USER" -H --login "$@"; }

# write_file PATH MODE OWNER: content on stdin. Unchanged files are left alone.
write_file() {
	local path=$1 mode=$2 owner=$3 content
	content=$(cat)
	if [[ -f $path ]] && [[ $(cat "$path") == "$content" ]]; then
		note "$path is up to date"
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

human() { HUMAN_STEPS+=("$*"); }

version_at_least() { [[ $(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1) == "$2" ]]; }

# ---- Checks before anything changes.

step "Check the machine"
if [[ $DRY_RUN != 1 && $EUID -ne 0 ]]; then
	echo "Run the installer as root (sudo deploy/install.sh), or with --dry-run to see what it would do." >&2
	exit 1
fi
if [[ -r /etc/os-release ]]; then
	# shellcheck disable=SC1091
	. /etc/os-release
	if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 24.04 ]]; then
		note "This installer targets Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}. Continuing."
	else
		note "Ubuntu 24.04"
	fi
fi
[[ -f $SOURCE_DIR/package.json && -f $SOURCE_DIR/package-lock.json ]] || { echo "Run the installer from a picloud checkout." >&2; exit 1; }
[[ -z $PORT_OPTION || $PORT_OPTION =~ ^[0-9]+$ ]] || { echo "--port must be a number." >&2; exit 2; }
if [[ -n $PUSH_SUBJECT && ! $PUSH_SUBJECT =~ ^(mailto:|https://) ]]; then
	echo "--push-subject must start with mailto: or https://" >&2
	exit 2
fi
if [[ -n $GITHUB_TOKEN_FILE && ! -r $GITHUB_TOKEN_FILE ]]; then
	echo "Cannot read the GitHub token file $GITHUB_TOKEN_FILE." >&2
	exit 2
fi
note "source: $SOURCE_DIR"
[[ $DRY_RUN == 1 ]] && note "dry run: nothing will be changed"

step "Install system packages"
packages=(ca-certificates curl gnupg git rsync sudo ripgrep unzip build-essential)
missing=()
for package in "${packages[@]}"; do
	dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed" || missing+=("$package")
done
if [[ ${#missing[@]} -gt 0 ]]; then
	run apt-get update
	run env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
else
	note "all present: ${packages[*]}"
fi

step "Install Node.js $NODE_MAJOR (at least $NODE_MINIMUM)"
current_node=$(node --version 2>/dev/null | sed 's/^v//' || true)
if [[ -n $current_node ]] && version_at_least "$current_node" "$NODE_MINIMUM"; then
	note "node $current_node"
else
	run install -d -m 0755 /etc/apt/keyrings
	run sh -c "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg"
	write_file /etc/apt/sources.list.d/nodesource.list 0644 root:root <<EOF
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main
EOF
	run apt-get update
	run env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

step "Install the GitHub CLI (gh)"
if command -v gh >/dev/null; then
	note "$(gh --version | head -n1)"
else
	run install -d -m 0755 /etc/apt/keyrings
	run sh -c "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg"
	write_file /etc/apt/sources.list.d/github-cli.list 0644 root:root <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main
EOF
	run apt-get update
	run env DEBIAN_FRONTEND=noninteractive apt-get install -y gh
fi

step "Install Tailscale"
if command -v tailscale >/dev/null; then
	note "$(tailscale version | head -n1)"
else
	run install -d -m 0755 /usr/share/keyrings
	run sh -c "curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg"
	write_file /etc/apt/sources.list.d/tailscale.list 0644 root:root <<EOF
deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main
EOF
	run apt-get update
	run env DEBIAN_FRONTEND=noninteractive apt-get install -y tailscale
	run systemctl enable --now tailscaled
fi

step "Create the service user $SERVICE_USER (no sudo)"
if id "$SERVICE_USER" >/dev/null 2>&1; then
	note "exists"
else
	run useradd --system --create-home --home-dir /home/$SERVICE_USER --shell /bin/bash --comment "picloud service" "$SERVICE_USER"
fi
if id -nG "$SERVICE_USER" 2>/dev/null | tr ' ' '\n' | grep -qx sudo; then
	run gpasswd -d "$SERVICE_USER" sudo
fi

step "Create the data, install and configuration directories"
run install -d -m 0755 -o root -g root "$INSTALL_DIR"
run install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
run install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/backups"
run install -d -m 0750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"

step "Install the pi CLI ($PI_VERSION)"
installed_pi=$(npm ls -g --depth=0 --json 2>/dev/null | grep -o '"@earendil-works/pi-coding-agent": *{[^}]*"version": *"[^"]*"' | grep -o '[0-9][0-9.]*$' || true)
if [[ $installed_pi == "$PI_VERSION" ]]; then
	note "pi $installed_pi"
else
	run npm install --global "@earendil-works/pi-coding-agent@$PI_VERSION"
fi

step "Install the picloud app into $APP_DIR"
run rsync -a --delete --exclude .git --exclude node_modules --exclude dist --exclude test-results "$SOURCE_DIR/" "$APP_DIR/"
run sh -c "cd '$APP_DIR' && npm ci --no-audit --no-fund"
run sh -c "cd '$APP_DIR' && npm run build"
run chown -R root:root "$APP_DIR"

step "Write the configuration ($ENV_FILE)"
# Existing values are kept; options given now replace them.
existing() { [[ -f $ENV_FILE ]] && grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }
choose() { local given=$1 key=$2 fallback=$3 value; value=$(existing "$key"); [[ -n $given ]] && value=$given; printf '%s' "${value:-$fallback}"; }
PORT=$(choose "$PORT_OPTION" PICLOUD_PORT 8787)
write_file "$ENV_FILE" 0640 root:$SERVICE_USER <<EOF
# picloud configuration; see README.md. Re-running the installer keeps these values unless options change them.
PICLOUD_DATA_DIR=$DATA_DIR
PICLOUD_HOST=127.0.0.1
PICLOUD_PORT=$PORT
PICLOUD_PUSH_SUBJECT=$(choose "$PUSH_SUBJECT" PICLOUD_PUSH_SUBJECT "mailto:picloud@localhost")
PICLOUD_ALLOWED_LOGINS=$(choose "$ALLOWED_LOGINS" PICLOUD_ALLOWED_LOGINS "")
PICLOUD_MAX_TURNS=$(choose "" PICLOUD_MAX_TURNS 150)
PICLOUD_SPEND_CAP=$(choose "$SPEND_CAP" PICLOUD_SPEND_CAP "")
EOF

step "Sign gh in for the service user"
if [[ -n $GITHUB_TOKEN_FILE ]]; then
	run sh -c "sudo -u $SERVICE_USER -H gh auth login --hostname github.com --git-protocol https --with-token < '$GITHUB_TOKEN_FILE'"
	as_user gh auth setup-git
elif sudo -u "$SERVICE_USER" -H gh auth status >/dev/null 2>&1; then
	note "gh is signed in"
	as_user gh auth setup-git
else
	note "gh is not signed in"
	human "GitHub: create a fine-grained token for the repositories picloud may use (Contents and Pull requests: read and write; Metadata: read), then re-run with --github-token-file FILE. Turn on branch protection for their default branches."
fi

step "Install the systemd service"
write_file "$UNIT_FILE" 0644 root:root <<EOF
[Unit]
Description=picloud: drive the Pi coding agent from a phone
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/env node --disable-warning=ExperimentalWarning $APP_DIR/src/server/main.ts
Restart=on-failure
RestartSec=5
# 78 means Pi is not signed in: restarting cannot fix that, so wait for a person.
RestartPreventExitStatus=78
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF
run systemctl daemon-reload
run systemctl enable picloud.service

step "Check Pi's sign-in"
if sudo -u "$SERVICE_USER" -H test -f "/home/$SERVICE_USER/.pi/agent/auth.json" 2>/dev/null; then
	note "Pi has credentials"
	pi_ready=1
else
	note "Pi is not signed in for $SERVICE_USER"
	human "Pi: run 'sudo -u $SERVICE_USER -i pi', then type /login and /model. Re-run the installer (or 'sudo systemctl restart picloud') afterwards."
	pi_ready=0
fi

step "Start (or restart) picloud"
run systemctl restart picloud.service
note "the database is backed up daily into $DATA_DIR/backups by picloud itself (14 copies kept)"

step "Connect Tailscale and serve picloud over HTTPS"
if tailscale status >/dev/null 2>&1; then
	note "already connected"
elif [[ -n $TS_AUTHKEY ]]; then
	run tailscale up --auth-key="$TS_AUTHKEY" --hostname="$TS_HOSTNAME"
else
	note "not logged in, and no auth key was given"
	human "Tailscale: log this machine in ('sudo tailscale up --hostname=$TS_HOSTNAME' and open the link), or re-run with --tailscale-auth-key. Then turn on MagicDNS and HTTPS certificates in the admin console."
fi
# Serve only to the tailnet (never funnel); tailscale serve adds the Tailscale-User-Login header picloud checks.
run tailscale serve --bg --https=443 "http://127.0.0.1:$PORT" || human "Tailscale serve: once HTTPS certificates are on, run 'sudo tailscale serve --bg --https=443 http://127.0.0.1:$PORT'."

step "Status"
if [[ $DRY_RUN == 1 ]]; then
	note "dry run: no status to report"
else
	note "service: $(systemctl is-active picloud.service || true)"
	if [[ $pi_ready == 0 ]]; then note "picloud waits for Pi's sign-in (exit code 78 until then)"; fi
	note "tailscale: $(tailscale status --self --peers=false 2>/dev/null | head -n1 || echo 'not connected')"
	url=$(tailscale serve status 2>/dev/null | grep -o 'https://[^ ]*' | head -n1 || true)
	[[ -n $url ]] && note "open on your phone: $url"
fi
human "Phone: install Tailscale and join the tailnet; open the picloud URL in Safari, tap Share, Add to Home Screen, open picloud from there, and turn on notifications in its menu."

printf '\n== Steps that need a person\n'
for item in "${HUMAN_STEPS[@]}"; do printf ' - %s\n' "$item"; done
printf '\nRe-run this installer after finishing them, and to upgrade.\n'
