#!/usr/bin/env bash
# Restore a compressed SQL dump into the current RelayHall Compose project.
set -euo pipefail
umask 077

if [ ! -f .env ]; then
  echo "Error: .env not found. Run from the RelayHall repository root." >&2
  exit 1
fi

read_env() {
  local wanted=$1 fallback=$2 key value
  while IFS='=' read -r key value; do
    [ "$key" = "$wanted" ] && { printf '%s' "$value"; return; }
  done < .env
  printf '%s' "$fallback"
}

BACKUP_DIR=${BACKUP_DIR:-$(read_env BACKUP_DIR ./backups)}
ASSUME_YES=false
if [ "${1:-}" = "--yes" ]; then ASSUME_YES=true; shift; fi
BACKUP_FILE=${1:-}

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if [ -z "$BACKUP_FILE" ]; then
  mapfile -t BACKUPS < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'relayhall_*.sql.gz' -printf '%T@ %p\n' \
    | sort -rn | cut -d' ' -f2-)
  if [ "${#BACKUPS[@]}" -eq 0 ]; then
    echo "No RelayHall backups found in $BACKUP_DIR" >&2
    exit 1
  fi
  printf 'Available backups:\n'
  for i in "${!BACKUPS[@]}"; do printf '  [%d] %s\n' "$((i + 1))" "${BACKUPS[$i]}"; done
  read -r -p "Select backup number: " selection
  [[ "$selection" =~ ^[0-9]+$ ]] || { echo "Invalid selection" >&2; exit 1; }
  [ "$selection" -ge 1 ] && [ "$selection" -le "${#BACKUPS[@]}" ] || { echo "Invalid selection" >&2; exit 1; }
  BACKUP_FILE=${BACKUPS[$((selection - 1))]}
fi

[ -f "$BACKUP_FILE" ] || { echo "Backup not found: $BACKUP_FILE" >&2; exit 1; }
gzip -t "$BACKUP_FILE" || { echo "Backup is not a valid gzip stream: $BACKUP_FILE" >&2; exit 1; }
[ -n "$(docker compose ps --status running -q relayhall-db)" ] || { echo "Database service is not running" >&2; exit 1; }

if ! $ASSUME_YES; then
  read -r -p "Restore $BACKUP_FILE and replace current data? Type yes: " confirm
  [ "$confirm" = yes ] || { echo "Restore cancelled"; exit 0; }
fi

SAFETY_BACKUP="$BACKUP_DIR/pre-restore_$(date +%Y%m%d_%H%M%S).sql.gz"
SAFETY_TEMP=$(mktemp "$BACKUP_DIR/.pre-restore.XXXXXX.sql.gz")
BACKEND_STOPPED=false
RESTART_BACKEND_ON_EXIT=true
cleanup() {
  rm -f -- "$SAFETY_TEMP"
  if $BACKEND_STOPPED && $RESTART_BACKEND_ON_EXIT; then
    docker compose start relayhall-backend >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

restart_backend() {
  if ! docker compose start relayhall-backend >/dev/null; then
    RESTART_BACKEND_ON_EXIT=false
    echo "Backend could not be restarted; leave it stopped and recover manually." >&2
    return 1
  fi
  BACKEND_STOPPED=false
}

docker compose exec -T relayhall-db sh -eu -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' | gzip > "$SAFETY_TEMP"
gzip -t "$SAFETY_TEMP"
chmod 600 "$SAFETY_TEMP"
mv -- "$SAFETY_TEMP" "$SAFETY_BACKUP"

docker compose stop relayhall-backend >/dev/null
BACKEND_STOPPED=true

if gunzip -c "$BACKUP_FILE" | docker compose exec -T relayhall-db sh -eu -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'; then
  :
else
  RESTORE_RC=$?
  echo "Restore failed; applying safety backup." >&2
  if gunzip -c "$SAFETY_BACKUP" | docker compose exec -T relayhall-db sh -eu -c \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'; then
    restart_backend
    echo "Requested restore failed; safety backup restored and backend restarted." >&2
    exit "$RESTORE_RC"
  else
    ROLLBACK_RC=$?
    RESTART_BACKEND_ON_EXIT=false
    echo "CRITICAL: restore and safety rollback both failed; backend remains stopped for manual recovery." >&2
    exit "$ROLLBACK_RC"
  fi
fi

restart_backend
trap - EXIT
docker compose exec -T relayhall-db sh -eu -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"';"' \
  | sed 's/^/Public tables after restore: /'
printf 'Restore complete. Safety backup: %s\n' "$SAFETY_BACKUP"
