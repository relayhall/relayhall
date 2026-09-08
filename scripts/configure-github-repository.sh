#!/usr/bin/env bash
# Prepare the canonical GitHub repository, then protect main after the first import.
set -euo pipefail
umask 077
MODE=plan
case "${1:-}" in
  ''|--plan) MODE=plan ;;
  --prepare) MODE=prepare ;;
  --protect) MODE=protect ;;
  -h|--help)
    cat <<'EOF'
Usage: scripts/configure-github-repository.sh [--plan|--prepare|--protect]

--plan     Print the intended public-repository policy; no authentication/write.
--prepare  Create or update the empty public repository before first publication.
--protect  After first publication, require PR review and CI on main.

Write modes require GITHUB_TOKEN and RELAYHALL_GITHUB_CONFIGURATION_APPROVED=1.
They never push Git content.
EOF
    exit 0 ;;
  *) echo "Unknown mode: $1" >&2; exit 2 ;;
esac

ORG=relayhall
REPO=relayhall
API=https://api.github.com
REPO_API="$API/repos/$ORG/$REPO"

print_plan() {
  cat <<'EOF'
repository=relayhall/relayhall
visibility=public
default_branch=main
canonical_public_remote=https://github.com/relayhall/relayhall.git
working_remote=private_gitea
merge_policy=pull_requests_with_merge_commits
main_protection=one_approval+four_required_CI_jobs+no_force_push+no_deletion
issues=enabled
security_advisories=private_reporting_enabled
publication=allowlisted_gitleaks_gate_with_exact_owner_approved_SHA
EOF
}

if [ "$MODE" = plan ]; then
  print_plan
  exit 0
fi

[ -n "${GITHUB_TOKEN:-}" ] || { echo 'GITHUB_TOKEN is required' >&2; exit 2; }
[ "${RELAYHALL_GITHUB_CONFIGURATION_APPROVED:-}" = 1 ] || {
  echo 'Owner configuration approval is required' >&2
  exit 2
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CURL_CONFIG="$TMP/curl.conf"
AUTH_HEADER_NAME=Authorization
AUTH_SCHEME=Bearer
printf 'header = "%s: %s %s"\n' "$AUTH_HEADER_NAME" "$AUTH_SCHEME" "$GITHUB_TOKEN" > "$CURL_CONFIG"
printf 'header = "Accept: application/vnd.github+json"\n' >> "$CURL_CONFIG"
printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n' >> "$CURL_CONFIG"
chmod 600 "$CURL_CONFIG"
unset GITHUB_TOKEN

api() {
  local method=$1 path=$2 body=${3:-} expected=${4:-200}
  local response="$TMP/response.json" status
  if [ -n "$body" ]; then
    status=$(curl --config "$CURL_CONFIG" --silent --show-error --output "$response" --write-out '%{http_code}' \
      --request "$method" \
      -H 'Content-Type: application/json' --data-binary "@$body" "$API$path")
  else
    status=$(curl --config "$CURL_CONFIG" --silent --show-error --output "$response" --write-out '%{http_code}' \
      --request "$method" \
      "$API$path")
  fi
  case ",$expected," in *",$status,"*) ;; *)
    echo "GitHub API $method $path returned HTTP $status" >&2
    python3 - "$response" <<'PY' >&2
import json, sys
try:
    data=json.load(open(sys.argv[1])); print(data.get('message','request failed'))
except Exception: print('request failed')
PY
    return 1 ;;
  esac
  printf '%s\n' "$status"
}

cat > "$TMP/repository.json" <<'EOF'
{
  "name": "relayhall",
  "description": "A governed, self-hosted work hub where humans and AI harnesses coordinate through shared state.",
  "homepage": "https://relayhall.com",
  "private": false,
  "has_issues": true,
  "has_projects": false,
  "has_wiki": false,
  "has_discussions": true,
  "allow_squash_merge": false,
  "allow_merge_commit": true,
  "allow_rebase_merge": false,
  "delete_branch_on_merge": true
}
EOF
cat > "$TMP/topics.json" <<'EOF'
{"names":["ai-agents","coordination","governance","human-in-the-loop","self-hosted","work-management"]}
EOF

if [ "$MODE" = prepare ]; then
  status=$(api GET "/repos/$ORG/$REPO" '' '200,404')
  if [ "$status" = 404 ]; then
    api POST "/orgs/$ORG/repos" "$TMP/repository.json" 201 >/dev/null
    echo 'repository_created=pass'
  else
    python3 - "$TMP/response.json" <<'PY'
import json, sys
repo = json.load(open(sys.argv[1]))
if repo.get('size') != 0:
    raise SystemExit('existing canonical repository is not empty')
PY
    api GET "/repos/$ORG/$REPO/branches?per_page=1" '' 200 >/dev/null
    python3 - "$TMP/response.json" <<'PY'
import json, sys
if json.load(open(sys.argv[1])) != []:
    raise SystemExit('existing canonical repository already has branches')
PY
    api GET "/repos/$ORG/$REPO/tags?per_page=1" '' 200 >/dev/null
    python3 - "$TMP/response.json" <<'PY'
import json, sys
if json.load(open(sys.argv[1])) != []:
    raise SystemExit('existing canonical repository already has tags')
PY
    api PATCH "/repos/$ORG/$REPO" "$TMP/repository.json" 200 >/dev/null
    echo 'empty_repository_updated=pass'
  fi
  api PUT "/repos/$ORG/$REPO/topics" "$TMP/topics.json" 200 >/dev/null
  api PUT "/repos/$ORG/$REPO/private-vulnerability-reporting" '' '204,422' >/dev/null
  api GET "/repos/$ORG/$REPO" '' 200 >/dev/null
  echo 'github_prepare_readback=pass'
  exit 0
fi

cat > "$TMP/protection.json" <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Repository and deployment contract",
      "Backend build and tests",
      "Frontend build and tests",
      "CLI tests"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "lock_branch": false,
  "allow_fork_syncing": true
}
EOF
api GET "/repos/$ORG/$REPO/branches/main" '' 200 >/dev/null
api PUT "/repos/$ORG/$REPO/branches/main/protection" "$TMP/protection.json" 200 >/dev/null
api GET "/repos/$ORG/$REPO/branches/main/protection" '' 200 >/dev/null
python3 - "$TMP/response.json" <<'PY'
import json, sys

protection = json.load(open(sys.argv[1]))
expected_contexts = {
    "Repository and deployment contract",
    "Backend build and tests",
    "Frontend build and tests",
    "CLI tests",
}

def enabled(name):
    value = protection.get(name)
    return value is True or (isinstance(value, dict) and value.get("enabled") is True)

def disabled(name):
    value = protection.get(name)
    return value is False or (isinstance(value, dict) and value.get("enabled") is False)

reviews = protection.get("required_pull_request_reviews") or {}
checks = protection.get("required_status_checks") or {}
failures = []
if set(checks.get("contexts") or []) != expected_contexts or checks.get("strict") is not True:
    failures.append("required status checks")
if reviews.get("required_approving_review_count") != 1:
    failures.append("required approving review count")
if reviews.get("dismiss_stale_reviews") is not True:
    failures.append("stale-review dismissal")
if reviews.get("require_last_push_approval") is not True:
    failures.append("last-push approval")
if not enabled("enforce_admins"):
    failures.append("administrator enforcement")
if not enabled("required_conversation_resolution"):
    failures.append("conversation resolution")
if not disabled("allow_force_pushes"):
    failures.append("force-push denial")
if not disabled("allow_deletions"):
    failures.append("branch-deletion denial")
if failures:
    raise SystemExit("branch protection readback mismatch: " + ", ".join(failures))
PY
echo 'github_main_protection_readback=pass'
