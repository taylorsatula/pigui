#!/usr/bin/env bash
# picloud OnPrem, kept for the links and habits that point here: the installer is now install.sh at the repository
# root, and this runs its OnPrem path (picloud on this computer, as you, at http://localhost:2025).
#
#   deploy/onprem.sh [options]   ==   install.sh --local-full [options]
#
# Options are the same as install.sh's OnPrem path: --speech, --memory-local, --port, --ref, --tailscale,
# --allowed-logins, --pi-agent-dir, --dry-run, --uninstall, -h. See install.sh --help, or README.md, "Install".
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install.sh" --local-full "$@"
