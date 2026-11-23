#!/usr/bin/env bash
# picloud OnPrem: picloud on your own computer, macOS or Linux, as a web app at http://localhost:2025 whose sessions run
# as you, with your full access. Installs, and when run again updates in place, in your home directory: the app in
# ~/.picloud/app, its data in ~/.picloud/data, and a service of your own user that keeps it running (a LaunchAgent on
# macOS, a systemd user unit on Linux). Nothing outside your home directory changes, and nothing needs sudo.
#
#   curl -fsSL https://raw.githubusercontent.com/taylorsatula/picloud/main/deploy/onprem.sh | bash -s -- [options]
#
# Options:
#   --speech on|off        read replies aloud with Kokoro, on this computer (default on)
#   --memory-local on|off  embed long-term memory on this computer (default off)
#   --port PORT            the localhost port (default 2025)
#   --ref REF              the branch, tag or commit of picloud to install (default main)
#   --tailscale on|off     serve it to your tailnet with tailscale serve, for your phone (default off)
#   --allowed-logins LIST  comma-separated Tailscale logins allowed in through the tailnet (default: everyone on it)
#   --dry-run              show every step without changing anything
#   --uninstall            stop and remove the service and the app; the data stays
#   -h, --help             show this help
#
# Each run keeps the choices of the last install (in ~/.picloud/onprem.conf), so running it again with no options
# updates picloud as it is; an option given changes that choice.
set -euo pipefail

readonly REPOSITORY=https://github.com/taylorsatula/picloud.git
readonly ROOT=$HOME/.picloud
readonly APP=$ROOT/app
readonly DATA=$ROOT/data
readonly LOGS=$ROOT/logs
readonly NODE_MINIMUM=22.19.0
readonly LABEL=com.github.taylorsatula.picloud
readonly CONF=$ROOT/onprem.conf

# Kept to run the installer again from the version it fetches. Empty arrays are expanded as ${ARGS[@]+"${ARGS[@]}"},
# since macOS's bash 3.2 calls a plain "${ARGS[@]}" of none unbound.
ARGS=("$@")
DRY_RUN=0
UNINSTALL=0
SPEECH=on
MEMORY_LOCAL=off
PORT=2025
REF=main
TAILSCALE=off
ALLOWED_LOGINS=""

# The last install's choices, as defaults the options below override. Read as plain values, never run.
if [[ -f $CONF ]]; then
	while IFS='=' read -r key value; do
		case $key in
			SPEECH | MEMORY_LOCAL | PORT | REF | TAILSCALE | ALLOWED_LOGINS) printf -v "$key" '%s' "$value" ;;
		esac
	done <"$CONF"
fi

usage() { sed -n '2,/^#   -h/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
	case $1 in
		--speech) SPEECH=${2:?--speech needs on or off}; shift ;;
		--memory-local) MEMORY_LOCAL=${2:?--memory-local needs on or off}; shift ;;
		--port) PORT=${2:?--port needs a number}; shift ;;
		--ref) REF=${2:?--ref needs a branch, tag or commit}; shift ;;
		--tailscale) TAILSCALE=${2:?--tailscale needs on or off}; shift ;;
		--allowed-logins) ALLOWED_LOGINS=${2?--allowed-logins needs a list, or '' for everyone on the tailnet}; shift ;;
		--dry-run) DRY_RUN=1 ;;
		--uninstall) UNINSTALL=1 ;;
		-h | --help)
			if [[ -f ${BASH_SOURCE[0]:-} ]]; then usage; else echo "See the comment at the top of deploy/onprem.sh, or README.md, \"PiCloud OnPrem\"."; fi
			exit 0
			;;
		*) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
	esac
	shift
done
[[ $SPEECH == on || $SPEECH == off ]] || { echo "--speech must be on or off." >&2; exit 2; }
[[ $MEMORY_LOCAL == on || $MEMORY_LOCAL == off ]] || { echo "--memory-local must be on or off." >&2; exit 2; }
[[ $PORT =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || { echo "--port must be a number from 1 to 65535." >&2; exit 2; }
[[ $TAILSCALE == on || $TAILSCALE == off ]] || { echo "--tailscale must be on or off." >&2; exit 2; }
[[ $ALLOWED_LOGINS =~ ^[^[:space:]=]*$ ]] || { echo "--allowed-logins takes logins separated by commas, without spaces." >&2; exit 2; }

# ---- Piped from curl, this script has no checkout around it, so it gets one first and runs the copy in it: the
# installed app's when there is one (which updates itself to --ref), otherwise a fresh clone of --ref. A dry run or an
# uninstall with nothing installed fetches --ref into a temporary directory instead, so it changes nothing.
SOURCE_DIR=""
if [[ -n ${BASH_SOURCE[0]:-} && -f $(dirname "${BASH_SOURCE[0]}")/lib.sh ]]; then
	SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fi
if [[ -z $SOURCE_DIR ]]; then
	command -v git >/dev/null || { echo "picloud OnPrem needs git. macOS: xcode-select --install. Linux: your package manager, for example sudo apt install git." >&2; exit 1; }
	if [[ -d $APP/.git ]]; then exec bash "$APP/deploy/onprem.sh" ${ARGS[@]+"${ARGS[@]}"}; fi
	if [[ $DRY_RUN == 1 || $UNINSTALL == 1 ]]; then
		scratch=$(mktemp -d)
		trap 'rm -rf "$scratch"' EXIT
		echo "picloud is not installed in $APP: fetching $REF into a temporary directory to run this from"
		git init --quiet "$scratch/picloud"
		git -C "$scratch/picloud" fetch --quiet --depth 1 "$REPOSITORY" "$REF"
		git -C "$scratch/picloud" checkout --quiet FETCH_HEAD
		bash "$scratch/picloud/deploy/onprem.sh" ${ARGS[@]+"${ARGS[@]}"}
		exit
	fi
	mkdir -p "$ROOT"
	git clone --quiet "$REPOSITORY" "$APP"
	exec bash "$APP/deploy/onprem.sh" ${ARGS[@]+"${ARGS[@]}"}
fi

# Output and the dry-run boundary (step, note, run, write_file) are shared with deploy/install.sh.
# shellcheck source=deploy/lib.sh
. "$SOURCE_DIR/deploy/lib.sh"

# Whether dotted version $1 is at least $2, in plain bash: macOS runs this with bash 3.2 and may have no sort -V.
version_at_least() {
	local IFS=. index
	local -a have want
	read -r -a have <<<"${1%%-*}"
	read -r -a want <<<"$2"
	for index in 0 1 2; do
		((${have[index]:-0} > ${want[index]:-0})) && return 0
		((${have[index]:-0} < ${want[index]:-0})) && return 1
	done
	return 0
}

xml() {
	local text=${1//&/&amp;}
	text=${text//</&lt;}
	printf '%s' "${text//>/&gt;}"
}

# systemd expands % in unit files; a literal one is written %%.
unit_value() { printf '%s' "${1//%/%%}"; }

case $(uname -s) in
	Darwin) SYSTEM=macos ;;
	Linux) SYSTEM=linux ;;
	*) echo "picloud OnPrem runs on macOS and Linux; this is $(uname -s)." >&2; exit 1 ;;
esac
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
UNIT=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/picloud.service
DOMAIN=gui/$(id -u)
OWNER=$(id -un):$(id -gn)
URL=http://localhost:$PORT

launch_agent_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# launchd unloads in the background; loading again before it has finished fails.
stop_launch_agent() {
	launch_agent_loaded || return 0
	run launchctl bootout "$DOMAIN/$LABEL"
	[[ $DRY_RUN == 1 ]] && return 0
	for _ in $(seq 1 20); do
		launch_agent_loaded || return 0
		sleep 0.5
	done
	echo "launchd did not stop $LABEL; try again in a moment." >&2
	exit 1
}

# The Tailscale CLI: on PATH, or inside the macOS app, which does not put it there.
tailscale_cli() {
	command -v tailscale 2>/dev/null && return 0
	if [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then echo /Applications/Tailscale.app/Contents/MacOS/Tailscale; fi
}

# The string at a JSON path (a JSON array of keys) in the document on stdin, or nothing; node is here either way.
json_get() {
	node -e 'let text = ""; process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => { try { let value = JSON.parse(text); for (const key of JSON.parse(process.argv[1])) value = value?.[key]; if (typeof value === "string") process.stdout.write(value); } catch {} });' "$1"
}

# This computer's MagicDNS name on the tailnet, without the final dot, or nothing when Tailscale is not up.
tailnet_name() { "$TS" status --json 2>/dev/null | json_get '["Self","DNSName"]' | sed 's/\.$//'; }

# Where tailscale serve sends https://NAME/ now, or nothing.
served_to() { "$TS" serve status --json 2>/dev/null | json_get "[\"Web\",\"$1:443\",\"Handlers\",\"/\",\"Proxy\"]"; }

# ---- Uninstall: the service, the app and picloud's own tailscale serve go; the data and logs stay.

if [[ $UNINSTALL == 1 ]]; then
	step "Stop and remove the service"
	if [[ $SYSTEM == macos ]]; then
		stop_launch_agent
		if [[ -f $PLIST ]]; then run rm "$PLIST"; else note "no LaunchAgent at $PLIST"; fi
	elif [[ -f $UNIT ]]; then
		run systemctl --user disable --now picloud.service
		run rm "$UNIT"
		run systemctl --user daemon-reload
	else
		note "no systemd user unit at $UNIT"
	fi
	TS=$(tailscale_cli || true)
	if [[ -n $TS ]] && command -v node >/dev/null; then
		name=$(tailnet_name)
		if [[ -n $name && $(served_to "$name") == "http://127.0.0.1:$PORT" ]]; then
			step "Stop serving picloud to the tailnet"
			run "$TS" serve --https=443 off
		fi
	fi
	step "Remove the app ($APP)"
	if [[ -d $APP ]]; then run rm -rf "$APP"; else note "not installed"; fi
	if [[ -f $CONF ]]; then run rm "$CONF"; fi
	printf '\nYour sessions, database and backups remain in %s, and the logs in %s. Remove %s to delete them too.\n' "$DATA" "$LOGS" "$ROOT"
	exit 0
fi

# ---- Checks before anything changes.

step "Check this computer"
if [[ $DRY_RUN != 1 && $EUID -eq 0 ]]; then
	echo "Run this as yourself, without sudo: picloud OnPrem runs as the user whose computer it is." >&2
	exit 1
fi
note "$([[ $SYSTEM == macos ]] && echo "macOS $(sw_vers -productVersion 2>/dev/null || true)" || echo "Linux $(uname -r)")"
NODE=$(command -v node || true)
node_version=$([[ -n $NODE ]] && "$NODE" --version | sed 's/^v//' || true)
if [[ -z $node_version ]] || ! version_at_least "$node_version" "$NODE_MINIMUM"; then
	echo "picloud needs Node.js $NODE_MINIMUM or newer${node_version:+; this is $node_version}. Install it, for example with Homebrew (brew install node@22) or nvm (nvm install 22), then run this again." >&2
	exit 1
fi
note "node $node_version ($NODE)"
command -v git >/dev/null || { echo "picloud OnPrem needs git. macOS: xcode-select --install. Linux: your package manager." >&2; exit 1; }
note "$(git --version)"
if ! command -v gh >/dev/null; then
	note "gh is not installed: sessions on this computer work; repository sessions need gh, signed in (https://cli.github.com)"
elif gh auth status >/dev/null 2>&1; then
	note "gh is signed in: repository sessions can list, clone and push your repositories"
else
	note "gh is not signed in: sessions on this computer work; for repository sessions, run gh auth login"
fi
if [[ $SYSTEM == linux ]] && ! systemctl --user show-environment >/dev/null 2>&1; then
	if [[ $DRY_RUN == 1 ]]; then
		note "systemd's user instance is not running for you; the install would stop here"
	else
		echo "systemd's user instance is not running for you, so there is nothing to keep picloud running. Log in to a desktop session, or run 'loginctl enable-linger $USER', then run this again." >&2
		exit 1
	fi
fi
[[ $DRY_RUN == 1 ]] && note "dry run: nothing will be changed"

# ---- The app: the repository at --ref, refusing to overwrite changes made in it.

step "Fetch picloud ($REF) into $APP"
if [[ ${PICLOUD_ONPREM_FETCHED:-} == "$REF" && $SOURCE_DIR == "$APP" ]]; then
	note "at $(git -C "$APP" rev-parse --short HEAD)"
else
	if [[ -d $APP/.git ]]; then
		changed=$(git -C "$APP" status --porcelain --untracked-files=no)
		if [[ -n $changed ]]; then
			echo "$APP has local changes, which updating would overwrite:" >&2
			echo "$changed" >&2
			echo "Keep them elsewhere, then discard them (git -C $APP stash), and run this again." >&2
			exit 1
		fi
	else
		run mkdir -p "$ROOT"
		run git clone --quiet "$REPOSITORY" "$APP"
	fi
	run git -C "$APP" fetch --quiet origin "$REF"
	run git -C "$APP" checkout --quiet --detach FETCH_HEAD
	# The rest of the install is the one at --ref, whatever version of this script fetched it.
	if [[ $DRY_RUN != 1 ]]; then PICLOUD_ONPREM_FETCHED=$REF exec bash "$APP/deploy/onprem.sh" ${ARGS[@]+"${ARGS[@]}"}; fi
fi

step "Install its packages and build it"
run mkdir -p "$DATA" "$LOGS"
run sh -c "cd '$APP' && npm ci --no-audit --no-fund"
run sh -c "cd '$APP' && npm run build"

step "Install the local models (speech $SPEECH, memory $MEMORY_LOCAL)"
# As deploy/install.sh does: on fetches a model, checked against pinned checksums; off removes it, since picloud turns
# a feature on wherever it finds the model. With both off, the optional packages that run the models go too.
models=()
if [[ $SPEECH == on ]]; then
	if [[ $DRY_RUN != 1 && ! -d $APP/node_modules/kokoro-js ]]; then
		echo "npm left out kokoro-js, which speech needs: an install script under it failed (see above). Run this again, or with --speech off." >&2
		exit 1
	fi
	models+=(speech)
fi
if [[ $MEMORY_LOCAL == on ]]; then
	if [[ $DRY_RUN != 1 && ! -d $APP/node_modules/@huggingface/transformers ]]; then
		echo "npm left out @huggingface/transformers, which local memory needs: an install script under it failed (see above). Run this again, or with --memory-local off." >&2
		exit 1
	fi
	models+=(memory)
fi
run "$APP/deploy/models.sh" "$APP/models" ${models[@]+"${models[@]}"}
[[ ${#models[@]} -gt 0 ]] || run sh -c "cd '$APP' && npm prune --omit=optional --no-audit --no-fund"

step "Check Pi's sign-in"
# picloud's own check, as it runs at every start: Pi's default model, with credentials, in your Pi configuration.
if [[ ! -d $APP/node_modules ]]; then
	note "dry run: Pi's sign-in is checked once the app is installed"
elif (cd "$APP" && "$NODE" --disable-warning=ExperimentalWarning --input-type=module -e '
	import { getAgentDir } from "@earendil-works/pi-coding-agent";
	import { loadPiModels, NotSignedIn } from "./src/server/pi.ts";
	try { await loadPiModels(getAgentDir()); } catch (error) { if (error instanceof NotSignedIn) process.exit(78); throw error; }
' </dev/null); then
	note "Pi has a default model it can sign in to"
else
	echo "Pi is not signed in, so picloud cannot run it. Run $APP/node_modules/.bin/pi (or pi, if you have it), type /login and then /model, then run this again." >&2
	[[ $DRY_RUN == 1 ]] || exit 1
fi

# ---- Tailscale. On, picloud is served to the tailnet at https://NAME/ and answers to that name, for a phone on the
# tailnet; off, picloud's own serve, if it had one, comes down. Never funnel, which would put it on the internet.

step "Tailscale ($TAILSCALE)"
TS=$(tailscale_cli || true)
TS_NAME=$([[ -n $TS ]] && tailnet_name || true)
OURS=http://127.0.0.1:$PORT
if [[ $TAILSCALE == on ]]; then
	problem=""
	if [[ -z $TS ]]; then
		problem="--tailscale on needs Tailscale on this computer, logged in to your tailnet: https://tailscale.com/download"
	elif [[ -z $TS_NAME ]]; then
		problem="Tailscale is not running, not logged in, or has no MagicDNS name here. Log in, and turn on MagicDNS and HTTPS certificates in the tailnet's admin console."
	else
		current=$(served_to "$TS_NAME")
		if [[ -n $current && $current != "$OURS" ]]; then
			problem="tailscale serve already sends https://$TS_NAME/ to $current. Free it ($TS serve --https=443 off), or leave --tailscale off, and run this again."
		fi
	fi
	if [[ -n $problem ]]; then
		echo "$problem" >&2
		[[ $DRY_RUN == 1 ]] || exit 1
		TS_NAME=""
	else
		note "this computer on the tailnet: $TS_NAME"
		if ! run "$TS" serve --bg --https=443 "$OURS"; then
			echo "tailscale serve was refused. On Linux it needs root or Tailscale's operator: sudo tailscale set --operator=$USER, then run this again." >&2
			exit 1
		fi
	fi
elif [[ -n $TS_NAME && $(served_to "$TS_NAME") == "$OURS" ]]; then
	run "$TS" serve --https=443 off
	TS_NAME=""
else
	note "off: picloud answers at $URL only"
	TS_NAME=""
fi

# What the service is told beyond the basics: the tailnet name it answers to, and the logins it lets in through it.
plist_env=""
unit_env=""
if [[ -n $TS_NAME ]]; then
	plist_env+=$'\n\t\t<key>PICLOUD_ALLOWED_HOSTS</key>\n\t\t<string>'"$(xml "$TS_NAME")</string>"
	unit_env+=$'\n'"Environment=\"PICLOUD_ALLOWED_HOSTS=$(unit_value "$TS_NAME")\""
fi
if [[ -n $ALLOWED_LOGINS ]]; then
	plist_env+=$'\n\t\t<key>PICLOUD_ALLOWED_LOGINS</key>\n\t\t<string>'"$(xml "$ALLOWED_LOGINS")</string>"
	unit_env+=$'\n'"Environment=\"PICLOUD_ALLOWED_LOGINS=$(unit_value "$ALLOWED_LOGINS")\""
fi

# ---- The service. launchd and systemd start it with almost no environment, so it gets the PATH your login shell
# builds (Homebrew, nvm and the like), which is what the agent's commands then find.

step "Install the service ($([[ $SYSTEM == macos ]] && echo "LaunchAgent $LABEL" || echo "systemd user unit picloud.service"))"
login_path=$("${SHELL:-/bin/sh}" -lic 'printf "\n__PICLOUD_PATH__%s\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^__PICLOUD_PATH__//p' | tail -n1 || true)
SERVICE_PATH=${login_path:-$PATH}
[[ -n $login_path ]] || note "your login shell did not report a PATH; the service gets this one"
# The node found now runs the service, so its own directory goes first.
case ":$SERVICE_PATH:" in *":$(dirname "$NODE"):"*) ;; *) SERVICE_PATH=$(dirname "$NODE"):$SERVICE_PATH ;; esac
note "PATH for the service: $SERVICE_PATH"
if [[ $SYSTEM == macos ]]; then
	run mkdir -p "$(dirname "$PLIST")"
	write_file "$PLIST" 0644 "$OWNER" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml "$NODE")</string>
		<string>--disable-warning=ExperimentalWarning</string>
		<string>$(xml "$APP/src/server/main.ts")</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$(xml "$APP")</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$(xml "$SERVICE_PATH")</string>
		<key>PICLOUD_ONPREM</key>
		<string>on</string>
		<key>PICLOUD_DATA_DIR</key>
		<string>$(xml "$DATA")</string>
		<key>PICLOUD_PORT</key>
		<string>$PORT</string>$plist_env
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>$(xml "$LOGS/picloud.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml "$LOGS/picloud.log")</string>
</dict>
</plist>
EOF
else
	run mkdir -p "$(dirname "$UNIT")"
	write_file "$UNIT" 0644 "$OWNER" <<EOF
[Unit]
Description=picloud OnPrem: the Pi coding agent on this computer, at $URL

[Service]
Type=simple
WorkingDirectory=$(unit_value "$APP")
Environment="PATH=$(unit_value "$SERVICE_PATH")"
Environment=PICLOUD_ONPREM=on
Environment="PICLOUD_DATA_DIR=$(unit_value "$DATA")"
Environment=PICLOUD_PORT=$PORT$unit_env
ExecStart="$(unit_value "$NODE")" --disable-warning=ExperimentalWarning "$(unit_value "$APP/src/server/main.ts")"
Restart=on-failure
RestartSec=5
# 78 means Pi is not signed in, 2 that the configuration is wrong: restarting cannot fix either.
RestartPreventExitStatus=78 2
TimeoutStopSec=60

[Install]
WantedBy=default.target
EOF
fi

step "Start (or restart) picloud"
if [[ $SYSTEM == macos ]]; then
	stop_launch_agent
	run launchctl bootstrap "$DOMAIN" "$PLIST"
else
	run systemctl --user daemon-reload
	run systemctl --user enable picloud.service
	run systemctl --user restart picloud.service
fi
logs=$([[ $SYSTEM == macos ]] && echo "$LOGS/picloud.log" || echo "journalctl --user -u picloud")
if [[ $DRY_RUN == 1 ]]; then
	note "dry run: would wait for $URL/api/bootstrap"
else
	ready=0
	for _ in $(seq 1 60); do
		if curl --fail --silent --max-time 2 "http://127.0.0.1:$PORT/api/bootstrap" >/dev/null; then
			ready=1
			break
		fi
		sleep 1
	done
	if [[ $ready == 0 ]]; then
		echo "picloud did not answer at $URL within a minute. Its log says why: $logs" >&2
		exit 1
	fi
fi
# Kept for the next run, which updates picloud with the same choices unless told otherwise.
write_file "$CONF" 0644 "$OWNER" <<EOF
SPEECH=$SPEECH
MEMORY_LOCAL=$MEMORY_LOCAL
PORT=$PORT
REF=$REF
TAILSCALE=$TAILSCALE
ALLOWED_LOGINS=$ALLOWED_LOGINS
EOF

printf '\npicloud OnPrem %s at %s\n' "$([[ $DRY_RUN == 1 ]] && echo "would run" || echo "is running")" "$URL"
if [[ -n $TS_NAME ]]; then
	printf 'On your phone, with Tailscale connected: https://%s/ (in Safari, Share, then Add to Home Screen).\n' "$TS_NAME"
fi
printf 'Logs: %s. Run this again to update it, or with --uninstall to remove it.\n' "$logs"
if [[ $SYSTEM == macos ]]; then
	# A LaunchAgent's commands are refused Documents, Desktop and Downloads until the person allows it; the README says how.
	printf 'macOS may keep its commands out of Documents, Desktop and Downloads. To allow them, if you choose to: System Settings, Privacy & Security, Full Disk Access, add %s.\n' "$NODE"
fi
if [[ $SYSTEM == macos ]]; then
	run open "$URL"
elif command -v xdg-open >/dev/null; then
	run xdg-open "$URL"
else
	note "open $URL in your browser"
fi
