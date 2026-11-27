#!/usr/bin/env bash
# pigui installer: one decision tree for every way to run pigui. Installs, and when run again updates in place.
#
#   curl -fsSL https://raw.githubusercontent.com/taylorsatula/pigui/main/install.sh | bash -s --
#                                    ask where and how, on your terminal, then install (or update) there
#                                    (the script reads its answers from /dev/tty, since the pipe is stdin)
#   install.sh                       the same, from a checkout
#   install.sh --where local --how full --pi-config standalone
#                                    the same, without the questions
#   install.sh --local-full [options]
#                                    only the OnPrem path (pigui on this computer, as you); what deploy/onprem.sh runs
#
# The four ways to run pigui, chosen by three questions:
#   1. Container or not?  Sandboxed (a container, or a confined service) or full access (as you, or as a user you
#      choose, with no sandbox).
#   2. This computer or a remote server (over SSH)?
#   3. The flags: speech, memory, Tailscale, and the rest, each with a default.
#
#   Remote (sandboxed)  a server you reach over SSH, pigui in a systemd service as its own user, agent commands
#                       confined by Landlock. Runs deploy/install.sh on the server.
#   Remote (full)       a server you reach over SSH, pigui as a user of your choosing with that user's full access
#                       (OnPrem over SSH). Creates the user, copies your GitHub and Pi credentials to it, and installs.
#   Local (sandboxed)   this computer, in Docker (two containers, nothing published on this computer's ports; access
#                       through the tailnet). Needs Docker; installs nothing else.
#   Local (full)        this computer, as you, with your full access (OnPrem): either sharing your Pi configuration
#                       (~/.pi/agent) or totally standalone (~/.pigui/pi-agent, with PI_CODING_AGENT_DIR set).
#
# Options (each may also be given as the environment variable in brackets):
#   --where local|remote        this computer, or a server over SSH                       [PIGUI_WHERE]
#   --remote IP                 the server's address; implies --where remote              [PIGUI_REMOTE]
#   --ssh-user USER             the SSH user for the server (default root)                [PIGUI_SSH_USER]
#   --ssh-key FILE              the private key to reach the server with (default: ssh's own choice) [PIGUI_SSH_KEY]
#   --how sandboxed|full        confined, or your full access                             [PIGUI_HOW]
#   --pi-config overlap|standalone
#                               full only: share ~/.pi/agent, or a standalone directory   [PIGUI_PI_CONFIG]
#   --pi-agent-dir DIR          standalone's directory (default ~/.pigui/pi-agent)      [PIGUI_PI_AGENT_DIR]
#   --user NAME                 remote full: the user to create and run pigui as (default taylor)   [PIGUI_USER]
#   --ref REF                   the branch, tag or commit of pigui to install (default main)        [PIGUI_REF]
#   --speech on|off             read replies aloud with Kokoro (default on)                           [PIGUI_SPEECH]
#   --memory-local on|off       embed long-term memory on the machine (default off)                   [PIGUI_MEMORY_LOCAL]
#   --models-unload never|MINUTES
#                               keep the speech and memory models loaded from start (never), or load them on use
#                               and unload them after MINUTES idle, for a machine short of memory (default never)
#                                                                                       [PIGUI_MODELS_UNLOAD]
#   --port PORT                 local full: the localhost port (default 2025)                         [PIGUI_PORT]
#   --hostname NAME             the Tailscale machine name (default pigui)                           [PIGUI_TS_HOSTNAME]
#   --tailscale on|off          serve pigui to your tailnet (default off)                           [PIGUI_TAILSCALE]
#   --allowed-logins LIST       comma-separated Tailscale logins allowed in through the tailnet       [PIGUI_ALLOWED_LOGINS]
#   --tailscale-auth-key KEY    join the tailnet without a browser login                  [TS_AUTHKEY]
#   --push-subject URL          remote sandboxed: mailto: or https: contact for push services        [PIGUI_PUSH_SUBJECT]
#   --spend-cap DOLLARS         remote sandboxed: default per-session spend cap                       [PIGUI_SPEND_CAP]
#   --github-token-file FILE    remote sandboxed: pigui's own token, from FILE (default: this computer's .env, else gh)
#                                                                                       [PIGUI_GITHUB_TOKEN_FILE]
#   --agent-github-token-file FILE
#                               remote sandboxed: the agent's read-only token, from FILE (default: this computer's .env)
#                                                                                       [PIGUI_AGENT_GITHUB_TOKEN_FILE]
#   --local-full                run only the OnPrem path, without the questions
#   --uninstall                 with --local-full: stop and remove the service and the app; the data stays
#   --dry-run                   show every step without changing anything
#   -h, --help                  show this help
#
# With no options and a terminal (stdin, or /dev/tty when piped), the questions are asked. Re-running an install updates it in place; the OnPrem path
# keeps its choices in ~/.pigui/onprem.conf, the tree keeps its own in ~/.pigui/install.conf. Precedence:
# flags, then the environment, then the saved choices, then the defaults.
set -euo pipefail

readonly REPOSITORY=https://github.com/taylorsatula/pigui.git
ROOT=$HOME/.pigui
APP=$ROOT/app
DATA=$ROOT/data
LOGS=$ROOT/logs
readonly NODE_MINIMUM=22.19.0
readonly LABEL=com.github.taylorsatula.pigui
CONF=$ROOT/onprem.conf
TREE_CONF=$ROOT/install.conf

# As root, pigui is root's, in root's home whatever HOME says, so running this with sudo from an account never leaves
# root's files in that account's home.
AS_ROOT=0
if [[ $(id -u) == 0 ]]; then
	AS_ROOT=1
	if [[ $(uname -s) == Linux ]]; then HOME=/root; else HOME=$(eval echo ~root); fi
	export HOME
	ROOT=$HOME/.pigui
	APP=$ROOT/app
	DATA=$ROOT/data
	LOGS=$ROOT/logs
	CONF=$ROOT/onprem.conf
	TREE_CONF=$ROOT/install.conf
fi

# Kept to run the installer again from the version it fetches. Empty arrays are expanded as ${ARGS[@]+"${ARGS[@]}"},
# since macOS's bash 3.2 calls a plain "${ARGS[@]}" of none unbound.
ARGS=("$@")
DRY_RUN=0
UNINSTALL=0
LOCAL_FULL=0
WHERE=${PIGUI_WHERE:-}
REMOTE=${PIGUI_REMOTE:-}
SSH_USER=${PIGUI_SSH_USER:-}
SSH_KEY=${PIGUI_SSH_KEY:-}
HOW=${PIGUI_HOW:-}
PI_CONFIG=${PIGUI_PI_CONFIG:-}
PI_AGENT_DIR=${PIGUI_PI_AGENT_DIR:-}
RUSER=${PIGUI_USER:-}
SPEECH=${PIGUI_SPEECH:-}
MEMORY_LOCAL=${PIGUI_MEMORY_LOCAL:-}
MODELS_UNLOAD=${PIGUI_MODELS_UNLOAD:-}
PORT=${PIGUI_PORT:-}
REF=${PIGUI_REF:-}
TAILSCALE=${PIGUI_TAILSCALE:-}
ALLOWED_LOGINS=${PIGUI_ALLOWED_LOGINS:-}
TS_AUTHKEY=${TS_AUTHKEY:-}
PUSH_SUBJECT=${PIGUI_PUSH_SUBJECT:-}
SPEND_CAP=${PIGUI_SPEND_CAP:-}
GITHUB_TOKEN_FILE=${PIGUI_GITHUB_TOKEN_FILE:-}
AGENT_GITHUB_TOKEN_FILE=${PIGUI_AGENT_GITHUB_TOKEN_FILE:-}
HOSTNAME_OPTION=${PIGUI_TS_HOSTNAME:-}

# The last install's choices, as defaults the options below override. Read as plain values, never run.
# The saved choices fill what the environment did not set; the flags fill what neither did.
if [[ -f $TREE_CONF ]]; then
	while IFS='=' read -r key value; do
		case $key in
			WHERE | REMOTE | SSH_USER | SSH_KEY | HOW | PI_CONFIG | PI_AGENT_DIR | RUSER | REF | SPEECH | MEMORY_LOCAL | MODELS_UNLOAD | PORT | TAILSCALE | ALLOWED_LOGINS | HOSTNAME_OPTION) [[ -z ${!key:-} ]] && printf -v "$key" '%s' "$value" ;;
		esac
	done <"$TREE_CONF"
fi
if [[ -f $CONF ]]; then
	while IFS='=' read -r key value; do
		case $key in
			SPEECH | MEMORY_LOCAL | MODELS_UNLOAD | PORT | REF | TAILSCALE | ALLOWED_LOGINS | PI_AGENT_DIR) [[ -z ${!key:-} ]] && printf -v "$key" '%s' "$value" ;;
		esac
	done <"$CONF"
fi
# What neither the environment nor the saved choices set, the defaults do.
: "${SSH_USER:=root}" "${RUSER:=taylor}" "${SPEECH:=on}" "${MEMORY_LOCAL:=off}" "${MODELS_UNLOAD:=never}" "${PORT:=2025}" "${REF:=main}" "${TAILSCALE:=off}" "${HOSTNAME_OPTION:=pigui}"

usage() { sed -n '2,/^#   -h/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
	case $1 in
		--where) WHERE=${2:?--where needs local or remote}; shift ;;
		--remote) REMOTE=${2:?--remote needs an address}; WHERE=remote; shift ;;
		--ssh-user) SSH_USER=${2:?--ssh-user needs a user}; shift ;;
		--ssh-key) SSH_KEY=${2:?--ssh-key needs a file}; shift ;;
		--how) HOW=${2:?--how needs sandboxed or full}; shift ;;
		--pi-config) PI_CONFIG=${2:?--pi-config needs overlap or standalone}; shift ;;
		--pi-agent-dir) PI_AGENT_DIR=${2:?--pi-agent-dir needs a directory}; shift ;;
		--user) RUSER=${2:?--user needs a name}; shift ;;
		--ref) REF=${2:?--ref needs a branch, tag or commit}; shift ;;
		--speech) SPEECH=${2:?--speech needs on or off}; shift ;;
		--memory-local) MEMORY_LOCAL=${2:?--memory-local needs on or off}; shift ;;
		--models-unload) MODELS_UNLOAD=${2:?--models-unload needs never or a number of minutes}; shift ;;
		--port) PORT=${2:?--port needs a number}; shift ;;
		--hostname) HOSTNAME_OPTION=${2:?--hostname needs a name}; shift ;;
		--tailscale) TAILSCALE=${2:?--tailscale needs on or off}; shift ;;
		--allowed-logins) ALLOWED_LOGINS=${2?--allowed-logins needs a list, or '' for everyone on the tailnet}; shift ;;
		--tailscale-auth-key) TS_AUTHKEY=${2:?--tailscale-auth-key needs a key}; shift ;;
		--push-subject) PUSH_SUBJECT=${2:?--push-subject needs a URL}; shift ;;
		--spend-cap) SPEND_CAP=${2:?--spend-cap needs dollars}; shift ;;
		--github-token-file) GITHUB_TOKEN_FILE=${2:?--github-token-file needs a file}; shift ;;
		--agent-github-token-file) AGENT_GITHUB_TOKEN_FILE=${2:?--agent-github-token-file needs a file}; shift ;;
		--local-full) LOCAL_FULL=1 ;;
		--uninstall) UNINSTALL=1 ;;
		--dry-run) DRY_RUN=1 ;;
		-h | --help)
			if [[ -f ${BASH_SOURCE[0]:-} ]]; then usage; else echo "See the comment at the top of install.sh, or README.md, \"Install\"."; fi
			exit 0
			;;
		*) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
	esac
	shift
done
[[ $WHERE == "" || $WHERE == local || $WHERE == remote ]] || { echo "--where must be local or remote." >&2; exit 2; }
[[ $HOW == "" || $HOW == sandboxed || $HOW == full ]] || { echo "--how must be sandboxed or full." >&2; exit 2; }
[[ $PI_CONFIG == "" || $PI_CONFIG == overlap || $PI_CONFIG == standalone ]] || { echo "--pi-config must be overlap or standalone." >&2; exit 2; }
[[ $SPEECH == on || $SPEECH == off ]] || { echo "--speech must be on or off." >&2; exit 2; }
[[ $MEMORY_LOCAL == on || $MEMORY_LOCAL == off ]] || { echo "--memory-local must be on or off." >&2; exit 2; }
[[ $TAILSCALE == on || $TAILSCALE == off ]] || { echo "--tailscale must be on or off." >&2; exit 2; }
[[ $PORT =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || { echo "--port must be a number from 1 to 65535." >&2; exit 2; }
[[ $ALLOWED_LOGINS =~ ^[^[:space:]=]*$ ]] || { echo "--allowed-logins takes logins separated by commas, without spaces." >&2; exit 2; }

# ---- Piped from curl, this script has no checkout around it, so it gets one first and runs the copy in it: the
# installed app's when there is one (which updates itself to --ref), otherwise a fresh clone of --ref. A dry run or an
# uninstall with nothing installed fetches --ref into a temporary directory instead, so it changes nothing.
SOURCE_DIR=""
if [[ -n ${BASH_SOURCE[0]:-} && -f $(dirname "${BASH_SOURCE[0]}")/deploy/lib.sh ]]; then
	SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fi
if [[ -z $SOURCE_DIR ]]; then
	command -v git >/dev/null || { echo "pigui needs git. macOS: xcode-select --install. Linux: your package manager, for example sudo apt install git." >&2; exit 1; }
	if [[ -d $APP/.git ]]; then exec bash "$APP/install.sh" ${ARGS[@]+"${ARGS[@]}"}; fi
	if [[ $DRY_RUN == 1 || $UNINSTALL == 1 ]]; then
		scratch=$(mktemp -d)
		trap 'rm -rf "$scratch"' EXIT
		echo "pigui is not installed in $APP: fetching $REF into a temporary directory to run this from"
		git init --quiet "$scratch/pigui"
		git -C "$scratch/pigui" fetch --quiet --depth 1 "$REPOSITORY" "$REF"
		git -C "$scratch/pigui" checkout --quiet FETCH_HEAD
		bash "$scratch/pigui/install.sh" ${ARGS[@]+"${ARGS[@]}"}
		exit
	fi
	mkdir -p "$ROOT"
	git clone --quiet "$REPOSITORY" "$APP"
	exec bash "$APP/install.sh" ${ARGS[@]+"${ARGS[@]}"}
fi

# Output and the dry-run boundary (step, note, run, write_file) are shared with deploy/install.sh.
# shellcheck source=deploy/lib.sh
. "$SOURCE_DIR/deploy/lib.sh"

header "pigui installer"

# The same rule the server applies to PIGUI_MODELS_UNLOAD as it starts, so a bad value stops here rather than there.
unload_valid "$MODELS_UNLOAD" || { echo "--models-unload must be never, or a whole number of idle minutes from 1 to 1440." >&2; exit 2; }

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

# The SSH command, overridable for tests. BatchMode: never prompt, so a missing key is an error, not a hang.
# --ssh-key pins the identity; without it ssh falls back to its default keys and agent.
if [[ -n $SSH_KEY ]]; then
	[[ -f $SSH_KEY && -r $SSH_KEY ]] || { echo "--ssh-key: $SSH_KEY is not a readable file." >&2; exit 2; }
fi
SSH=${PIGUI_SSH:-${SSH_KEY:+ssh -i $SSH_KEY -o IdentitiesOnly=yes}}
SSH=${SSH:-ssh}
ssh_target() { printf '%s@%s' "$SSH_USER" "$REMOTE"; }

# A reachable server with a key already installed, or say what is missing and stop.
# Private keys in ~/.ssh worth trying, default names first. Public halves, configs and known_hosts are not keys.
candidate_keys() {
	local f
	for f in "$HOME"/.ssh/id_* "$HOME"/.ssh/*_ed25519 "$HOME"/.ssh/*_rsa "$HOME"/.ssh/*_ecdsa; do
		[[ -f $f && -r $f && $f != *.pub ]] && grep -q 'PRIVATE KEY' "$f" 2>/dev/null && printf '%s\n' "$f"
	done | awk '!seen[$0]++' | head -10
}

ssh_check() {
	if [[ -z $REMOTE ]]; then
		echo "--remote needs the server's address." >&2
		exit 2
	fi
	if $SSH -o BatchMode=yes -o ConnectTimeout=8 "$(ssh_target)" true 2>/dev/null; then
		return 0
	fi
	# The default keys and agent did not work. If no key was pinned, try the private keys in ~/.ssh before giving up;
	# the first one the server accepts becomes the one this run (and the saved choices) uses.
	if [[ -z $SSH_KEY && -z ${PIGUI_SSH:-} ]]; then
		local key
		while IFS= read -r key; do
			if ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 "$(ssh_target)" true 2>/dev/null; then
				SSH_KEY=$key
				SSH="ssh -i $key -o IdentitiesOnly=yes"
				echo "Using $key to reach $(ssh_target)."
				# Remember it, so the next run does not probe again.
				if [[ $DRY_RUN != 1 && -f $TREE_CONF ]]; then
					if grep -q '^SSH_KEY=' "$TREE_CONF"; then
						sed -i.bak "s|^SSH_KEY=.*|SSH_KEY=$key|" "$TREE_CONF" && rm -f "$TREE_CONF.bak"
					else
						printf 'SSH_KEY=%s\n' "$key" >>"$TREE_CONF"
					fi
				fi
				return 0
			fi
		done < <(candidate_keys)
	fi
	echo "No SSH key installed for $(ssh_target) (or the host is unreachable)." >&2
	echo "Install one first (ssh-copy-id $(ssh_target)), or pass --ssh-key FILE." >&2
	exit 1
}

# Answers are asked on the terminal. When this script arrives on a pipe (curl | bash), stdin is the pipe, so the
# terminal is reached through /dev/tty instead. With neither (CI, a scripted run), there is nothing to ask and the
# flags stand.
HAS_TTY=0
TTY_IN=""
if [[ -t 0 ]]; then
	HAS_TTY=1
elif ( : </dev/tty ) 2>/dev/null; then
	HAS_TTY=1
	TTY_IN=/dev/tty
fi

# One line of an answer, read from the terminal. Sets ANSWER. The prompt goes to stderr (read -p), the answer to stdout.
read_line() {
	if [[ -n $TTY_IN ]]; then
		read -r -p "$1" ANSWER <"$TTY_IN"
	else
		read -r -p "$1" ANSWER
	fi
}

read_secret() {
	if [[ -n $TTY_IN ]]; then
		read -r -s -p "$1" ANSWER <"$TTY_IN"
	else
		read -r -s -p "$1" ANSWER
	fi
	printf '\n'
}

# A question with a default, asked only on a terminal; otherwise the flag (or the default) stands.
ask() {
	local prompt=$1 default=$2
	if [[ $HAS_TTY == 0 ]]; then
		printf '%s' "$default"
		return
	fi
	read_line "${P_CYAN}${prompt}${P_RESET} ${P_DIM}[${default}]${P_RESET} "
	printf '%s' "${ANSWER:-$default}"
}

# A yes/no question with a default, asked only on a terminal.
ask_yes_no() {
	local prompt=$1 default=$2
	if [[ $HAS_TTY == 0 ]]; then
		[[ $default == y ]]
		return
	fi
	read_line "${P_CYAN}${prompt}${P_RESET} ${P_DIM}[${default}]${P_RESET} "
	ANSWER=${ANSWER:-$default}
	[[ $ANSWER == y || $ANSWER == Y || $ANSWER == yes ]]
}

# A numbered choice, asked only on a terminal; otherwise the flag (or the default) stands.
choose() {
	local prompt=$1 default=$2
	shift 2
	local options=("$@") index
	if [[ $HAS_TTY == 0 ]]; then
		printf '%s' "$default"
		return
	fi
	printf '%s\n' "${P_BOLD}${prompt}${P_RESET}" >&2
	for index in "${!options[@]}"; do
		printf '   %s%d)%s %s\n' "${P_CYAN}" "$((index + 1))" "${P_RESET}" "${options[$index]}" >&2
	done
	read_line "${P_DIM}Choose${P_RESET} ${P_DIM}[$((default + 1))]${P_RESET} "
	ANSWER=${ANSWER:-$((default + 1))}
	[[ $ANSWER =~ ^[0-9]+$ ]] && ((ANSWER >= 1 && ANSWER <= ${#options[@]})) || { echo "Not a choice: $ANSWER" >&2; exit 2; }
	printf '%s' "$((ANSWER - 1))"
}

# ---- The questions, in order: container or not, this computer or a server, then the flags.

ask_tree() {
	# 1. Container or not.
	if [[ -z $HOW ]]; then
		local choice
		choice=$(choose "Run pigui in a container (sandboxed), or with full access?" 0 \
			"Container (sandboxed): confined agent commands" \
			"Full access: as you, or as a user you choose, no sandbox")
		HOW=$([[ $choice == 0 ]] && echo sandboxed || echo full)
	fi
	# 2. This computer or a remote server.
	if [[ -z $WHERE ]]; then
		local choice
		choice=$(choose "Where?" 0 \
			"This computer" \
			"A remote server (over SSH)")
		WHERE=$([[ $choice == 0 ]] && echo local || echo remote)
	fi
	if [[ $WHERE == remote && -z $REMOTE ]]; then
		REMOTE=$(ask "The server's address (IP or hostname)" "")
		[[ -n $REMOTE ]] || { echo "A remote server needs an address." >&2; exit 2; }
	fi
	# 3. Full access: which Pi configuration.
	if [[ $HOW == full && -z $PI_CONFIG ]]; then
		local choice
		choice=$(choose "Which Pi configuration should pigui use?" 0 \
			"Overlap: share your existing ~/.pi/agent (sign-in, model, skills)" \
			"Standalone: a separate directory (~/.pigui/pi-agent), no overlap")
		PI_CONFIG=$([[ $choice == 0 ]] && echo overlap || echo standalone)
	fi
	# 4. The flags, each with its default.
	if [[ $HOW == full && $WHERE == local ]]; then
		PORT=$(ask "The localhost port" "$PORT")
	fi
	if [[ $HOW == full && $WHERE == remote ]]; then
		RUSER=$(ask "The user to create and run pigui as" "$RUSER")
	fi
	SPEECH=$(ask "Read replies aloud with Kokoro (on/off)" "$SPEECH")
	MEMORY_LOCAL=$(ask "Embed long-term memory on the machine (on/off)" "$MEMORY_LOCAL")
	if [[ $SPEECH == on || $MEMORY_LOCAL == on ]]; then
		while :; do
			MODELS_UNLOAD=$(ask "Keep the local models loaded (never), or unload them after how many idle minutes" "$MODELS_UNLOAD")
			unload_valid "$MODELS_UNLOAD" && break
			echo "never, or a whole number of minutes from 1 to 1440." >&2
		done
	fi
	TAILSCALE=$(ask "Serve pigui to your tailnet (on/off)" "$TAILSCALE")
	if [[ $TAILSCALE == on ]]; then
		ALLOWED_LOGINS=$(ask "Tailscale logins allowed in, comma-separated (empty for everyone)" "$ALLOWED_LOGINS")
		HOSTNAME_OPTION=$(ask "The Tailscale machine name" "$HOSTNAME_OPTION")
	fi
	# Remember the answers for next time.
	if [[ $DRY_RUN != 1 ]]; then
		mkdir -p "$ROOT"
		{
			printf 'WHERE=%s\nREMOTE=%s\nSSH_USER=%s\nSSH_KEY=%s\nHOW=%s\nPI_CONFIG=%s\nPI_AGENT_DIR=%s\nRUSER=%s\nREF=%s\nSPEECH=%s\nMEMORY_LOCAL=%s\nMODELS_UNLOAD=%s\nPORT=%s\nTAILSCALE=%s\nALLOWED_LOGINS=%s\nHOSTNAME_OPTION=%s\n' \
				"$WHERE" "$REMOTE" "$SSH_USER" "$SSH_KEY" "$HOW" "$PI_CONFIG" "$PI_AGENT_DIR" "$RUSER" "$REF" "$SPEECH" "$MEMORY_LOCAL" "$MODELS_UNLOAD" "$PORT" "$TAILSCALE" "$ALLOWED_LOGINS" "$HOSTNAME_OPTION" >"$TREE_CONF"
		}
	fi
}

# Non-interactive runs need the answers as flags; a terminal (or /dev/tty) is asked instead.
if [[ $LOCAL_FULL == 0 && ( $HAS_TTY == 0 || -n ${PIGUI_ASSUME_YES:-} ) ]]; then
	[[ -n $WHERE ]] || { echo "--where is required without a terminal (local or remote)." >&2; exit 2; }
	[[ -n $HOW ]] || { echo "--how is required without a terminal (sandboxed or full)." >&2; exit 2; }
	[[ $HOW != full || -n $PI_CONFIG ]] || PI_CONFIG=overlap
	elif [[ $LOCAL_FULL == 0 ]]; then
	ask_tree
fi
[[ $HOW == full && -z $PI_CONFIG ]] && PI_CONFIG=overlap
[[ $PI_CONFIG == standalone && -z $PI_AGENT_DIR ]] && PI_AGENT_DIR=$ROOT/pi-agent

# ---- The OnPrem path: pigui on this computer, as you. Also the second phase of a remote full install.

run_onprem() {
	# pigui OnPrem: pigui on this computer, macOS or Linux, as a web app at http://localhost:2025 whose sessions run
	# as you, with your full access — or, as root on a Linux server, as root, as a system service, with the machine's
	# full access. Installs, and when run again updates in place, in the home directory: the app in ~/.pigui/app, its
	# data in ~/.pigui/data, and a service that keeps it running (a LaunchAgent on macOS, a systemd user unit — or, as
	# root, a system unit pigui-onprem.service — on Linux). Nothing outside the home directory changes, and nothing
	# needs sudo, unless it is root itself.

	case $(uname -s) in
		Darwin) SYSTEM=macos ;;
		Linux) SYSTEM=linux ;;
		*) echo "pigui OnPrem runs on macOS and Linux; this is $(uname -s)." >&2; exit 1 ;;
	esac
	PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
	# A user's own unit; as root, a system unit, named apart from the server installer's pigui.service.
	if [[ $AS_ROOT == 1 ]]; then
		SERVICE=pigui-onprem.service
		UNIT=/etc/systemd/system/$SERVICE
		SCOPE=()
		LOG_COMMAND="journalctl -u pigui-onprem"
	else
		SERVICE=pigui.service
		UNIT=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE
		SCOPE=(--user)
		LOG_COMMAND="journalctl --user -u pigui"
	fi
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
		local app=${PIGUI_TAILSCALE_APP:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}
		if [[ -x $app ]]; then echo "$app"; fi
	}

	# The string at a JSON path (a JSON array of keys) in the document on stdin, or nothing; node is here either way.
	json_get() {
		node -e 'let text = ""; process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => { try { let value = JSON.parse(text); for (const key of JSON.parse(process.argv[1])) value = value?.[key]; if (typeof value === "string") process.stdout.write(value); } catch {} });' "$1"
	}

	# This computer's MagicDNS name on the tailnet, without the final dot, or nothing when Tailscale is not up.
	tailnet_name() { "$TS" status --json 2>/dev/null | json_get '["Self","DNSName"]' | sed 's/\.$//'; }

	# Where tailscale serve sends https://NAME/ now, or nothing.
	served_to() { "$TS" serve status --json 2>/dev/null | json_get "[\"Web\",\"$1:443\",\"Handlers\",\"/\",\"Proxy\"]"; }

	# ---- Uninstall: the service, the app and pigui's own tailscale serve go; the data and logs stay.

	if [[ $UNINSTALL == 1 ]]; then
		step "Stop and remove the service"
		if [[ $SYSTEM == macos ]]; then
			stop_launch_agent
			if [[ -f $PLIST ]]; then run rm "$PLIST"; else note "no LaunchAgent at $PLIST"; fi
		elif [[ -f $UNIT ]]; then
			run systemctl ${SCOPE[@]+"${SCOPE[@]}"} disable --now "$SERVICE"
			run rm "$UNIT"
			run systemctl ${SCOPE[@]+"${SCOPE[@]}"} daemon-reload
		else
			note "no systemd unit at $UNIT"
		fi
		TS=$(tailscale_cli || true)
		if [[ -n $TS ]] && command -v node >/dev/null; then
			name=$(tailnet_name)
			if [[ -n $name && $(served_to "$name") == "http://127.0.0.1:$PORT" ]]; then
				step "Stop serving pigui to the tailnet"
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

	if [[ $AS_ROOT == 1 && $SYSTEM == macos ]]; then
		echo "On macOS, run this as yourself, without sudo: pigui OnPrem there is a LaunchAgent of your own user." >&2
		exit 1
	fi
	if [[ $AS_ROOT == 1 ]] && command -v apt-get >/dev/null; then
		step "Install what pigui needs (apt)"
		apt_install ca-certificates curl gnupg git ripgrep unzip build-essential
		current_node=$(node --version 2>/dev/null | sed 's/^v//' || true)
		if [[ -n $current_node ]] && version_at_least "$current_node" "$NODE_MINIMUM"; then
			note "node $current_node"
		else
			install_node "${NODE_MINIMUM%%.*}"
		fi
		if [[ $TAILSCALE == on && -z $(tailscale_cli || true) ]]; then
			release=$(apt_release)
			install_tailscale "$([[ $release == debian/* || $release == ubuntu/* ]] && echo "$release" || echo debian/trixie)"
		fi
	fi

	step "Check this computer"
	note "$([[ $SYSTEM == macos ]] && echo "macOS $(sw_vers -productVersion 2>/dev/null || true)" || echo "Linux $(uname -r)")"
	if [[ $AS_ROOT == 1 ]]; then
		note "as root: pigui runs as root, as a system service, from $ROOT; its sessions can do anything on this machine"
		if [[ -n ${SUDO_USER:-} && $SUDO_USER != root ]]; then note "you ran this with sudo from $SUDO_USER; to install pigui as $SUDO_USER instead, run it without sudo"; fi
	elif sudo -n true 2>/dev/null; then
		note "sudo needs no password here, so the agent's commands can act as root"
	else
		note "the agent's commands run with your rights: sudo would ask for a password, which they cannot answer. For root, install as root, or give $(id -un) passwordless sudo"
	fi
	NODE=$(command -v node || true)
	node_version=$([[ -n $NODE ]] && "$NODE" --version | sed 's/^v//' || true)
	if [[ -z $node_version ]] || ! version_at_least "$node_version" "$NODE_MINIMUM"; then
		echo "pigui needs Node.js $NODE_MINIMUM or newer${node_version:+; this is $node_version}. Install it, for example with Homebrew (brew install node@22) or nvm (nvm install 22), then run this again." >&2
		exit 1
	fi
	note "node $node_version ($NODE)"
	command -v git >/dev/null || { echo "pigui OnPrem needs git. macOS: xcode-select --install. Linux: your package manager." >&2; exit 1; }
	note "$(git --version)"
	if ! command -v gh >/dev/null; then
		note "gh is not installed: sessions on this computer work; repository sessions need gh, signed in (https://cli.github.com)"
	elif gh auth status >/dev/null 2>&1; then
		note "gh is signed in: repository sessions can list, clone and push your repositories"
	else
		note "gh is not signed in: sessions on this computer work; for repository sessions, run gh auth login"
	fi
	if [[ $SYSTEM == linux && $AS_ROOT == 0 ]] && ! systemctl --user show-environment >/dev/null 2>&1; then
		if [[ $DRY_RUN == 1 ]]; then
			note "systemd's user instance is not running for you; the install would stop here"
		else
			echo "systemd's user instance is not running for you, so there is nothing to keep pigui running. Log in to a desktop session, or run 'loginctl enable-linger $USER', then run this again." >&2
			exit 1
		fi
	fi
	[[ $DRY_RUN == 1 ]] && note "dry run: nothing will be changed"

	# ---- The app: the repository at --ref, refusing to overwrite changes made in it.

	step "Fetch pigui ($REF) into $APP"
	if [[ ${PIGUI_ONPREM_FETCHED:-} == "$REF" && $SOURCE_DIR == "$APP" ]]; then
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
		if [[ $DRY_RUN != 1 ]]; then PIGUI_ONPREM_FETCHED=$REF exec bash "$APP/install.sh" --local-full ${ARGS[@]+"${ARGS[@]}"}; fi
	fi

	step "Install its packages and build it"
	run mkdir -p "$DATA" "$LOGS"
	run sh -c "cd '$APP' && npm ci --no-audit --no-fund"
	run sh -c "cd '$APP' && npm run build"

	step "Install the local models (speech $SPEECH, memory $MEMORY_LOCAL)"
	# As deploy/install.sh does: on fetches a model, checked against pinned checksums; off removes it, since pigui turns
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

	# ---- A standalone Pi configuration: a separate directory, with no overlap with ~/.pi/agent.

	if [[ -n $PI_AGENT_DIR ]]; then
		step "Standalone Pi configuration ($PI_AGENT_DIR)"
		run mkdir -p "$PI_AGENT_DIR"
		if [[ ! -f $PI_AGENT_DIR/models.json ]]; then
			if [[ -f $HOME/.pi/agent/models.json ]]; then
				run cp "$HOME/.pi/agent/models.json" "$PI_AGENT_DIR/models.json"
				run chmod 600 "$PI_AGENT_DIR/models.json"
				note "copied models.json from ~/.pi/agent (the provider and its key)"
			else
				note "no models.json in ~/.pi/agent to copy; write one with a provider and its key, or run pi with PI_CODING_AGENT_DIR=$PI_AGENT_DIR and /login"
			fi
		else
			note "models.json is in place"
		fi
		if [[ ! -f $PI_AGENT_DIR/settings.json ]]; then
			# The default provider and model, read from ~/.pi/agent's settings.json when there is one; nothing else comes
			# across, so no packages, extensions or skills overlap.
			defaults=$(node -e 'try { const s = require(process.argv[1]); process.stdout.write(JSON.stringify({ defaultProvider: s.defaultProvider, defaultModel: s.defaultModel })); } catch { process.stdout.write("{}"); }' "$HOME/.pi/agent/settings.json" 2>/dev/null || printf '{}')
			[[ $defaults == "{}" ]] && defaults='{"defaultProvider":"lunaroute","defaultModel":"inkling-2-small"}'
			printf '%s\n' "$defaults" | write_file "$PI_AGENT_DIR/settings.json" 0600 "$OWNER"
			note "wrote a minimal settings.json (default provider and model only)"
		else
			note "settings.json is in place"
		fi
		if [[ ! -f $PI_AGENT_DIR/auth.json ]]; then
			# An empty auth.json: OAuth entries here would fight the ones in ~/.pi/agent over refresh-token rotation, and
			# the key in models.json is what pigui signs with.
			printf '{}' | write_file "$PI_AGENT_DIR/auth.json" 0600 "$OWNER"
			note "wrote an empty auth.json"
		else
			note "auth.json is in place"
		fi
	fi

	step "Check Pi's sign-in"
	# pigui's own check, as it runs at every start: Pi's default model, with credentials, in your Pi configuration.
	if [[ ! -d $APP/node_modules ]]; then
		note "dry run: Pi's sign-in is checked once the app is installed"
	elif (
		cd "$APP"
		[[ -z $PI_AGENT_DIR ]] || export PI_CODING_AGENT_DIR=$PI_AGENT_DIR
		"$NODE" --disable-warning=ExperimentalWarning --input-type=module -e '
		import { getAgentDir } from "@earendil-works/pi-coding-agent";
		import { loadPiModels, NotSignedIn } from "./src/server/pi.ts";
		try { await loadPiModels(getAgentDir()); } catch (error) { if (error instanceof NotSignedIn) process.exit(78); throw error; }
	' </dev/null); then
		note "Pi has a default model it can sign in to"
	else
		echo "Pi is not signed in, so pigui cannot run it. Run $APP/node_modules/.bin/pi (or pi, if you have it), type /login and then /model, then run this again." >&2
		[[ $DRY_RUN == 1 ]] || exit 1
	fi

	# ---- Tailscale. On, pigui is served to the tailnet at https://NAME/ and answers to that name, for a phone on the
	# tailnet; off, pigui's own serve, if it had one, comes down. Never funnel, which would put it on the internet.

	step "Tailscale ($TAILSCALE)"
	TS=$(tailscale_cli || true)
	TS_NAME=$([[ -n $TS ]] && tailnet_name || true)
	OURS=http://127.0.0.1:$PORT
	if [[ $TAILSCALE == on && -n $TS && -z $TS_NAME && $AS_ROOT == 1 ]]; then
		# A login link to open, or the key given; either way the machine joins the tailnet as itself.
		run "$TS" up ${TS_AUTHKEY:+"--auth-key=$TS_AUTHKEY"}
		TS_NAME=$(tailnet_name)
	fi
	if [[ $TAILSCALE == on ]]; then
		problem=""
		if [[ -z $TS ]]; then
			problem="--tailscale on needs Tailscale on this computer, logged in to your tailnet: https://tailscale.com/download (as root on Debian or Ubuntu, this installs it)"
		elif [[ -z $TS_NAME ]]; then
			problem="Tailscale is not running, not logged in, or has no MagicDNS name here. Log in (sudo tailscale up, or run this as root), and turn on MagicDNS and HTTPS certificates in the tailnet's admin console."
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
		note "off: pigui answers at $URL only"
		TS_NAME=""
	fi

	# What the service is told beyond the basics: how it holds its local models, the tailnet name it answers to, the
	# logins it lets in through it, and, for a standalone Pi configuration, where it is.
	plist_env=$'\n\t\t<key>PIGUI_MODELS_UNLOAD</key>\n\t\t<string>'"$MODELS_UNLOAD</string>"
	unit_env=$'\n'"Environment=PIGUI_MODELS_UNLOAD=$MODELS_UNLOAD"
	if [[ -n $TS_NAME ]]; then
		plist_env+=$'\n\t\t<key>PIGUI_ALLOWED_HOSTS</key>\n\t\t<string>'"$(xml "$TS_NAME")</string>"
		unit_env+=$'\n'"Environment=\"PIGUI_ALLOWED_HOSTS=$(unit_value "$TS_NAME")\""
	fi
	if [[ -n $ALLOWED_LOGINS ]]; then
		plist_env+=$'\n\t\t<key>PIGUI_ALLOWED_LOGINS</key>\n\t\t<string>'"$(xml "$ALLOWED_LOGINS")</string>"
		unit_env+=$'\n'"Environment=\"PIGUI_ALLOWED_LOGINS=$(unit_value "$ALLOWED_LOGINS")\""
	fi
	if [[ -n $PI_AGENT_DIR ]]; then
		plist_env+=$'\n\t\t<key>PI_CODING_AGENT_DIR</key>\n\t\t<string>'"$(xml "$PI_AGENT_DIR")</string>"
		unit_env+=$'\n'"Environment=\"PI_CODING_AGENT_DIR=$(unit_value "$PI_AGENT_DIR")\""
	fi

	# ---- The service. launchd and systemd start it with almost no environment, so it gets the PATH your login shell
	# builds (Homebrew, nvm and the like), which is what the agent's commands then find.

	step "Install the service ($([[ $SYSTEM == macos ]] && echo "LaunchAgent $LABEL" || echo "systemd $([[ $AS_ROOT == 1 ]] && echo "system" || echo "user") unit $SERVICE"))"
	login_path=$("${SHELL:-/bin/sh}" -lic 'printf "\n__PIGUI_PATH__%s\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^__PIGUI_PATH__//p' | tail -n1 || true)
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
		<key>PIGUI_ONPREM</key>
		<string>on</string>
		<key>PIGUI_DATA_DIR</key>
		<string>$(xml "$DATA")</string>
		<key>PIGUI_PORT</key>
		<string>$PORT</string>$plist_env
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>$(xml "$LOGS/pigui.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml "$LOGS/pigui.log")</string>
</dict>
</plist>
EOF
	else
		run mkdir -p "$(dirname "$UNIT")"
		# A system unit starts at boot, so it waits for the network and, when it is here, Tailscale.
		unit_after=$([[ $AS_ROOT == 1 ]] && printf '\nWants=network-online.target\nAfter=network-online.target tailscaled.service' || true)
		write_file "$UNIT" 0644 "$OWNER" <<EOF
[Unit]
Description=pigui OnPrem: the Pi coding agent on this computer, at $URL$unit_after

[Service]
Type=simple
WorkingDirectory=$(unit_value "$APP")
Environment="PATH=$(unit_value "$SERVICE_PATH")"
Environment=PIGUI_ONPREM=on
Environment="PIGUI_DATA_DIR=$(unit_value "$DATA")"
Environment=PIGUI_PORT=$PORT$unit_env
ExecStart="$(unit_value "$NODE")" --disable-warning=ExperimentalWarning "$(unit_value "$APP/src/server/main.ts")"
Restart=on-failure
RestartSec=5
# 78 means Pi is not signed in, 2 that the configuration is wrong: restarting cannot fix either.
RestartPreventExitStatus=78 2
TimeoutStopSec=60

[Install]
WantedBy=$([[ $AS_ROOT == 1 ]] && echo multi-user.target || echo default.target)
EOF
	fi

	step "Start (or restart) pigui"
	if [[ $SYSTEM == macos ]]; then
		stop_launch_agent
		run launchctl bootstrap "$DOMAIN" "$PLIST"
	else
		run systemctl ${SCOPE[@]+"${SCOPE[@]}"} daemon-reload
		run systemctl ${SCOPE[@]+"${SCOPE[@]}"} enable "$SERVICE"
		run systemctl ${SCOPE[@]+"${SCOPE[@]}"} restart "$SERVICE"
	fi
	logs=$([[ $SYSTEM == macos ]] && echo "$LOGS/pigui.log" || echo "$LOG_COMMAND")
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
			echo "pigui did not answer at $URL within a minute. Its log says why: $logs" >&2
			exit 1
		fi
	fi
	# Kept for the next run, which updates pigui with the same choices unless told otherwise.
	write_file "$CONF" 0644 "$OWNER" <<EOF
SPEECH=$SPEECH
MEMORY_LOCAL=$MEMORY_LOCAL
MODELS_UNLOAD=$MODELS_UNLOAD
PORT=$PORT
REF=$REF
TAILSCALE=$TAILSCALE
ALLOWED_LOGINS=$ALLOWED_LOGINS
PI_AGENT_DIR=$PI_AGENT_DIR
EOF

	printf '\npigui OnPrem %s at %s\n' "$([[ $DRY_RUN == 1 ]] && echo "would run" || echo "is running")" "$URL"
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
}

install_local_sandboxed() {
	step "Check Docker"
	if ! command -v docker >/dev/null; then
		echo "Docker is not installed. Install Docker Desktop (https://docs.docker.com/desktop/) or Docker Engine, start it, and run this again." >&2
		exit 1
	fi
	if ! docker info >/dev/null 2>&1; then
		echo "Docker is installed but not running (or this user cannot reach it). Start Docker and run this again." >&2
		exit 1
	fi
	note "$(docker --version)"

	step "Prepare .env"
	env_file="$SOURCE_DIR/.env"
	if [[ ! -f $env_file ]]; then
		run cp "$SOURCE_DIR/.env.example" "$env_file"
		note "created .env from .env.example"
	fi
	# The tokens: the environment, else this computer's .env, else this computer's gh login for pigui's own token;
	# the agent's read-only token has no source to derive from, so it is asked for or the install stops with instructions.
	local gh_token=${GH_TOKEN:-}
	[[ -z $gh_token ]] && gh_token=$(grep '^GH_TOKEN=' "$env_file" | cut -d= -f2-)
	local agent_token=${AGENT_GH_TOKEN:-}
	[[ -z $agent_token ]] && agent_token=$(grep '^AGENT_GH_TOKEN=' "$env_file" | cut -d= -f2-)
	if [[ -z $gh_token ]]; then
		if command -v gh >/dev/null && gh auth token >/dev/null 2>&1; then
			if ask_yes_no "Use this computer's gh token as pigui's own token (GH_TOKEN)?" y; then
				gh_token=$(gh auth token)
				[[ $DRY_RUN == 1 ]] || sed -i.bak "s|^GH_TOKEN=.*|GH_TOKEN=$gh_token|" "$env_file" && rm -f "$env_file.bak"
				note "GH_TOKEN set from gh auth token"
			fi
		fi
	fi
	if [[ -z $agent_token ]]; then
		if [[ $HAS_TTY == 1 ]]; then
			read_secret "${P_CYAN}The agent's read-only token (AGENT_GH_TOKEN, Contents and Metadata: read), or empty to stop:${P_RESET} "
			agent_token=$ANSWER
			if [[ -n $agent_token ]]; then
				[[ $DRY_RUN == 1 ]] || sed -i.bak "s|^AGENT_GH_TOKEN=.*|AGENT_GH_TOKEN=$agent_token|" "$env_file" && rm -f "$env_file.bak"
				note "AGENT_GH_TOKEN set"
			fi
		fi
	fi
	[[ -z $gh_token ]] && gh_token=$(grep '^GH_TOKEN=' "$env_file" | cut -d= -f2-)
	[[ -z $agent_token ]] && agent_token=$(grep '^AGENT_GH_TOKEN=' "$env_file" | cut -d= -f2-)
	# The answers about the local models go where compose reads them: speech and memory at the build, unloading at start.
	local key value
	for key in PIGUI_SPEECH PIGUI_MEMORY_LOCAL PIGUI_MODELS_UNLOAD; do
		case $key in
			PIGUI_SPEECH) value=$SPEECH ;;
			PIGUI_MEMORY_LOCAL) value=$MEMORY_LOCAL ;;
			PIGUI_MODELS_UNLOAD) value=$MODELS_UNLOAD ;;
		esac
		if [[ $DRY_RUN == 1 ]]; then
			note "[dry run] $key=$value in .env"
		elif grep -q "^$key=" "$env_file"; then
			sed -i.bak "s|^$key=.*|$key=$value|" "$env_file" && rm -f "$env_file.bak"
		else
			printf '%s=%s\n' "$key" "$value" >>"$env_file"
		fi
	done
	if [[ -z $gh_token || -z $agent_token ]]; then
		echo "GH_TOKEN and AGENT_GH_TOKEN must be set in $env_file. See .env.example; the agent's token is read-only (Contents and Metadata: read)." >&2
		exit 1
	fi

	step "Build the image"
	run docker compose -f "$SOURCE_DIR/compose.yaml" --project-directory "$SOURCE_DIR" build

	step "Start pigui"
	run docker compose -f "$SOURCE_DIR/compose.yaml" --project-directory "$SOURCE_DIR" up -d

	printf '\npigui is starting. Access is through the tailnet only: https://%s.<tailnet>.ts.net\n' "${PIGUI_TS_HOSTNAME:-pigui}"
	printf 'Sign Pi in once: docker compose -f %s/compose.yaml run --rm pigui pi   (then /login, /model, /quit)\n' "$SOURCE_DIR"
	printf 'Then: docker compose -f %s/compose.yaml restart pigui\n' "$SOURCE_DIR"
	printf 'Logs: docker compose -f %s/compose.yaml logs -f pigui\n' "$SOURCE_DIR"
}

# ---- Remote (sandboxed): a server over SSH, pigui in a systemd service as its own user, agent commands confined by
# Landlock. Runs deploy/install.sh on the server.

install_remote_sandboxed() {
	[[ $SSH_USER == root ]] || { echo "The remote paths need root on the server (the sandboxed installer creates a system user and writes /etc). Use --ssh-user root." >&2; exit 2; }
	ssh_check
	local target
	target=$(ssh_target)

	step "Clone pigui ($REF) on $REMOTE"
	# A private repository: the server signs in to GitHub first, with this computer's token, so the clone works.
	local gh_token=${GH_TOKEN:-}
	if [[ -n $GITHUB_TOKEN_FILE ]]; then gh_token=$(cat "$GITHUB_TOKEN_FILE"); fi
	if [[ -z $gh_token && -f $SOURCE_DIR/.env ]]; then gh_token=$(grep '^GH_TOKEN=' "$SOURCE_DIR/.env" | cut -d= -f2-); fi
	if [[ -z $gh_token ]] && command -v gh >/dev/null && gh auth token >/dev/null 2>&1; then gh_token=$(gh auth token); fi
	if [[ -z $gh_token ]]; then
		echo "No GitHub token to clone the private repository with: set GH_TOKEN in $SOURCE_DIR/.env, or sign in to gh on this computer." >&2
		exit 1
	fi
	run $SSH "$target" "command -v gh >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh git)"
	if [[ $DRY_RUN == 1 ]]; then
		note "[dry run] gh auth login --with-token on $REMOTE (token from this computer)"
	else
		printf '%s' "$gh_token" | $SSH "$target" "gh auth status >/dev/null 2>&1 || gh auth login --with-token"
	fi
	run $SSH "$target" "gh auth setup-git"
	run $SSH "$target" "if [ -d /root/pigui-src/.git ]; then git -C /root/pigui-src fetch --quiet origin '$REF' && git -C /root/pigui-src checkout --quiet --detach FETCH_HEAD; else git clone --quiet --branch '$REF' '$REPOSITORY' /root/pigui-src; fi"

	step "Copy the tokens to $REMOTE"
	local agent_token=${AGENT_GH_TOKEN:-}
	if [[ -n $AGENT_GITHUB_TOKEN_FILE ]]; then agent_token=$(cat "$AGENT_GITHUB_TOKEN_FILE"); fi
	if [[ -z $agent_token && -f $SOURCE_DIR/.env ]]; then agent_token=$(grep '^AGENT_GH_TOKEN=' "$SOURCE_DIR/.env" | cut -d= -f2-); fi
	if [[ -z $agent_token ]]; then
		echo "No AGENT_GH_TOKEN in $SOURCE_DIR/.env: the agent's read-only token (Contents and Metadata: read) is required." >&2
		exit 1
	fi
	if [[ $DRY_RUN == 1 ]]; then
		note "[dry run] write /root/github-token and /root/agent-github-token on $REMOTE (mode 600)"
	else
		printf '%s' "$gh_token" | $SSH "$target" "cat > /root/github-token && chmod 600 /root/github-token"
		printf '%s' "$agent_token" | $SSH "$target" "cat > /root/agent-github-token && chmod 600 /root/agent-github-token"
	fi

	step "Run the server installer on $REMOTE"
	local extra=()
	[[ -n $TS_AUTHKEY ]] && extra+=(--tailscale-auth-key "$TS_AUTHKEY")
	[[ -n $PUSH_SUBJECT ]] && extra+=(--push-subject "$PUSH_SUBJECT")
	[[ -n $SPEND_CAP ]] && extra+=(--spend-cap "$SPEND_CAP")
	[[ -n $ALLOWED_LOGINS ]] && extra+=(--allowed-logins "$ALLOWED_LOGINS")
	extra+=(--hostname "$HOSTNAME_OPTION" --speech "$SPEECH" --memory-local "$MEMORY_LOCAL" --models-unload "$MODELS_UNLOAD")
	extra+=(--github-token-file /root/github-token --agent-github-token-file /root/agent-github-token)
	printf -v extra_quoted '%q ' "${extra[@]}"
	run $SSH "$target" "bash /root/pigui-src/deploy/install.sh $extra_quoted"

	printf '\npigui is installing on %s. When it finishes, the steps that need a person are printed there (sign Pi in, open the phone app).\n' "$REMOTE"
}

# ---- Remote (full): a server over SSH, pigui as a user of your choosing with that user's full access (OnPrem over
# SSH). Creates the user, copies this computer's GitHub and Pi credentials to it, and installs.

install_remote_full() {
	[[ $SSH_USER == root ]] || { echo "The remote paths need root on the server (creating the user and installing packages). Use --ssh-user root." >&2; exit 2; }
	ssh_check
	local target
	target=$(ssh_target)

	step "Create the user $RUSER on $REMOTE"
	run $SSH "$target" "id -u '$RUSER' >/dev/null 2>&1 || useradd -m -s /bin/bash '$RUSER'"
	run $SSH "$target" "usermod -aG sudo '$RUSER'"
	run $SSH "$target" "loginctl enable-linger '$RUSER' || true"

	step "Install Node.js 22, gh and Tailscale on $REMOTE"
	run $SSH "$target" "command -v node >/dev/null && node --version | grep -qE '^v(2[2-9]|[3-9][0-9])\.' || (cd /tmp && curl -fsSLO https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.xz && tar -xJf node-v22.21.1-linux-x64.tar.xz -C /usr/local --strip-components=1 && rm node-v22.21.1-linux-x64.tar.xz)"
	run $SSH "$target" "DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates gh ripgrep unzip build-essential"
	run $SSH "$target" "command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh"

	step "Copy the GitHub credentials to $REMOTE"
	local gh_token=${GH_TOKEN:-}
	if [[ -z $gh_token ]] && command -v gh >/dev/null && gh auth token >/dev/null 2>&1; then gh_token=$(gh auth token); fi
	if [[ -z $gh_token ]]; then
		echo "No GitHub token to copy: sign in to gh on this computer (gh auth login), and run this again." >&2
		exit 1
	fi
	if [[ $DRY_RUN == 1 ]]; then
		note "[dry run] gh auth login --with-token as $RUSER on $REMOTE (token from this computer)"
	else
		printf '%s' "$gh_token" | $SSH "$target" "sudo -u '$RUSER' gh auth login --with-token && sudo -u '$RUSER' gh auth setup-git"
	fi

	step "Copy the Pi configuration to $REMOTE ($PI_CONFIG)"
	if [[ $PI_CONFIG == overlap ]]; then
		# Sessions and backups stay behind; the sign-in, models, settings and skills cross.
		run $SSH "$target" "mkdir -p /home/'$RUSER'/.pi && chown '$RUSER':'$RUSER' /home/'$RUSER'/.pi"
		run bash -c "tar -C '$HOME/.pi' --exclude=sessions --exclude=backups -czf - agent | '$SSH' '$target' \"tar -C /home/'$RUSER'/.pi -xzf - && chown -R '$RUSER':'$RUSER' /home/'$RUSER'/.pi\""
	else
		# Standalone: the local standalone directory when there is one, else one built from ~/.pi/agent's models.json.
		if [[ -d $ROOT/pi-agent ]]; then
			run $SSH "$target" "mkdir -p /home/'$RUSER'/.pigui && chown '$RUSER':'$RUSER' /home/'$RUSER'/.pigui"
			run bash -c "tar -C '$ROOT' -czf - pi-agent | '$SSH' '$target' \"tar -C /home/'$RUSER'/.pigui -xzf - && chown -R '$RUSER':'$RUSER' /home/'$RUSER'/.pigui\""
		else
			run $SSH "$target" "mkdir -p /home/'$RUSER'/.pigui/pi-agent && chown -R '$RUSER':'$RUSER' /home/'$RUSER'/.pigui"
			if [[ -f $HOME/.pi/agent/models.json ]]; then
				run bash -c "tar -C '$HOME/.pi/agent' -czf - models.json | '$SSH' '$target' \"tar -C /home/'$RUSER'/.pigui/pi-agent -xzf - && chmod 600 /home/'$RUSER'/.pigui/pi-agent/models.json && chown -R '$RUSER':'$RUSER' /home/'$RUSER'/.pigui\""
			fi
		fi
	fi

	if [[ $TAILSCALE == on ]]; then
		step "Join Tailscale on $REMOTE"
		if [[ -z $TS_AUTHKEY ]] && [[ $HAS_TTY == 1 ]]; then
			read_secret "${P_CYAN}A Tailscale auth key (empty to log in from the link in the logs):${P_RESET} "
			TS_AUTHKEY=$ANSWER
		fi
		if [[ -n $TS_AUTHKEY ]]; then
			run $SSH "$target" "tailscale up --authkey='$TS_AUTHKEY' --hostname='$HOSTNAME_OPTION'"
		else
			run $SSH "$target" "tailscale up --hostname='$HOSTNAME_OPTION'"
		fi
		run $SSH "$target" "tailscale set --operator='$RUSER'"
	fi

	step "Install pigui on $REMOTE"
	local remote_args=(--local-full --ref "$REF" --speech "$SPEECH" --memory-local "$MEMORY_LOCAL" --models-unload "$MODELS_UNLOAD" --tailscale "$TAILSCALE" --allowed-logins "$ALLOWED_LOGINS" --hostname "$HOSTNAME_OPTION")
	[[ $PI_CONFIG == standalone ]] && remote_args+=(--pi-config standalone --pi-agent-dir /home/"$RUSER"/.pigui/pi-agent)
	printf -v remote_quoted '%q ' "${remote_args[@]}"
	# The script pipes itself to the server, which clones the repository and runs the OnPrem path there as the user.
	run $SSH "$(printf '%s@%s' "$RUSER" "$REMOTE")" "XDG_RUNTIME_DIR=/run/user/\$(id -u) bash -s -- $remote_quoted" <"$SOURCE_DIR/install.sh"

	printf '\npigui is installing on %s as %s. When it finishes: https://%s.<tailnet>.ts.net (or http://%s:2025 on the server).\n' "$REMOTE" "$RUSER" "$HOSTNAME_OPTION" "$REMOTE"
}

# Before anything changes, show the resolved choices once and ask (interactive runs only; with flags or no terminal,
# the answers are taken as given).
if [[ $LOCAL_FULL == 0 && $HAS_TTY == 1 && -z ${PIGUI_ASSUME_YES:-} ]]; then
	header "Your choices"
	if [[ $WHERE == local ]]; then place="this computer"; else place="a remote server at $REMOTE (over SSH)"; fi
	info "$(printf '%-10s %s' 'Where' "$place")"
	if [[ $HOW == sandboxed ]]; then access="container (sandboxed)"; else access="full access"; fi
	info "$(printf '%-10s %s' 'Access' "$access")"
	if [[ $HOW == full ]]; then
		if [[ $PI_CONFIG == standalone ]]; then pi_config="standalone ($PI_AGENT_DIR)"; else pi_config="overlap (~/.pi/agent)"; fi
		info "$(printf '%-10s %s' 'Pi config' "$pi_config")"
	fi
	info "$(printf '%-10s %s' 'Speech' "$SPEECH (dictation read aloud by Kokoro)")"
	info "$(printf '%-10s %s' 'Memory' "$MEMORY_LOCAL (local embeddings)")"
	if [[ $SPEECH == on || $MEMORY_LOCAL == on ]]; then
		if [[ $MODELS_UNLOAD == never ]]; then models="loaded from start"; else models="unloaded after $MODELS_UNLOAD idle minutes"; fi
		info "$(printf '%-10s %s' 'Models' "$models")"
	fi
	if [[ $TAILSCALE == on ]]; then
		info "$(printf '%-10s %s' 'Tailscale' "on, as $HOSTNAME_OPTION (allowed logins: ${ALLOWED_LOGINS:-everyone on the tailnet})")"
	else
		info "$(printf '%-10s %s' 'Tailscale' 'off')"
	fi
	if [[ $HOW == full && $WHERE == local ]]; then info "$(printf '%-10s %s' 'Port' "$PORT")"; fi
	if [[ $HOW == full && $WHERE == remote ]]; then info "$(printf '%-10s %s' 'User' "$RUSER")"; fi
	read_line "${P_CYAN}Proceed with the install?${P_RESET} ${P_DIM}[Y/n]${P_RESET} "
	case ${ANSWER:-y} in
		y | Y | yes | YES | "") ;;
		*) info "Not installed."; exit 0 ;;
	esac
fi

# ---- Dispatch.

if [[ $LOCAL_FULL == 1 ]]; then
	[[ $PI_CONFIG == standalone && -z $PI_AGENT_DIR ]] && PI_AGENT_DIR=$ROOT/pi-agent
	run_onprem
	exit 0
fi
case "$WHERE/$HOW" in
	local/sandboxed) install_local_sandboxed ;;
	local/full) run_onprem ;;
	remote/sandboxed) install_remote_sandboxed ;;
	remote/full) install_remote_full ;;
	*) echo "--where and --how are required (local or remote; sandboxed or full)." >&2; exit 2 ;;
esac
