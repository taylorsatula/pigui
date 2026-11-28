#!/usr/bin/env bash
# Daily self-updater for pigui OnPrem installs (macOS LaunchAgent, Linux systemd user or system unit).
# Checks origin/<REF>; if HEAD moved forward cleanly, installs packages, builds, restarts the service, and verifies
# health. Rolls back to the previous commit and records the failed SHA if build, restart, or health check fails.
set -euo pipefail

APP=${PIGUI_APP_DIR:-$HOME/.pigui/app}
ROOT=${PIGUI_ROOT:-$(dirname "$APP")}
CONF=${PIGUI_CONF:-$ROOT/onprem.conf}
FAILED_FILE=$ROOT/update-failed-sha
LOCK_DIR=$ROOT/update.lock

# Read saved install choices as defaults when not overridden by the environment.
REF=${PIGUI_REF:-}
PORT=${PIGUI_PORT:-}
if [[ -f $CONF ]]; then
	while IFS='=' read -r key value; do
		case $key in
			REF) [[ -z $REF ]] && REF=$value ;;
			PORT) [[ -z $PORT ]] && PORT=$value ;;
		esac
	done <"$CONF"
fi
: "${REF:=main}" "${PORT:=2025}"

HEALTH_URL=${PIGUI_UPDATE_HEALTH_URL:-http://127.0.0.1:$PORT/api/bootstrap}
HEALTH_TIMEOUT=${PIGUI_UPDATE_HEALTH_TIMEOUT:-60}
RESTART_CMD=${PIGUI_UPDATE_RESTART_CMD:-}
SKIP_NPM=${PIGUI_UPDATE_SKIP_NPM:-0}

log() { printf '[%s] pigui-update: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Portable single-instance lock (works on macOS and Linux without flock), clearing stale locks from dead PIDs.
mkdir -p "$ROOT"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
	old_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
	if [[ -n $old_pid ]] && kill -0 "$old_pid" 2>/dev/null; then
		log "another update is already running (pid $old_pid); exiting"
		exit 0
	fi
	rm -rf "$LOCK_DIR"
	mkdir "$LOCK_DIR" 2>/dev/null || { log "could not acquire $LOCK_DIR; exiting"; exit 0; }
fi
printf '%s\n' "$$" >"$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR" 2>/dev/null || true' EXIT

if [[ ! -d $APP/.git ]]; then
	log "no git repository at $APP; skipping"
	exit 0
fi

changed=$(git -C "$APP" status --porcelain --untracked-files=no)
if [[ -n $changed ]]; then
	log "tracked local changes present in $APP; skipping update"
	exit 0
fi

current=$(git -C "$APP" rev-parse HEAD)
if ! git -C "$APP" fetch --quiet origin "$REF"; then
	log "fetch origin $REF failed; keeping ${current:0:7}"
	exit 1
fi
target=$(git -C "$APP" rev-parse FETCH_HEAD)

if [[ $current == "$target" ]]; then
	log "up to date at ${current:0:7} ($REF)"
	exit 0
fi

if [[ -f $FAILED_FILE && $(cat "$FAILED_FILE") == "$target" ]]; then
	log "skipping ${target:0:7}: previous update attempt failed"
	exit 0
fi

restart_service() {
	if [[ -n $RESTART_CMD ]]; then
		sh -c "$RESTART_CMD"
		return
	fi
	case $(uname -s) in
		Darwin)
			local label=com.github.taylorsatula.pigui
			local domain="gui/$(id -u)"
			local plist="$HOME/Library/LaunchAgents/$label.plist"
			launchctl kickstart -k "$domain/$label" 2>/dev/null || {
				launchctl bootout "$domain/$label" 2>/dev/null || true
				launchctl bootstrap "$domain" "$plist"
			}
			;;
		Linux)
			if [[ $(id -u) == 0 ]]; then
				systemctl restart pigui-onprem.service
			else
				systemctl --user restart pigui.service
			fi
			;;
		*)
			log "unsupported OS for automatic restart: $(uname -s)"
			return 1
			;;
	esac
}

wait_healthy() {
	local tick
	for tick in $(seq 1 "$HEALTH_TIMEOUT"); do
		if curl --fail --silent --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done
	return 1
}

build_app() {
	[[ $SKIP_NPM == 1 ]] && return 0
	(cd "$APP" && npm ci --no-audit --no-fund && npm run build)
}

rollback() {
	local reason=$1
	log "update to ${target:0:7} failed ($reason); rolling back to ${current:0:7}"
	printf '%s\n' "$target" >"$FAILED_FILE"
	git -C "$APP" checkout --quiet --detach "$current" || true
	build_app || true
	restart_service || true
	exit 1
}

log "updating $APP from ${current:0:7} to ${target:0:7} ($REF)"
git -C "$APP" checkout --quiet --detach "$target" || rollback "git checkout"
build_app || rollback "build"
restart_service || rollback "service restart"
wait_healthy || rollback "health check at $HEALTH_URL"

rm -f "$FAILED_FILE"
log "updated ${current:0:7} -> ${target:0:7} and verified healthy"
