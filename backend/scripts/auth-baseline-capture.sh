#!/usr/bin/env bash
# auth-baseline-capture.sh — capture the authentication/authorization behaviour
# of a running RelayHall stack as a deterministic fixture.
#
# Purpose (epic 60558599, Phase-2 exit): pin the current post-089 401/403
# surface against a disposable freshly migrated stack. The fixture covers only
# current routes and includes a real short-lived principal credential so both
# successful authentication and generic fail-closed authorization are proven.
#
# Secrets: JWTs are minted inside the backend container, legacy keys are read
# from its environment, and the one-time rh_ key exists only inside a mode-0600
# curl config in a private mktemp directory. The exit trap revokes it. No rh_
# secret reaches the fixture or a process argument.
#
# Usage:
#   BASE_URL=http://127.0.0.1:8085/api CONTAINER=relayhall-backend-1 \
#     backend/scripts/auth-baseline-capture.sh > fixture.json
set -euo pipefail
umask 077

BASE_URL="${BASE_URL:-http://127.0.0.1:8085/api}"
CONTAINER="${CONTAINER:-relayhall-backend-1}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/relayhall-auth-baseline.XXXXXX")"
CREDENTIAL_ID=""
SERVICE_ID=""
SERVICE_REVISION=""
JWT_VALID=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [ -n "$CREDENTIAL_ID" ] && [ -n "$JWT_VALID" ]; then
    curl -fsS -o /dev/null -X POST \
      -H "Authorization: Bearer $JWT_VALID" \
      -H 'Content-Type: application/json' \
      -d '{"reason":"auth_baseline_capture_complete"}' \
      "$BASE_URL/credentials/$CREDENTIAL_ID/revoke" || true
  fi
  if [ -n "$SERVICE_ID" ] && [ -n "$SERVICE_REVISION" ] && [ -n "$JWT_VALID" ]; then
    # Retirement is optimistic-concurrency guarded: it needs the revision the
    # registration handed back (If-Match), or the board refuses it.
    curl -fsS -o /dev/null -X POST \
      -H "Authorization: Bearer $JWT_VALID" \
      -H "If-Match: $SERVICE_REVISION" \
      -H 'Content-Type: application/json' \
      -d '{}' \
      "$BASE_URL/services/$SERVICE_ID/retire" || true
  fi
  rm -rf -- "$TMP_DIR"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

mint() { # mint <json-payload> [expiresIn]
  local payload="$1" expiry="${2:-10m}"
  docker exec "$CONTAINER" node -e "
    const jwt = require('jsonwebtoken');
    console.log(jwt.sign($payload, process.env.JWT_SECRET, { expiresIn: '$expiry' }));
  "
}

JWT_VALID="$(mint '{ userId: "dashboard_user" }')"
JWT_UNKNOWN_HANDLE="$(mint '{ userId: "baseline_unknown_handle" }')"
JWT_CAPABILITY="$(mint '{ scope: "browser-access" }')"
JWT_EXPIRED="$(mint '{ userId: "dashboard_user" }' '-10m')"
REPORTS_KEY="$(docker exec "$CONTAINER" printenv RELAYHALL_REPORTS_READ_API_KEY || true)"

PRINCIPAL_ID="$(
  curl -fsS -H "Authorization: Bearer $JWT_VALID" "$BASE_URL/principals" |
    jq -er '[.principals[] | select(.handle == "dashboard_user")] | if length == 1 then .[0].id else error("dashboard_user principal missing or duplicated") end'
)"
# The disposable credential rides a CONNECTOR, not the Account.
#
# It used to be issued straight onto `dashboard_user`. AZ-S3 then ruled
# Accounts keyless (A17.1/§7.1), so that call answers 422
# ACCOUNTS_ARE_KEYLESS and `set -e` killed the capture before it wrote a
# single probe — this gate has been unrunnable ever since, on every commit.
# The vehicle here is the one the refusal itself names: register a Connector
# for the Account and issue its first credential in the same call (§7.4).
# The leg's purpose is unchanged — one real, live, scope-limited credential,
# so the fixture proves both successful authentication and generic
# fail-closed authorization — and the Connector is retired by the exit trap.
ISSUED_FILE="$TMP_DIR/issued.json"
CONNECTOR_SLUG="auth-baseline-$(date -u +%Y%m%d%H%M%S)-$$"
curl -fsS -o "$ISSUED_FILE" -X POST \
  -H "Authorization: Bearer $JWT_VALID" \
  -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$CONNECTOR_SLUG\",\"name\":\"Auth baseline disposable\",\"kind\":\"connector\",\"ownerAccountId\":\"$PRINCIPAL_ID\",\"issueCredential\":{\"scopes\":[\"tasks:read\"],\"label\":\"auth-baseline-disposable\"}}" \
  "$BASE_URL/services"
chmod 0600 "$ISSUED_FILE"
SERVICE_ID="$(jq -er '.service.id' "$ISSUED_FILE")"
SERVICE_REVISION="$(jq -er '.service.revision' "$ISSUED_FILE")"
CREDENTIAL_ID="$(jq -er '.onboarding.credential.credentialId' "$ISSUED_FILE")"
SCOPED_KEY="$(jq -er '.onboarding.credential.secretOnce' "$ISSUED_FILE")"
SCOPED_KEY_CURL_CONFIG="$TMP_DIR/scoped-key.curl"
printf 'header = "Authorization: Bearer %s"\n' "$SCOPED_KEY" > "$SCOPED_KEY_CURL_CONFIG"
chmod 0600 "$SCOPED_KEY_CURL_CONFIG"
unset SCOPED_KEY

probe() { # probe <id> <method> <path> <header...> (POST body via PROBE_DATA, default {})
  local id="$1" method="$2" path="$3"; shift 3
  local body_file="$TMP_DIR/baseline-body"
  local args=(-sS -o "$body_file" -w '%{http_code}\t%{content_type}' -X "$method")
  if [ -n "${PROBE_CURL_CONFIG:-}" ]; then args+=(--config "$PROBE_CURL_CONFIG"); fi
  local h
  for h in "$@"; do args+=(-H "$h"); done
  if [ "$method" = "POST" ]; then args+=(-H 'Content-Type: application/json' -d "${PROBE_DATA:-{\}}"); fi
  local out status ctype body
  out="$(curl "${args[@]}" "$BASE_URL$path")"
  status="${out%%$'\t'*}"
  ctype="${out#*$'\t'}"
  # 2xx bodies are live data (task lists etc.) — status is the contract there.
  # Error bodies are static strings and part of the byte-identical contract.
  if [ "${status:0:1}" = "2" ]; then body=""; else body="$(<"$body_file")"; fi
  jq -n --arg id "$id" --arg method "$method" --arg path "$path" \
        --arg status "$status" --arg ctype "$ctype" --arg body "$body" \
        '{id: $id, method: $method, path: $path, status: ($status|tonumber), content_type: $ctype, body: $body}'
}

{
# --- no credentials ----------------------------------------------------------
probe "010-none-tasks"            GET  /tasks
probe "011-none-reports"          GET  /reports
probe "012-none-principals"       GET  /principals
probe "013-none-projects"         GET  /projects
probe "014-none-health"           GET  /health
probe "015-none-sessions"         GET  /sessions
probe "016-none-personalities"    GET  /personalities
probe "017-none-plugins-registry" GET  /plugins
# --- current identity and task lifecycle routes -----------------------------
probe "020-jwt-principals"        GET  /principals            "Authorization: Bearer $JWT_VALID"
probe "021-jwt-principals-me"     GET  /principals/me         "Authorization: Bearer $JWT_VALID"
probe "022-jwt-task-claim"        POST "/tasks/00000000-0000-0000-0000-000000000000/claim"   "Authorization: Bearer $JWT_VALID"
probe "023-jwt-task-release"      POST "/tasks/00000000-0000-0000-0000-000000000000/release" "Authorization: Bearer $JWT_VALID"
# --- current task filters ----------------------------------------------------
probe "030-jwt-tasks-owner"       GET  "/tasks?owner=dashboard_user" "Authorization: Bearer $JWT_VALID"
probe "031-jwt-tasks-mine"        GET  "/tasks?mine=true"            "Authorization: Bearer $JWT_VALID"
probe "032-jwt-tasks-unassigned"  GET  "/tasks?unassigned=true"      "Authorization: Bearer $JWT_VALID"
# --- valid JWT happy path ----------------------------------------------------
probe "040-jwt-tasks"             GET  /tasks     "Authorization: Bearer $JWT_VALID"
probe "041-jwt-reports"           GET  /reports   "Authorization: Bearer $JWT_VALID"
probe "043-jwt-projects"          GET  /projects  "Authorization: Bearer $JWT_VALID"
probe "044-jwt-health"            GET  /health    "Authorization: Bearer $JWT_VALID"
probe "046-jwt-browser-session"   POST /auth/browser-session "Authorization: Bearer $JWT_VALID"
# --- unknown-handle JWT behaviour -------------------------------------------
probe "050-unknown-handle-tasks"   GET /tasks   "Authorization: Bearer $JWT_UNKNOWN_HANDLE"
probe "051-unknown-handle-reports" GET /reports "Authorization: Bearer $JWT_UNKNOWN_HANDLE"
# --- malformed / hostile bearer values --------------------------------------
probe "060-bearer-garbage"        GET  /tasks "Authorization: Bearer not-a-token"
probe "061-bearer-rh-dev"         GET  /tasks "Authorization: Bearer rh_dev_baselinekeyid.baselinesecretbaselinesecretbaseline"
probe "062-bearer-rh-live"        GET  /tasks "Authorization: Bearer rh_live_baselinekeyid.baselinesecretbaselinesecretbaselin"
probe "063-bearer-capability"      GET  /tasks "Authorization: Bearer $JWT_CAPABILITY"
probe "064-bearer-expired"         GET  /tasks "Authorization: Bearer $JWT_EXPIRED"
probe "065-capability-browser-session" POST /auth/browser-session "Authorization: Bearer $JWT_CAPABILITY"
# --- X-Api-Key: absent in this disposable stack -----------------------------
probe "070-apikey-wrong-alone"    GET  /tasks "X-Api-Key: baseline-wrong-key"
probe "071-apikey-wrong-with-jwt" GET  /tasks "X-Api-Key: baseline-wrong-key" "Authorization: Bearer $JWT_VALID"
# --- reports read key: current route-family scope lock ----------------------
probe "090-reports-key-reports"         GET  /reports "X-Reports-Read-Key: $REPORTS_KEY"
probe "091-reports-key-skills-offscope" GET  /skills   "X-Reports-Read-Key: $REPORTS_KEY"
probe "092-reports-key-offscope"        GET  /tasks    "X-Reports-Read-Key: $REPORTS_KEY"
probe "093-reports-key-wrong"           GET  /reports  "X-Reports-Read-Key: baseline-wrong"
probe "094-reports-key-post"            POST /reports  "X-Reports-Read-Key: $REPORTS_KEY"
# --- real principal credential: in-scope succeeds, off-scope stays generic --
PROBE_CURL_CONFIG="$SCOPED_KEY_CURL_CONFIG" \
probe "095-rh-key-tasks-in-scope" GET /tasks
PROBE_CURL_CONFIG="$SCOPED_KEY_CURL_CONFIG" \
probe "096-rh-key-reports-offscope" GET /reports
# --- login contract ----------------------------------------------------------
probe "100-login-empty-body"      POST /auth/login
PROBE_DATA='{"password":"baseline-wrong-password"}' \
probe "101-login-bad-password"    POST /auth/login
} | jq -s 'sort_by(.id)'
