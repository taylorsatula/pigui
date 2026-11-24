#!/usr/bin/env bash
# Trim a machine that does nothing but run pigui, set up by the installer or with Docker, so more of a small
# droplet is left for the agent's builds and tests:
#   - stop and mask services such a machine never uses (units a system does not have are skipped);
#   - add a swap file, so a test run that spikes past memory slows down instead of being killed;
#   - cap the system journal's disk use.
# Kept on purpose: SSH, networking, DNS, time sync, cron, AppArmor, security updates, cloud-init and the provider's
# agents (resizing, the web console, backups). For Debian 13 (recommended) and Ubuntu 24.04; re-running is safe, and
# the end says how to undo it.
#
#   sudo deploy/trim.sh [options]
#
# Options (each may also be given as the environment variable in brackets):
#   --dry-run       show every step without changing anything               [PIGUI_DRY_RUN=1]
#   --swap SIZE     swap file size, such as 2G or 512M; 0 for none (2G)     [PIGUI_SWAP]
#   -h, --help      show this help
set -euo pipefail

readonly SWAP_FILE=/swapfile
readonly JOURNAL_CAP=200M
readonly SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

DRY_RUN=${PIGUI_DRY_RUN:-0}
SWAP=${PIGUI_SWAP:-2G}

usage() { sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
	case $1 in
		--dry-run) DRY_RUN=1 ;;
		--swap) SWAP=${2:?}; shift ;;
		-h | --help) usage; exit 0 ;;
		*) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
	esac
	shift
done

# shellcheck source=deploy/lib.sh
. "$SOURCE_DIR/deploy/lib.sh"

# Units that go, a group per line with why it can go. Masked rather than disabled, because several are started on
# demand over D-Bus, which disabling does not stop.
readonly UNUSED=(
	"snapd.service snapd.socket snapd.seeded.service|snap packages: nothing pigui uses comes from one"
	"multipathd.service multipathd.socket|multipath storage, which a droplet's disk does not use"
	"iscsid.socket iscsid.service open-iscsi.service|iSCSI disks"
	"ModemManager.service|mobile modems"
	"udisks2.service|desktop disk management"
	"packagekit.service|graphical package management; apt still installs updates"
	"fwupd.service fwupd-refresh.timer|firmware updates, which a virtual machine's host looks after"
	"apport.service apport-autoreport.path apport-forward.socket|crash reports to Ubuntu"
	"irqbalance.service|spreading interrupts across CPUs, which one or two vCPUs gain little from"
	"rsyslog.service|a second copy of the system log; journalctl keeps it all"
	"motd-news.timer update-notifier-download.timer update-notifier-motd.timer|news and notices for the login banner"
	"ua-timer.timer esm-cache.service apt-news.service ubuntu-advantage.service|Ubuntu Pro status checks"
	"man-db.timer|rebuilding the manual page index every day"
	"lxd-installer.socket|installing LXD on first use"
)

memory() { free -m | awk '/^Mem:/ { printf "%s MB of %s MB in use", $3, $2 } /^Swap:/ { printf ", swap %s MB", $2 }'; }

step "Check the machine"
if [[ $DRY_RUN != 1 && $EUID -ne 0 ]]; then
	echo "Run as root (sudo deploy/trim.sh), or with --dry-run to see what it would do." >&2
	exit 1
fi
[[ $SWAP == 0 || $SWAP =~ ^[1-9][0-9]*[MG]$ ]] || { echo "--swap must look like 2G or 512M, or be 0." >&2; exit 2; }
command -v systemctl >/dev/null || { echo "This machine does not use systemd; nothing to trim." >&2; exit 1; }
note "memory: $(memory)"
[[ $DRY_RUN == 1 ]] && note "dry run: nothing will be changed"

step "Stop services this machine never uses"
masked=()
for entry in "${UNUSED[@]}"; do
	why=${entry#*|}
	present=()
	todo=()
	for unit in ${entry%%|*}; do
		[[ -n $(systemctl list-unit-files --no-legend "$unit" 2>/dev/null) ]] || continue
		present+=("$unit")
		[[ $(systemctl is-enabled "$unit" 2>/dev/null || true) == masked ]] || todo+=("$unit")
	done
	[[ ${#present[@]} -gt 0 ]] || continue
	masked+=("${present[@]}")
	if [[ ${#todo[@]} -eq 0 ]]; then
		note "${present[*]}: already off"
	else
		note "${todo[*]}: $why"
		run systemctl mask --now "${todo[@]}"
	fi
done
[[ ${#masked[@]} -gt 0 ]] || note "none of them are installed"

step "Add a swap file ($SWAP)"
if [[ $SWAP == 0 ]]; then
	note "skipped (--swap 0)"
elif [[ -n $(swapon --show --noheadings 2>/dev/null) ]]; then
	note "swap is already on: $(swapon --show --noheadings | awk '{ print $1 " (" $3 ")" }' | paste -sd ' ')"
else
	size_mb=${SWAP%?}
	[[ $SWAP == *G ]] && size_mb=$((size_mb * 1024))
	free_mb=$(df --output=avail -BM / | tail -n1 | tr -dc '0-9')
	# Leave room for workspaces: the swap file may take at most half of what is free.
	if ((size_mb * 2 > free_mb)); then
		note "only ${free_mb} MB free on /; skipped. Re-run with a smaller --swap."
	else
		run fallocate -l "$SWAP" "$SWAP_FILE"
		run chmod 600 "$SWAP_FILE"
		run mkswap "$SWAP_FILE"
		run swapon "$SWAP_FILE"
		grep -qs "^$SWAP_FILE " /etc/fstab || run sh -c "echo '$SWAP_FILE none swap sw 0 0' >> /etc/fstab"
	fi
fi
if [[ $SWAP != 0 ]]; then
	# A minimal system may have no /etc/sysctl.d, with its defaults in /usr/lib/sysctl.d only.
	run install -d -m 0755 /etc/sysctl.d
	write_file /etc/sysctl.d/90-pigui.conf 0644 root:root <<EOF
# Swap only under memory pressure: it catches a test run's spike without slowing everyday work. From deploy/trim.sh.
vm.swappiness=10
EOF
	run sysctl -q -p /etc/sysctl.d/90-pigui.conf
fi

step "Cap the system journal at $JOURNAL_CAP"
run install -d -m 0755 /etc/systemd/journald.conf.d
write_file /etc/systemd/journald.conf.d/90-pigui.conf 0644 root:root <<EOF
# pigui logs every request; this keeps the journal from filling a small disk. From deploy/trim.sh.
[Journal]
SystemMaxUse=$JOURNAL_CAP
EOF
run systemctl restart systemd-journald

step "Status"
note "memory: $(memory)"
printf '\n== To undo\n'
[[ ${#masked[@]} -gt 0 ]] && note "sudo systemctl unmask ${masked[*]}, then reboot"
note "swap: sudo swapoff $SWAP_FILE, delete it and its line in /etc/fstab, and /etc/sysctl.d/90-pigui.conf"
note "journal: delete /etc/systemd/journald.conf.d/90-pigui.conf and restart systemd-journald"
