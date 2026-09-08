#!/usr/bin/env bash
# Hostile-path checks for setup secrets and database recovery boundaries.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
if [ "${1:-}" = "--version" ]; then echo 'Docker version test'; exit 0; fi
if [ "${1:-}" = "compose" ] && [ "${2:-}" = "version" ]; then echo 'Docker Compose test'; exit 0; fi
if [ "${1:-}" = "run" ]; then
  printf '%s\n' '$2b$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuu'
  exit 0
fi
if [ "${1:-}" = "compose" ] && [ "${2:-}" = "ps" ]; then echo 'fake-db-id'; exit 0; fi
if [ "${1:-}" = "compose" ] && { [ "${2:-}" = "stop" ] || [ "${2:-}" = "start" ]; }; then
  if [ -n "${MOCK_DOCKER_LOG:-}" ]; then printf '%s\n' "$2" >> "$MOCK_DOCKER_LOG"; fi
  exit 0
fi
if [ "${1:-}" = "compose" ] && [ "${2:-}" = "exec" ]; then
  case "$*" in
    *pg_dump*)
      printf '%s\n' 'partial-or-complete-sql'
      exit "${MOCK_DUMP_EXIT:-0}"
      ;;
    *psql*)
      count=0
      if [ -n "${MOCK_PSQL_STATE:-}" ] && [ -f "$MOCK_PSQL_STATE" ]; then count=$(cat "$MOCK_PSQL_STATE"); fi
      count=$((count + 1))
      if [ -n "${MOCK_PSQL_STATE:-}" ]; then printf '%s\n' "$count" > "$MOCK_PSQL_STATE"; fi
      if [ "$count" -eq 1 ]; then exit "${MOCK_PSQL_PRIMARY_EXIT:-0}"; fi
      exit "${MOCK_PSQL_ROLLBACK_EXIT:-0}"
      ;;
  esac
fi
echo "unexpected mock docker invocation: $*" >&2
exit 99
MOCK
chmod 755 "$TMP/bin/docker"

SETUP="$TMP/setup"
mkdir -p "$SETUP"
cp "$ROOT/setup.sh" "$ROOT/.env.example" "$ROOT/relayhall.config.example.json" "$SETUP/"
(
  cd "$SETUP"
  printf '\n\n%s\n%s\n' 'test-password-only' '58084' | PATH="$TMP/bin:$PATH" ./setup.sh >/dev/null
  [ "$(stat -c '%a' .env)" = 600 ]
  [ "$(stat -c '%a' data)" = 700 ]
  [ "$(stat -c '%a' backups)" = 700 ]
)

echo 'setup_secret_modes=pass'

# Follow the generated setup env through the real Compose service declaration:
# a feature implemented in the backend is unreachable if Compose drops it.
# PyYAML is installed by the repository-contract job before this suite.
python3 - "$ROOT/docker-compose.yml" "$SETUP/.env" <<'PYSESSIONS'
import pathlib, sys, yaml
compose = yaml.safe_load(pathlib.Path(sys.argv[1]).read_text())
backend = compose["services"]["relayhall-backend"]["environment"]
health = compose["services"]["relayhall-backend"]["healthcheck"]
assert health["start_period"] == "180s", "cold first-install migration grace must be preserved"
assert (health["interval"], health["timeout"], health["retries"]) == ("30s", "10s", 3)
assert backend.get("RELAYHALL_SESSIONS") == "${RELAYHALL_SESSIONS:-on}", (
    "public Compose must forward the Account-session flag, default on, with explicit opt-out")
env = dict(line.split("=", 1) for line in pathlib.Path(sys.argv[2]).read_text().splitlines()
           if line and not line.startswith("#") and "=" in line)
assert env.get("RELAYHALL_SESSIONS") == "on", "fresh setup must enable named Account login"
PYSESSIONS
echo 'fresh_account_session_carriage=pass'

BACKUP_ROOT="$TMP/backup"
mkdir -p "$BACKUP_ROOT"
printf '%s\n' 'BACKUP_DIR=./backups' 'KEEP_BACKUPS=7' > "$BACKUP_ROOT/.env"
set +e
(
  cd "$BACKUP_ROOT"
  PATH="$TMP/bin:$PATH" MOCK_DUMP_EXIT=42 "$ROOT/database/backup.sh" >/dev/null 2>&1
)
FAIL_RC=$?
set -e
[ "$FAIL_RC" = 42 ]
shopt -s nullglob
FAILED_FINALS=("$BACKUP_ROOT"/backups/relayhall_*.sql.gz)
FAILED_TEMPS=("$BACKUP_ROOT"/backups/.relayhall_*.sql.gz)
[ "${#FAILED_FINALS[@]}" = 0 ]
[ "${#FAILED_TEMPS[@]}" = 0 ]

echo 'failed_backup_cleanup=pass'

(
  cd "$BACKUP_ROOT"
  PATH="$TMP/bin:$PATH" MOCK_DUMP_EXIT=0 "$ROOT/database/backup.sh" >/dev/null
)
SUCCESSFUL=("$BACKUP_ROOT"/backups/relayhall_*.sql.gz)
[ "${#SUCCESSFUL[@]}" = 1 ]
gzip -t "${SUCCESSFUL[0]}"
[ "$(stat -c '%a' "${SUCCESSFUL[0]}")" = 600 ]
[ "$(stat -c '%a' "$BACKUP_ROOT/backups")" = 700 ]

echo 'atomic_backup_modes=pass'

run_restore_probe() {
  local root=$1 rollback_exit=$2 expected_rc=$3 expected_starts=$4
  mkdir -p "$root"
  printf '%s\n' 'BACKUP_DIR=./backups' > "$root/.env"
  printf '%s\n' 'requested-restore-sql' | gzip > "$root/requested.sql.gz"
  : > "$root/docker.log"
  rm -f "$root/psql.count"
  set +e
  (
    cd "$root"
    PATH="$TMP/bin:$PATH" \
      MOCK_DOCKER_LOG="$root/docker.log" \
      MOCK_PSQL_STATE="$root/psql.count" \
      MOCK_PSQL_PRIMARY_EXIT=17 \
      MOCK_PSQL_ROLLBACK_EXIT="$rollback_exit" \
      "$ROOT/database/restore.sh" --yes requested.sql.gz >stdout.log 2>stderr.log
  )
  local rc=$?
  set -e
  [ "$rc" = "$expected_rc" ]
  local starts
  starts=$(grep -c '^start$' "$root/docker.log" || true)
  [ "$starts" = "$expected_starts" ]
  [ "$(cat "$root/psql.count")" = 2 ]
  local safety=("$root"/backups/pre-restore_*.sql.gz)
  [ "${#safety[@]}" = 1 ]
  [ "$(stat -c '%a' "${safety[0]}")" = 600 ]
  [ "$(stat -c '%a' "$root/backups")" = 700 ]
}

run_restore_probe "$TMP/restore-rollback-pass" 0 17 1
echo 'restore_rollback_restart=pass'

run_restore_probe "$TMP/restore-rollback-fail" 23 23 0
grep -q 'backend remains stopped for manual recovery' "$TMP/restore-rollback-fail/stderr.log"
echo 'restore_double_failure_stays_stopped=pass'

cat > "$TMP/bin/node" <<'MOCK'
#!/usr/bin/env bash
set -eu
if [ "$1" = "dist/db/migrate.js" ]; then
  count=0
  [ ! -f "$MOCK_NODE_STATE" ] || count=$(cat "$MOCK_NODE_STATE")
  count=$((count + 1))
  printf '%s\n' "$count" > "$MOCK_NODE_STATE"
  [ "$count" -ge 3 ]
  exit
fi
if [ "$1" = "dist/server.js" ]; then
  : > "$MOCK_SERVER_STARTED"
  exit 0
fi
exit 99
MOCK
cat > "$TMP/bin/sleep" <<'MOCK'
#!/usr/bin/env sh
exit 0
MOCK
chmod 755 "$TMP/bin/node" "$TMP/bin/sleep"
PATH="$TMP/bin:$PATH" MOCK_NODE_STATE="$TMP/node.count" MOCK_SERVER_STARTED="$TMP/server.started" \
  MIGRATION_STARTUP_ATTEMPTS=3 MIGRATION_STARTUP_DELAY_SECONDS=0 "$ROOT/backend/start.sh" >/dev/null 2>&1
[ "$(cat "$TMP/node.count")" = 3 ]
[ -f "$TMP/server.started" ]
echo 'bounded_migration_readiness_retry=pass'

run_invalid_migration_config_probe() {
  local label=$1
  local attempts=$2
  local delay=$3
  local state="$TMP/${label}.node.count"
  local started="$TMP/${label}.server.started"
  local stderr="$TMP/${label}.stderr.log"
  set +e
  PATH="$TMP/bin:$PATH" MOCK_NODE_STATE="$state" MOCK_SERVER_STARTED="$started" \
    MIGRATION_STARTUP_ATTEMPTS="$attempts" MIGRATION_STARTUP_DELAY_SECONDS="$delay" \
    "$ROOT/backend/start.sh" >/dev/null 2>"$stderr"
  local rc=$?
  set -e
  [ "$rc" = 1 ]
  [ ! -e "$state" ]
  [ ! -e "$started" ]
}

run_invalid_migration_config_probe invalid-attempts-text abc 0
grep -q 'MIGRATION_STARTUP_ATTEMPTS must be an integer from 1 to 100' "$TMP/invalid-attempts-text.stderr.log"
run_invalid_migration_config_probe invalid-attempts-zero 0 0
grep -q 'MIGRATION_STARTUP_ATTEMPTS must be an integer from 1 to 100' "$TMP/invalid-attempts-zero.stderr.log"
run_invalid_migration_config_probe invalid-attempts-overflow 999999999999999999999999999999999999 0
grep -q 'MIGRATION_STARTUP_ATTEMPTS must be an integer from 1 to 100' "$TMP/invalid-attempts-overflow.stderr.log"
run_invalid_migration_config_probe invalid-attempts-over-limit 101 0
grep -q 'MIGRATION_STARTUP_ATTEMPTS must be an integer from 1 to 100' "$TMP/invalid-attempts-over-limit.stderr.log"
run_invalid_migration_config_probe invalid-delay 3 abc
grep -q 'MIGRATION_STARTUP_DELAY_SECONDS must be an integer from 0 to 300' "$TMP/invalid-delay.stderr.log"
run_invalid_migration_config_probe invalid-delay-overflow 3 999999999999999999999999999999999999
grep -q 'MIGRATION_STARTUP_DELAY_SECONDS must be an integer from 0 to 300' "$TMP/invalid-delay-overflow.stderr.log"
run_invalid_migration_config_probe invalid-delay-over-limit 3 301
grep -q 'MIGRATION_STARTUP_DELAY_SECONDS must be an integer from 0 to 300' "$TMP/invalid-delay-over-limit.stderr.log"
echo 'migration_retry_config_validation=pass'
grep -Fq 'RUN chmod 0755 /entrypoint.sh /start.sh' "$ROOT/backend/Dockerfile"
grep -Fq '&& chmod -R a+rX /app/dist/migrations /app/scripts' "$ROOT/backend/Dockerfile"
echo 'container_runtime_asset_modes=pass'
