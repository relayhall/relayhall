#!/usr/bin/env bash
# Build and optionally promote an allowlisted RelayHall snapshot to canonical GitHub.
set -euo pipefail
umask 077

cleanup_temp_dir() {
  local path=$1 attempt
  for attempt in 1 2 3; do
    if rm -rf -- "$path"; then
      return 0
    fi
    sleep 0.1
  done
  echo "Failed to remove temporary publication directory: $path" >&2
  return 1
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
POLICY_PATH='.relayhall-public-allowlist'
GITLEAKS_IMAGE='ghcr.io/gitleaks/gitleaks@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854'
GITLEAKS_ARCHIVE='https://github.com/gitleaks/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_linux_x64.tar.gz'
GITLEAKS_ARCHIVE_SHA256='a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb'
CANONICAL_TARGET='https://github.com/relayhall/relayhall.git'
MODE=dry-run
SOURCE_REF=main
TARGET=$CANONICAL_TARGET
RECEIPT=${RELAYHALL_PUBLISH_RECEIPT:-/tmp/relayhall-publish-receipt.json}
RELEASE_TAG=
TEST_SCAN=
INITIAL_BUNDLE=

usage() {
  cat <<'EOF'
Usage: scripts/publish-to-github.sh [options]

Default mode is dry-run: build the exact allowlisted public commit, run gitleaks,
show the complete tree diff, and write a mode-0600 receipt. Nothing is pushed.

Options:
  --source REF          committed Gitea source (default: main)
  --target URL          dry-run target (production push is canonical GitHub only)
  --receipt PATH        dry-run receipt path
  --release-tag TAG     optional vMAJOR.MINOR.PATCH tag on the public commit
  --initial-bundle PATH export a scanned single-root main bundle in dry-run only
  --push                owner-approved canonical GitHub push
  --test-push           local file/bare-repository push; requires RELAYHALL_TEST_MODE=1
  --test-scan DIR       run only the pinned gitleaks scanner against DIR
  -h, --help

Production --push additionally requires:
  GITHUB_TOKEN
  RELAYHALL_PRIVATE_ORIGIN=<exact private origin URL>
  RELAYHALL_PUBLICATION_APPROVED_SHA=<exact 40-character source SHA>
  RELAYHALL_PUBLICATION_APPROVED_PUBLIC_COMMIT=<reviewed public commit>
  RELAYHALL_PUBLICATION_APPROVED_RECEIPT_SHA256=<reviewed receipt SHA-256>
  an exact receipt produced by a prior dry-run
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) SOURCE_REF=${2:?missing source}; shift 2 ;;
    --target) TARGET=${2:?missing target}; shift 2 ;;
    --receipt) RECEIPT=${2:?missing receipt path}; shift 2 ;;
    --release-tag) RELEASE_TAG=${2:?missing tag}; shift 2 ;;
    --initial-bundle) INITIAL_BUNDLE=${2:?missing bundle path}; shift 2 ;;
    --push) MODE=push; shift ;;
    --test-push) MODE=test-push; shift ;;
    --test-scan) TEST_SCAN=${2:?missing scan directory}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done


# Validate before network access, diagnostics, or publication artifacts can copy
# the target. Transport authentication belongs in the credential mechanism.
RELAYHALL_TARGET_TO_VALIDATE="$TARGET" python3 - <<'PY'
import os, re
from urllib.parse import urlsplit
target = os.environ['RELAYHALL_TARGET_TO_VALIDATE']
valid = False
try:
    if not target or any(c.isspace() or ord(c) < 32 for c in target):
        raise ValueError()
    if target.startswith('/'):
        valid = True
    elif '://' in target:
        url = urlsplit(target)
        clean = not url.query and not url.fragment and '?' not in target and '#' not in target and '%' not in url.netloc
        if url.scheme == 'https':
            valid = clean and bool(url.hostname) and url.username is None and url.password is None
        elif url.scheme == 'ssh':
            valid = clean and bool(url.hostname) and url.username == 'git' and url.password is None
        elif url.scheme == 'file':
            valid = clean and url.netloc in ('', 'localhost') and url.path.startswith('/')
    else:
        valid = re.fullmatch(r'git@(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):[^?#\s]+', target) is not None
except ValueError:
    valid = False
if not valid:
    raise SystemExit('Target must be a credential-free HTTPS or git SSH URL, or an absolute local path')
PY

if [ -n "$INITIAL_BUNDLE" ]; then
  # Check every output before writing any of them, including the approval receipt.
  python3 - "$RECEIPT" "$INITIAL_BUNDLE" "$ROOT" <<'PY'
import sys
from pathlib import Path
receipt, bundle, root = sys.argv[1:]
outputs = [Path(receipt), Path(bundle), Path(bundle + '.json')]
resolved = [path.resolve() for path in outputs]
if len(set(resolved)) != 3:
    raise SystemExit('Initial bundle outputs must be distinct')
for path in outputs:
    if path.exists() or path.is_symlink():
        raise SystemExit('Initial bundle outputs must not already exist')
    if path.resolve().is_relative_to(Path(root).resolve()):
        raise SystemExit('Initial bundle outputs must be outside the source checkout')
PY
fi

run_gitleaks() {
  local source=$1
  if command -v gitleaks >/dev/null 2>&1; then
    [ "$(gitleaks version)" = '8.28.0' ] || {
      echo 'Local gitleaks must be exactly version 8.28.0' >&2
      return 2
    }
    gitleaks dir --no-banner --no-color --redact=100 --exit-code 1 --max-archive-depth 20 --max-decode-depth 20 "$source"
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker run --rm --network none -v "$source:/scan:ro" "$GITLEAKS_IMAGE" \
      dir --no-banner --no-color --redact=100 --exit-code 1 --max-archive-depth 20 --max-decode-depth 20 /scan
  elif command -v curl >/dev/null 2>&1; then
    local tools archive rc
    tools=$(mktemp -d)
    archive="$tools/gitleaks.tar.gz"
    if ! curl --fail --silent --show-error --location --retry 3 \
      --output "$archive" "$GITLEAKS_ARCHIVE"; then
      rm -rf "$tools"
      return 2
    fi
    if ! printf '%s  %s\n' "$GITLEAKS_ARCHIVE_SHA256" "$archive" | sha256sum --check --status; then
      echo 'Pinned gitleaks archive checksum mismatch' >&2
      rm -rf "$tools"
      return 2
    fi
    tar -xzf "$archive" -C "$tools" gitleaks
    if "$tools/gitleaks" dir --no-banner --no-color --redact=100 --exit-code 1 --max-archive-depth 20 --max-decode-depth 20 "$source"; then
      rc=0
    else
      rc=$?
    fi
    rm -rf "$tools"
    return "$rc"
  else
    echo "gitleaks is unavailable (install it, Docker, or curl)" >&2
    return 2
  fi
}

scan_tree() {
  local source=$1 expanded rc
  expanded=$(mktemp -d)
  if python3 "$ROOT/scripts/prepare-secret-scan-inputs.py" "$source" "$expanded"; then
    :
  else
    rc=$?
    rm -rf "$expanded"
    return "$rc"
  fi
  if run_gitleaks "$source"; then
    :
  else
    rc=$?
    rm -rf "$expanded"
    return "$rc"
  fi
  if [ -n "$(find "$expanded" -type f -print -quit)" ]; then
    if run_gitleaks "$expanded"; then
      :
    else
      rc=$?
      rm -rf "$expanded"
      return "$rc"
    fi
  fi
  rm -rf "$expanded"
}

if [ -n "$INITIAL_BUNDLE" ]; then
  [ "$MODE" = dry-run ] && [ -z "$TEST_SCAN" ] && [ -z "$RELEASE_TAG" ] || {
    echo '--initial-bundle requires dry-run without --test-scan or --release-tag' >&2
    exit 2
  }
fi

if [ -n "$TEST_SCAN" ]; then
  [ "$MODE" = dry-run ] || { echo "--test-scan cannot be combined with push modes" >&2; exit 2; }
  [ -d "$TEST_SCAN" ] || { echo "Scan directory not found: $TEST_SCAN" >&2; exit 2; }
  scan_tree "$(cd "$TEST_SCAN" && pwd)"
  exit 0
fi

[ -z "$(git -C "$ROOT" status --porcelain)" ] || { echo "Working tree must be clean" >&2; exit 2; }
SOURCE_SHA=$(git -C "$ROOT" rev-parse --verify "$SOURCE_REF^{commit}")
SOURCE_DATE=$(git -C "$ROOT" show -s --format=%cI "$SOURCE_SHA")

if [ -n "$RELEASE_TAG" ] && ! [[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Release tag must be vMAJOR.MINOR.PATCH (optional suffix allowed)" >&2
  exit 2
fi

if [ "$MODE" = push ]; then
  [ "$TARGET" = "$CANONICAL_TARGET" ] || { echo "Production push target is fixed to $CANONICAL_TARGET" >&2; exit 2; }
  [ -n "${RELAYHALL_PRIVATE_ORIGIN:-}" ] || { echo "RELAYHALL_PRIVATE_ORIGIN is required" >&2; exit 2; }
  [ "$(git -C "$ROOT" remote get-url origin)" = "$RELAYHALL_PRIVATE_ORIGIN" ] || { echo "Unexpected private working origin" >&2; exit 2; }
  [ "$(git -C "$ROOT" rev-parse HEAD)" = "$SOURCE_SHA" ] || { echo "Production publication must run from the approved source checkout" >&2; exit 2; }
  [ "$(git -C "$ROOT" branch --show-current)" = main ] || { echo "Production publication must run on local main" >&2; exit 2; }
  [ "$SOURCE_SHA" = "$(git -C "$ROOT" rev-parse refs/heads/main)" ] || { echo "Production publication must use local main" >&2; exit 2; }
  [ "$SOURCE_SHA" = "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" ] || { echo "Production publication must match private origin/main" >&2; exit 2; }
  [ "${RELAYHALL_PUBLICATION_APPROVED_SHA:-}" = "$SOURCE_SHA" ] || { echo "Exact owner-approved source SHA is missing or mismatched" >&2; exit 2; }
  [ -n "${RELAYHALL_PUBLICATION_APPROVED_PUBLIC_COMMIT:-}" ] || { echo "Owner-approved public commit is required" >&2; exit 2; }
  [ -n "${RELAYHALL_PUBLICATION_APPROVED_RECEIPT_SHA256:-}" ] || { echo "Owner-approved receipt SHA-256 is required" >&2; exit 2; }
  [ -n "${GITHUB_TOKEN:-}" ] || { echo "GITHUB_TOKEN is required for owner-approved push" >&2; exit 2; }
elif [ "$MODE" = test-push ]; then
  [ "${RELAYHALL_TEST_MODE:-}" = 1 ] || { echo "--test-push is disabled outside RELAYHALL_TEST_MODE=1" >&2; exit 2; }
  case "$TARGET" in /*|file://*) ;; *) echo "Test push target must be a local path or file:// URL" >&2; exit 2 ;; esac
fi

TMP=$(mktemp -d)
trap 'cleanup_temp_dir "$TMP"' EXIT
SAFE_GIT_HOME="$TMP/git-home"
mkdir -p "$SAFE_GIT_HOME"
safe_git_remote() {
  (
    cd "$SAFE_GIT_HOME"
    env -i PATH="$PATH" HOME="$SAFE_GIT_HOME" LANG=C LC_ALL=C \
      GIT_CONFIG_NOSYSTEM=1 \
      GIT_TERMINAL_PROMPT="${GIT_TERMINAL_PROMPT:-0}" \
      GIT_ASKPASS="${GIT_ASKPASS:-}" \
      RELAYHALL_GITHUB_TOKEN_FILE="${RELAYHALL_GITHUB_TOKEN_FILE:-}" \
      git "$@"
  )
}
if [ "$MODE" = push ]; then
  TOKEN_FILE="$TMP/github-token"
  printf '%s' "$GITHUB_TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  unset GITHUB_TOKEN
  export RELAYHALL_GITHUB_TOKEN_FILE="$TOKEN_FILE"
fi
ACTUAL="$TMP/actual-top-level"
POLICY="$TMP/public-allowlist"
git -C "$ROOT" show "$SOURCE_SHA:$POLICY_PATH" > "$POLICY" || {
  echo "Publish allowlist missing from source commit: $POLICY_PATH" >&2
  exit 2
}
git -C "$ROOT" ls-tree -r --name-only "$SOURCE_SHA" > "$ACTUAL"
if ! cmp -s "$POLICY" "$ACTUAL"; then
  echo "Committed publication paths do not exactly match the allowlist:" >&2
  diff -u "$POLICY" "$ACTUAL" >&2 || true
  exit 2
fi

SNAPSHOT="$TMP/snapshot"
mkdir -p "$SNAPSHOT"
mapfile -t ALLOWED < "$POLICY"
git -C "$ROOT" archive --format=tar "$SOURCE_SHA" -- "${ALLOWED[@]}" | tar -xf - -C "$SNAPSHOT"
python3 "$ROOT/scripts/check-public-residue.py" --root "$SNAPSHOT"
scan_tree "$SNAPSHOT"
ALLOWLIST_SHA=$(sha256sum "$POLICY" | cut -d' ' -f1)

PUBLIC="$TMP/public"
REMOTE_MAIN=
REMOTE_REFS=
REMOTE_OK=false
if REMOTE_REFS=$(safe_git_remote ls-remote "$TARGET" 2>"$TMP/ls-remote.err"); then
  REMOTE_OK=true
  REMOTE_MAIN=$(printf '%s\n' "$REMOTE_REFS" | awk '$2 == "refs/heads/main" { print }')
  if [ -z "$REMOTE_MAIN" ] && [ -n "$REMOTE_REFS" ]; then
    echo "Target repository has refs but no main; refusing to treat it as empty" >&2
    exit 2
  fi
elif [ "$MODE" != dry-run ]; then
  echo "Target repository is not accessible" >&2
  exit 2
else
  echo "Dry-run note: target is absent or inaccessible; modelling the initial root commit." >&2
fi

if [ -n "$REMOTE_MAIN" ]; then
  safe_git_remote clone --quiet --single-branch --branch main "$TARGET" "$PUBLIC"
  BASE_COMMIT=$(git -C "$PUBLIC" rev-parse HEAD)
  git -C "$PUBLIC" rm -r --quiet --ignore-unmatch .
else
  mkdir -p "$PUBLIC"
  git -C "$PUBLIC" init --quiet --initial-branch=main
  BASE_COMMIT=
fi

tar -cf - -C "$SNAPSHOT" . | tar -xf - -C "$PUBLIC"
git -C "$PUBLIC" add -A
git -C "$PUBLIC" config user.name 'RelayHall Release Bot'
git -C "$PUBLIC" config user.email 'release-bot@users.noreply.github.com'
if git -C "$PUBLIC" diff --cached --quiet; then
  HAS_CHANGES=false
  PUBLIC_COMMIT=$(git -C "$PUBLIC" rev-parse HEAD)
else
  HAS_CHANGES=true
  GIT_AUTHOR_DATE="$SOURCE_DATE" GIT_COMMITTER_DATE="$SOURCE_DATE" \
    git -C "$PUBLIC" commit --quiet -m "RelayHall public promotion" \
      -m "Source-Gitea-Commit: $SOURCE_SHA"
  PUBLIC_COMMIT=$(git -C "$PUBLIC" rev-parse HEAD)
fi

if [ -n "$REMOTE_MAIN" ] && $HAS_CHANGES; then
  PUSH_REF="refs/heads/promotions/gitea-${SOURCE_SHA:0:12}"
else
  PUSH_REF=refs/heads/main
fi
if [ -n "$RELEASE_TAG" ] && [ -n "$REMOTE_MAIN" ] && $HAS_CHANGES; then
  echo 'Release tags may be created only after a promotion PR has merged to main' >&2
  exit 2
fi

printf 'SOURCE_SHA=%s\nPUBLIC_COMMIT=%s\nTARGET=%s\nPUSH_REF=%s\n' \
  "$SOURCE_SHA" "$PUBLIC_COMMIT" "$TARGET" "$PUSH_REF"
if [ -n "$BASE_COMMIT" ]; then
  git -C "$PUBLIC" diff --stat "$BASE_COMMIT..$PUBLIC_COMMIT"
  git -C "$PUBLIC" diff --name-status "$BASE_COMMIT..$PUBLIC_COMMIT"
else
  git -C "$PUBLIC" show --stat --oneline --summary "$PUBLIC_COMMIT"
  git -C "$PUBLIC" show --pretty='' --name-status "$PUBLIC_COMMIT"
fi

write_receipt() {
  SOURCE_SHA="$SOURCE_SHA" PUBLIC_COMMIT="$PUBLIC_COMMIT" TARGET="$TARGET" \
  ALLOWLIST_SHA="$ALLOWLIST_SHA" PUSH_REF="$PUSH_REF" RELEASE_TAG="$RELEASE_TAG" RECEIPT="$RECEIPT" INITIAL_BUNDLE="$INITIAL_BUNDLE" python3 - <<'PY'
import json, os, tempfile
from pathlib import Path
path = Path(os.environ['RECEIPT'])
path.parent.mkdir(parents=True, exist_ok=True)
payload = json.dumps({
    'schema': 3,
    'sourceSha': os.environ['SOURCE_SHA'],
    'publicCommit': os.environ['PUBLIC_COMMIT'],
    'target': os.environ['TARGET'],
    'pushRef': os.environ['PUSH_REF'],
    'releaseTag': os.environ['RELEASE_TAG'],
    'allowlistSha256': os.environ['ALLOWLIST_SHA'],
}, indent=2) + '\n'
if os.environ['INITIAL_BUNDLE']:
    # Publish a complete receipt atomically, without replacing an existing path
    # even if another exporter won the race after the common preflight.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.relayhall-receipt-', delete=False) as output:
            temporary = Path(output.name)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink()
else:
    path.write_text(payload)
    path.chmod(0o600)
PY
}

verify_receipt() {
  python3 - "$RECEIPT" "$SOURCE_SHA" "$PUBLIC_COMMIT" "$TARGET" "$PUSH_REF" "$RELEASE_TAG" "$ALLOWLIST_SHA" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
if not path.is_file(): raise SystemExit('dry-run receipt is missing')
data = json.loads(path.read_text())
expected = {'schema': 3, 'sourceSha': sys.argv[2], 'publicCommit': sys.argv[3], 'target': sys.argv[4], 'pushRef': sys.argv[5], 'releaseTag': sys.argv[6], 'allowlistSha256': sys.argv[7]}
if data != expected: raise SystemExit('dry-run receipt does not match the exact promotion')
PY
}

# Export transport bytes only: no Git remote is added and no push is made.
# The artifact receipt is separate from the schema-3 publication receipt so
# existing owner-approved GitHub promotion verification remains unchanged.
export_initial_bundle() {
  [ -z "$BASE_COMMIT" ] || { echo 'Initial bundle requires a root commit; target main already exists' >&2; return 2; }
  python3 - "$PUBLIC" "$INITIAL_BUNDLE" "$ROOT" "$RECEIPT" "$REMOTE_OK" <<'PY'
import hashlib, json, os, subprocess, sys, tempfile
from pathlib import Path
repo, requested, root, receipt_file, remote_ok = sys.argv[1:]
out = Path(requested).absolute()
metadata = Path(str(out) + '.json')
source_root = Path(root).resolve()
for candidate in (out, metadata):
    if candidate.exists() or candidate.is_symlink():
        raise SystemExit('Initial bundle outputs must not already exist')
    if candidate.resolve().is_relative_to(source_root):
        raise SystemExit('Initial bundle outputs must be outside the source checkout')
receipt = Path(receipt_file)
def git(*args):
    return subprocess.check_output(['git', '-C', repo, *args], text=True).strip()
commit = git('rev-parse', 'refs/heads/main')
if git('rev-list', '--count', 'refs/heads/main') != '1' or len(git('rev-list', '--parents', '-n', '1', commit).split()) != 1:
    raise SystemExit('Initial bundle must contain exactly one parentless commit')
approval = json.loads(receipt.read_text())
if approval['publicCommit'] != commit or approval['pushRef'] != 'refs/heads/main':
    raise SystemExit('Initial bundle does not match the publication receipt')
out.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='.relayhall-bundle-', dir=out.parent) as temporary:
    bundle = Path(temporary) / 'candidate.bundle'
    git('bundle', 'create', str(bundle), 'refs/heads/main')
    refs = git('bundle', 'list-heads', str(bundle)).splitlines()
    if refs != [commit + ' refs/heads/main']:
        raise SystemExit('Initial bundle must advertise only main')
    subprocess.run(['git', '-C', repo, 'bundle', 'verify', str(bundle)], check=True, stdout=subprocess.DEVNULL)
    data = {
        'schema': 1, 'sourceSha': approval['sourceSha'], 'publicCommit': commit,
        'tree': git('rev-parse', commit + '^{tree}'), 'commitCount': 1,
        'refs': {'refs/heads/main': commit},
        'target': approval['target'], 'targetState': 'empty' if remote_ok == 'true' else 'unverified',
        'bundleSha256': hashlib.sha256(bundle.read_bytes()).hexdigest(),
        'publicationReceiptSha256': hashlib.sha256(receipt.read_bytes()).hexdigest(),
        'allowlistSha256': approval['allowlistSha256'],
        'checks': {'allowlist': 'passed', 'residue': 'passed', 'gitleaks': '8.28.0 passed'},
    }
    # Exclusive creation prevents an export from replacing a reviewed artifact.
    with out.open('xb') as dest:
        dest.write(bundle.read_bytes())
    out.chmod(0o600)
    with metadata.open('x') as dest:
        json.dump(data, dest, indent=2)
        dest.write('\n')
    metadata.chmod(0o600)
print('INITIAL_BUNDLE=' + str(out))
print('INITIAL_BUNDLE_RECEIPT=' + str(metadata))
PY
}

if [ "$MODE" = dry-run ]; then
  write_receipt
  if [ -n "$INITIAL_BUNDLE" ]; then export_initial_bundle; fi
  printf 'DRY_RUN_ONLY=1\nRECEIPT=%s\n' "$RECEIPT"
  exit 0
fi

verify_receipt
if [ "$MODE" = push ]; then
  [ "$RELAYHALL_PUBLICATION_APPROVED_PUBLIC_COMMIT" = "$PUBLIC_COMMIT" ] || { echo "Owner-approved public commit is mismatched" >&2; exit 2; }
  RECEIPT_SHA=$(sha256sum "$RECEIPT" | cut -d' ' -f1)
  [ "$RELAYHALL_PUBLICATION_APPROVED_RECEIPT_SHA256" = "$RECEIPT_SHA" ] || { echo "Owner-approved receipt SHA-256 is mismatched" >&2; exit 2; }
fi
if [ -n "$REMOTE_MAIN" ] && ! $HAS_CHANGES && [ -z "$RELEASE_TAG" ]; then
  echo 'The public main tree already matches this source; nothing to promote or tag' >&2
  exit 2
fi
if [ -n "$RELEASE_TAG" ]; then
  git -C "$PUBLIC" tag "$RELEASE_TAG" "$PUBLIC_COMMIT"
fi

if [ "$MODE" = push ]; then
  ASKPASS="$TMP/askpass.sh"
  cat > "$ASKPASS" <<'EOF'
#!/usr/bin/env sh
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) cat "$RELAYHALL_GITHUB_TOKEN_FILE" ;;
  *) exit 1 ;;
esac
EOF
  chmod 700 "$ASKPASS"
  GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 safe_git_remote -C "$PUBLIC" push --porcelain "$TARGET" "HEAD:$PUSH_REF"
  if [ -n "$RELEASE_TAG" ]; then
    GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 safe_git_remote -C "$PUBLIC" push --porcelain "$TARGET" "refs/tags/$RELEASE_TAG"
  fi
else
  safe_git_remote -C "$PUBLIC" push --porcelain "$TARGET" "HEAD:$PUSH_REF"
  if [ -n "$RELEASE_TAG" ]; then safe_git_remote -C "$PUBLIC" push --porcelain "$TARGET" "refs/tags/$RELEASE_TAG"; fi
fi
printf 'PUSHED_PUBLIC_COMMIT=%s\n' "$PUBLIC_COMMIT"
if [ -n "$REMOTE_MAIN" ] && $HAS_CHANGES; then
  printf 'OPEN_PROMOTION_PR=https://github.com/relayhall/relayhall/compare/main...promotions/gitea-%s?expand=1\n' "${SOURCE_SHA:0:12}"
fi
