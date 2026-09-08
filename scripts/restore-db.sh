#!/bin/bash

#############################################
# RelayHall PostgreSQL Restore Script
#############################################
# Restores a backup to the production database
#############################################

set -euo pipefail

# Configuration
BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
LOG_FILE="${BACKUP_DIR}/restore.log"
CONTAINER_NAME="relayhall-db"
DB_NAME="relayhall"
DB_USER="relayhall_prod"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "${LOG_FILE}"
}

# Error handler
error_exit() {
    log "ERROR: $1"
    exit 1
}

# Usage
usage() {
    echo "Usage: $0 <backup-file>"
    echo ""
    echo "Available backups:"
    find "${BACKUP_DIR}" -name "relayhall-prod-*.sql.gz" -type f -printf "%f\n" | sort -r | head -10
    exit 1
}

# Check arguments
if [ $# -ne 1 ]; then
    usage
fi

BACKUP_FILE="$1"

# If only filename provided, prepend backup directory
if [[ "${BACKUP_FILE}" != /* ]]; then
    BACKUP_PATH="${BACKUP_DIR}/${BACKUP_FILE}"
else
    BACKUP_PATH="${BACKUP_FILE}"
fi

# Start restore
log "=========================================="
log "Starting restore from: $(basename "${BACKUP_PATH}")"

# Check if container is running
if ! sudo docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    error_exit "Container ${CONTAINER_NAME} is not running"
fi

# Check if backup file exists
if [ ! -f "${BACKUP_PATH}" ]; then
    error_exit "Backup file does not exist: ${BACKUP_PATH}"
fi

# Verify backup file is not empty
if [ ! -s "${BACKUP_PATH}" ]; then
    error_exit "Backup file is empty: ${BACKUP_PATH}"
fi

# Warning prompt
echo ""
echo "⚠️  WARNING: This will OVERWRITE the current database!"
echo "   Database: ${DB_NAME}"
echo "   Container: ${CONTAINER_NAME}"
echo "   Backup: $(basename "${BACKUP_PATH}")"
echo ""
read -p "Are you sure you want to continue? (yes/no): " -r
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    log "Restore cancelled by user"
    exit 0
fi

# Drop existing connections
log "Terminating existing database connections..."
sudo docker exec "${CONTAINER_NAME}" psql -U "${DB_USER}" -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" \
    || log "Warning: Could not terminate all connections"

# Drop and recreate database
log "Dropping database ${DB_NAME}..."
sudo docker exec "${CONTAINER_NAME}" psql -U "${DB_USER}" -d postgres -c "DROP DATABASE IF EXISTS ${DB_NAME};" \
    || error_exit "Failed to drop database"

log "Creating database ${DB_NAME}..."
sudo docker exec "${CONTAINER_NAME}" psql -U "${DB_USER}" -d postgres -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" \
    || error_exit "Failed to create database"

# Restore backup
log "Restoring database from backup..."
if gunzip -c "${BACKUP_PATH}" | sudo docker exec -i "${CONTAINER_NAME}" psql -U "${DB_USER}" -d "${DB_NAME}"; then
    log "SUCCESS: Database restored from $(basename "${BACKUP_PATH}")"
else
    error_exit "Failed to restore database"
fi

log "Restore completed successfully"
log "=========================================="

exit 0
