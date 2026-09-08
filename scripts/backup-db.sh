#!/bin/bash

#############################################
# RelayHall PostgreSQL Backup Script
#############################################
# Backs up the production database, compresses it,
# and rotates old backups (keeps 7 days)
#############################################

set -euo pipefail

# Configuration
BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
LOG_FILE="${BACKUP_DIR}/backup.log"
CONTAINER_NAME="relayhall-db"
DB_NAME="relayhall"
DB_USER="relayhall_prod"
RETENTION_DAYS=7
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
BACKUP_FILE="relayhall-prod-${TIMESTAMP}.sql.gz"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_FILE}"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "${LOG_FILE}"
}

# Error handler
error_exit() {
    log "ERROR: $1"
    exit 1
}

# Start backup
log "=========================================="
log "Starting backup: ${BACKUP_FILE}"

# Check if container is running
if ! sudo docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    error_exit "Container ${CONTAINER_NAME} is not running"
fi

# Check if backup directory exists
if [ ! -d "${BACKUP_DIR}" ]; then
    error_exit "Backup directory ${BACKUP_DIR} does not exist"
fi

# Perform backup
log "Dumping database ${DB_NAME}..."
if sudo docker exec "${CONTAINER_NAME}" pg_dump -U "${DB_USER}" "${DB_NAME}" | gzip > "${BACKUP_PATH}"; then
    BACKUP_SIZE=$(du -h "${BACKUP_PATH}" | cut -f1)
    log "SUCCESS: Backup created: ${BACKUP_FILE} (${BACKUP_SIZE})"
else
    error_exit "Failed to create database backup"
fi

# Verify backup file was created and is not empty
if [ ! -s "${BACKUP_PATH}" ]; then
    error_exit "Backup file is empty or does not exist"
fi

# Rotate old backups
log "Rotating old backups (keeping ${RETENTION_DAYS} days)..."
DELETED_COUNT=0
while IFS= read -r -d '' old_backup; do
    rm -f "${old_backup}"
    log "Deleted old backup: $(basename "${old_backup}")"
    ((DELETED_COUNT++))
done < <(find "${BACKUP_DIR}" -name "relayhall-prod-*.sql.gz" -type f -mtime +${RETENTION_DAYS} -print0)

if [ ${DELETED_COUNT} -eq 0 ]; then
    log "No old backups to delete"
else
    log "Deleted ${DELETED_COUNT} old backup(s)"
fi

# Count remaining backups
BACKUP_COUNT=$(find "${BACKUP_DIR}" -name "relayhall-prod-*.sql.gz" -type f | wc -l)
log "Total backups: ${BACKUP_COUNT}"

log "Backup completed successfully"
log "=========================================="

exit 0
