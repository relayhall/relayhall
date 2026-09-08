#!/usr/bin/env bash
# Exercise GitHub repository configuration without contacting GitHub.
set -euo pipefail
umask 077
ROOT=$(git rev-parse --show-toplevel)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env python3
import hashlib, json, os, pathlib, re, sys
args=sys.argv[1:]
out=None; method='GET'; config=None; url=args[-1]
for i,a in enumerate(args):
    if a == '--output': out=args[i+1]
    elif a == '--request': method=args[i+1]
    elif a == '--config': config=args[i+1]
if not out or not config: raise SystemExit(90)
config_path=pathlib.Path(config)
if config_path.stat().st_mode & 0o777 != 0o600: raise SystemExit(91)
text=config_path.read_text()
match=re.search(r'Authorization: Bearer ([^"\s]+)', text)
if not match: raise SystemExit(92)
if hashlib.sha256(match.group(1).encode()).hexdigest() != os.environ['MOCK_EXPECTED_TOKEN_SHA256']:
    raise SystemExit(93)
with open(os.environ['MOCK_ARGV_LOG'],'a') as f: f.write('\0'.join(args)+'\n')
scenario=os.environ['MOCK_SCENARIO']
count_path=pathlib.Path(os.environ['MOCK_COUNT'])
count=int(count_path.read_text()) if count_path.exists() else 0
status=200; body={}
if method == 'GET' and url.endswith('/repos/relayhall/relayhall'):
    count += 1; count_path.write_text(str(count))
    if scenario == 'absent' and count == 1: status=404; body={'message':'Not Found'}
    elif scenario == 'nonempty': body={'size':7}
    else: body={'size':0}
elif method == 'GET' and ('branches?per_page=1' in url or 'tags?per_page=1' in url):
    body=[]
elif method == 'POST' and url.endswith('/orgs/relayhall/repos'): status=201
elif method == 'PUT' and url.endswith('/private-vulnerability-reporting'): status=204
elif method == 'GET' and url.endswith('/branches/main'): body={'name':'main'}
elif method == 'GET' and url.endswith('/branches/main/protection'):
    if scenario == 'badprotection':
        body={}
    else:
        body={
          'required_status_checks': {'strict': True, 'contexts': [
            'Repository and deployment contract', 'Backend build and tests',
            'Frontend build and tests', 'CLI tests']},
          'enforce_admins': {'enabled': True},
          'required_pull_request_reviews': {
            'dismiss_stale_reviews': True,
            'required_approving_review_count': 1,
            'require_last_push_approval': True},
          'required_conversation_resolution': {'enabled': True},
          'allow_force_pushes': {'enabled': False},
          'allow_deletions': {'enabled': False},
        }
pathlib.Path(out).write_text(json.dumps(body))
print(status,end='')
MOCK
chmod 700 "$TMP/bin/curl"

RUN_TOKEN='test_'"$(printf owner-gate | sha256sum | cut -c1-24)"
EXPECTED_TOKEN_SHA256=$(printf %s "$RUN_TOKEN" | sha256sum | cut -d' ' -f1)
run_config() {
  local scenario=$1 mode=$2 rc
  rm -f "$TMP/count" "$TMP/argv.log"
  MOCK_SCENARIO="$scenario" MOCK_COUNT="$TMP/count" MOCK_ARGV_LOG="$TMP/argv.log" \
  MOCK_EXPECTED_TOKEN_SHA256="$EXPECTED_TOKEN_SHA256" GITHUB_TOKEN="$RUN_TOKEN" \
  RELAYHALL_GITHUB_CONFIGURATION_APPROVED=1 PATH="$TMP/bin:$PATH" \
    "$ROOT/scripts/configure-github-repository.sh" "$mode"
  rc=$?
  [ "$rc" = 0 ] || return "$rc"
  ! grep -Fq "$RUN_TOKEN" "$TMP/argv.log"
}

set +e
run_config nonempty --prepare >"$TMP/nonempty.out" 2>"$TMP/nonempty.err"
NONEMPTY_RC=$?
set -e
[ "$NONEMPTY_RC" = 1 ]
grep -q 'existing canonical repository is not empty' "$TMP/nonempty.err"

run_config empty --prepare >"$TMP/empty.out"
grep -q 'empty_repository_updated=pass' "$TMP/empty.out"
grep -q 'github_prepare_readback=pass' "$TMP/empty.out"

run_config absent --prepare >"$TMP/absent.out"
grep -q 'repository_created=pass' "$TMP/absent.out"

run_config empty --protect >"$TMP/protect.out"
grep -q 'github_main_protection_readback=pass' "$TMP/protect.out"

set +e
run_config badprotection --protect >"$TMP/badprotection.out" 2>"$TMP/badprotection.err"
BAD_PROTECTION_RC=$?
set -e
[ "$BAD_PROTECTION_RC" = 1 ]
grep -q 'branch protection readback mismatch' "$TMP/badprotection.err"

echo 'nonempty_repository_rejected=pass'
echo 'empty_repository_prepare=pass'
echo 'absent_repository_prepare=pass'
echo 'branch_protection_contract=pass'
echo 'branch_protection_fail_closed=pass'
echo 'configuration_token_not_in_argv=pass'
