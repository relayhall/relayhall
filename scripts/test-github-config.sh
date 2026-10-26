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
out=None; method='GET'; config=None; url=args[-1]; data=None
for i,a in enumerate(args):
    if a == '--output': out=args[i+1]
    elif a == '--request': method=args[i+1]
    elif a == '--config': config=args[i+1]
    elif a == '--data-binary': data=args[i+1]
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
elif method == 'PUT' and url.endswith('/branches/main/protection'):
    # Record what the script asked GitHub to require; the readback answers it.
    sent=json.loads(pathlib.Path(data[1:]).read_text())
    pathlib.Path(os.environ['MOCK_PROTECTION_SENT']).write_text(json.dumps(sent))
elif method == 'GET' and url.endswith('/branches/main/protection'):
    if scenario == 'badprotection':
        body={}
    else:
        sent=json.loads(pathlib.Path(os.environ['MOCK_PROTECTION_SENT']).read_text())
        contexts=list(sent['required_status_checks']['contexts'])
        # GitHub answering with a protection object that differs from the PUT.
        if scenario == 'extracontext': contexts.append('Frontend unit tests (shard 1 of 3)')
        if scenario == 'dropcontext': contexts.remove('CLI tests')
        body={
          'required_status_checks': {'strict': True, 'contexts': contexts},
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
  MOCK_PROTECTION_SENT="$TMP/protection-sent.json" \
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

# E506: the required contexts are the main, non-matrix jobs the owner's ruling
# names - the repository contract, the backend, the frontend and the CLI - and
# NOT the Frontend unit-test shards: a matrix job that is skipped reports under
# its unexpanded name ("... (shard ${{ matrix.shard }} of 3)"), a context that
# can never be satisfied, so requiring the shards would let one skipped matrix
# block every merge. The shards still run and still show red; they just are not
# a merge condition. "Changed areas" is not in the ruling's list either, so it
# is not required.
#
# The list is DERIVED from .github/workflows/ci.yml: every job that has no
# strategy.matrix, less "Changed areas". Two things then fail the check: a
# job the ruling names that the workflow no longer has (a rename would leave
# main protected by a context that never reports), and a non-matrix job the
# ruling does not name (a new job needs a decision, not a silent omission).
# PyYAML is installed by the repository-contract job before this suite. The
# calls after the first are the check's own negative controls: the sent list
# with a shard added, with a main job dropped, and with "Changed areas" added
# must each be refused, each with its own reason.
cat > "$TMP/contexts.py" <<'PYCONTEXTS'
import json, pathlib, sys
import yaml

NAMED_BY_THE_RULING = [
    "Repository and deployment contract",
    "Backend type check and mocked tests",
    "Frontend build and tests",
    "CLI tests",
]
NOT_REQUIRED = {"Changed areas"}

workflow = yaml.safe_load(pathlib.Path(sys.argv[1]).read_text())
non_matrix = set()
for job_id, job in workflow["jobs"].items():
    name = job.get("name", job_id)
    strategy = job.get("strategy") or {}
    if "matrix" in strategy or "${{" in name:
        continue
    non_matrix.add(name)
missing = [name for name in NAMED_BY_THE_RULING if name not in non_matrix]
if missing:
    print("job named by the ruling is missing from the workflow: %s" % missing, file=sys.stderr)
    raise SystemExit(1)
derived = non_matrix - NOT_REQUIRED
if derived != set(NAMED_BY_THE_RULING):
    print("non-matrix job the ruling does not name: %s" % sorted(derived - set(NAMED_BY_THE_RULING)), file=sys.stderr)
    raise SystemExit(1)

sent = json.loads(pathlib.Path(sys.argv[2]).read_text())["required_status_checks"]["contexts"]
for flag, value in zip(sys.argv[3::2], sys.argv[4::2]):
    if flag == "--add":
        sent = sent + [value]
    elif flag == "--drop":
        sent = [context for context in sent if context != value]
if len(sent) != len(set(sent)) or set(sent) != derived:
    print("required contexts differ from the main jobs: missing %s, unknown %s"
          % (sorted(derived - set(sent)), sorted(set(sent) - derived)), file=sys.stderr)
    raise SystemExit(1)
PYCONTEXTS
CI_YML="$ROOT/.github/workflows/ci.yml"
python3 "$TMP/contexts.py" "$CI_YML" "$TMP/protection-sent.json"
# A control must capture the output AND the exit code: `producer | grep -q`
# under pipefail would pass or fail on the pipe, not on the check.
contexts_refused() {
  local reason=$1 rc out
  shift
  set +e
  out=$(python3 "$TMP/contexts.py" "$CI_YML" "$TMP/protection-sent.json" "$@" 2>&1)
  rc=$?
  set -e
  [ "$rc" = 1 ] || { echo "the required-context check did not refuse: $*" >&2; exit 1; }
  case "$out" in *"$reason"*) ;; *) echo "refused for the wrong reason ($*): $out" >&2; exit 1 ;; esac
}
contexts_refused "unknown ['Frontend unit tests (shard 2 of 3)']" --add 'Frontend unit tests (shard 2 of 3)'
contexts_refused "missing ['CLI tests']" --drop 'CLI tests'
contexts_refused "missing ['Frontend build and tests']" --drop 'Frontend build and tests'
contexts_refused "unknown ['Changed areas']" --add 'Changed areas'
# The workflow side of the check is exercised on a copy: rename a named job,
# and add a non-matrix job the ruling does not name.
workflow_refused() {
  local file=$1 reason=$2 rc out
  set +e
  out=$(python3 "$TMP/contexts.py" "$file" "$TMP/protection-sent.json" 2>&1)
  rc=$?
  set -e
  [ "$rc" = 1 ] || { echo "the required-context check accepted $file" >&2; exit 1; }
  case "$out" in *"$reason"*) ;; *) echo "refused for the wrong reason ($file): $out" >&2; exit 1 ;; esac
}
sed 's/name: CLI tests/name: CLI checks/' "$CI_YML" > "$TMP/ci-renamed.yml"
workflow_refused "$TMP/ci-renamed.yml" "missing from the workflow: ['CLI tests']"
{
  cat "$CI_YML"
  cat <<'EXTRAJOB'
  extra-job:
    name: An extra job
    runs-on: ubuntu-latest
    steps:
      - run: true
EXTRAJOB
} > "$TMP/ci-extra.yml"
workflow_refused "$TMP/ci-extra.yml" "does not name: ['An extra job']"

# The readback must refuse a protection object GitHub answers with a shard
# added, or a main job missing, even though the PUT sent the right list.
set +e
run_config extracontext --protect >"$TMP/extracontext.out" 2>"$TMP/extracontext.err"
EXTRA_CONTEXT_RC=$?
run_config dropcontext --protect >"$TMP/dropcontext.out" 2>"$TMP/dropcontext.err"
DROP_CONTEXT_RC=$?
set -e
[ "$EXTRA_CONTEXT_RC" = 1 ] || { echo 'the readback accepted a protection object with a shard added' >&2; exit 1; }
grep -q 'branch protection readback mismatch: required status checks' "$TMP/extracontext.err"
[ "$DROP_CONTEXT_RC" = 1 ] || { echo 'the readback accepted a protection object missing a main job' >&2; exit 1; }
grep -q 'branch protection readback mismatch: required status checks' "$TMP/dropcontext.err"

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
echo 'branch_protection_contexts_are_the_main_jobs=pass'
echo 'branch_protection_shard_and_dropped_job_refused=pass'
echo 'branch_protection_fail_closed=pass'
echo 'configuration_token_not_in_argv=pass'
