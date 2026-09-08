#!/usr/bin/env bash
# Create an atomically published, compressed PostgreSQL dump for this Compose project.
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
KEEP_BACKUPS=${KEEP_BACKUPS:-$(read_env KEEP_BACKUPS 7)}
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/relayhall_$TIMESTAMP.sql.gz"

if [ -z "$(docker compose ps --status running -q relayhall-db)" ]; then
  echo "Error: the relayhall-db Compose service is not running." >&2
  echo "Start it with: docker compose up -d relayhall-db" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
TEMP_FILE=$(mktemp "$BACKUP_DIR/.relayhall_${TIMESTAMP}.XXXXXX.sql.gz")
cleanup_partial() { rm -f -- "$TEMP_FILE"; }
trap cleanup_partial EXIT

echo "Creating $BACKUP_FILE"
docker compose exec -T relayhall-db sh -eu -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  | gzip > "$TEMP_FILE"
gzip -t "$TEMP_FILE"
chmod 600 "$TEMP_FILE"
mv -- "$TEMP_FILE" "$BACKUP_FILE"
trap - EXIT

if [ "$KEEP_BACKUPS" -gt 0 ]; then
  mapfile -t OLD_BACKUPS < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'relayhall_*.sql.gz' -printf '%T@ %p\n' \
    | sort -rn | cut -d' ' -f2- | tail -n +$((KEEP_BACKUPS + 1)))
  if [ "${#OLD_BACKUPS[@]}" -gt 0 ]; then
    rm -- "${OLD_BACKUPS[@]}"
  fi
fi

printf 'Backup complete: %s (%s)\n' "$BACKUP_FILE" "$(du -h "$BACKUP_FILE" | cut -f1)"
