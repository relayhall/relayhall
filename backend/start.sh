#!/bin/sh
# Apply migrations at the container upgrade boundary. PostgreSQL's official
# image briefly accepts connections while running first-boot init scripts and
# then restarts; tolerate that bounded readiness window without ever starting
# the API after an unresolved migration failure.
set -eu

attempt=1
max_attempts="${MIGRATION_STARTUP_ATTEMPTS:-15}"
delay="${MIGRATION_STARTUP_DELAY_SECONDS:-2}"

# Keep values inside ranges that POSIX test implementations can compare safely.
# Shape validation alone is insufficient: an oversized all-digit value can
# overflow dash's integer comparison and turn the bounded retry into a loop.
case "$max_attempts" in
  [1-9]|[1-9][0-9]|100) ;;
  *)
    echo "MIGRATION_STARTUP_ATTEMPTS must be an integer from 1 to 100" >&2
    exit 1
    ;;
esac
case "$delay" in
  0|[1-9]|[1-9][0-9]|[12][0-9][0-9]|300) ;;
  *)
    echo "MIGRATION_STARTUP_DELAY_SECONDS must be an integer from 0 to 300" >&2
    exit 1
    ;;
esac

while ! node dist/db/migrate.js; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "Migration failed after $attempt attempts; refusing to start the API" >&2
    exit 1
  fi
  echo "Migration attempt $attempt failed; retrying in ${delay}s" >&2
  attempt=$((attempt + 1))
  sleep "$delay"
done

exec node dist/server.js
