#!/bin/sh
# RelayHall entrypoint — handles PUID/PGID for board-owned persistent data.
# If running as root, create a user with PUID/PGID and drop privileges.
# Otherwise, run as the current user.

set -e

PUID="${PUID:-1002}"
PGID="${PGID:-1002}"

# If running as root, create user and drop privileges
if [ "$(id -u)" = "0" ]; then
  echo "🔧 Entrypoint: Dropping to PUID=$PUID PGID=$PGID"

  getent group "$PGID" >/dev/null 2>&1 || groupadd -g "$PGID" appgroup
  id -u appuser >/dev/null 2>&1 || useradd -M -u "$PUID" -g "$PGID" -d /app -s /bin/sh appuser

  mkdir -p /data
  chown -R "$PUID:$PGID" /data

  exec gosu "$PUID:$PGID" "$@"
else
  # Already running as non-root, just exec
  exec "$@"
fi
