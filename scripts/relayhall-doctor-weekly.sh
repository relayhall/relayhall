#!/usr/bin/env bash
# Weekly RelayHall doctor run + Discord summary delivery via hermes send.
# Intended to run from cron under a service account with explicitly scoped delivery access.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
python3 cli/relayhall doctor --json --deliver hermes-discord
rc=$?
# doctor exits 2 when error-severity integrity findings are present. For weekly
# notification purposes, a delivered summary is success; reserve nonzero for
# command/runtime/delivery failure so cron logs can alert on broken plumbing.
if [ "$rc" = "2" ]; then
  exit 0
fi
exit "$rc"
