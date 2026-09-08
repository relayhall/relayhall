#!/usr/bin/env bash
# Exercise the publication gate without touching GitHub.
set -euo pipefail
umask 077
ROOT=$(git rev-parse --show-toplevel)
TMP=$(mktemp -d)
REWRITE_KEY=
cleanup() {
  if [ -n "$REWRITE_KEY" ]; then
    git -C "$ROOT" config --local --unset-all "$REWRITE_KEY" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
BARE="$TMP/public.git"
RECEIPT="$TMP/receipt.json"
BUNDLE="$TMP/initial.bundle"
git init --quiet --bare "$BARE"
ATTACKER="$TMP/attacker.git"
git init --quiet --bare "$ATTACKER"
mkdir -p "$TMP/malicious-home"
git config --file "$TMP/malicious-home/.gitconfig" "url.$ATTACKER.insteadOf" "$BARE"
REWRITE_KEY="url.$ATTACKER.insteadOf"
git -C "$ROOT" config --local "$REWRITE_KEY" "$BARE"

HOME="$TMP/malicious-home" "$ROOT/scripts/publish-to-github.sh" \
  --source HEAD --target "$BARE" --receipt "$RECEIPT" --initial-bundle "$BUNDLE" > "$TMP/dry-run.log"
grep -q '^DRY_RUN_ONLY=1$' "$TMP/dry-run.log"
[ "$(stat -c '%a' "$RECEIPT")" = 600 ]
[ "$(stat -c '%a' "$BUNDLE")" = 600 ]
[ "$(stat -c '%a' "$BUNDLE.json")" = 600 ]
python3 - "$BUNDLE" "$RECEIPT" <<'PY'
import hashlib, json, subprocess, sys
from pathlib import Path
bundle, receipt = map(Path, sys.argv[1:])
data = json.loads(Path(str(bundle) + '.json').read_text())
approval = json.loads(receipt.read_text())
assert data['publicCommit'] == approval['publicCommit']
assert data['sourceSha'] == approval['sourceSha']
assert data['commitCount'] == 1 and data['targetState'] == 'empty'
assert data['bundleSha256'] == hashlib.sha256(bundle.read_bytes()).hexdigest()
assert data['publicationReceiptSha256'] == hashlib.sha256(receipt.read_bytes()).hexdigest()
assert subprocess.check_output(['git', 'bundle', 'list-heads', str(bundle)], text=True).strip() == data['publicCommit'] + ' refs/heads/main'
PY
git clone --quiet --branch main "$BUNDLE" "$TMP/bundle-copy"
[ "$(git -C "$TMP/bundle-copy" rev-list --count main)" = 1 ]
[ "$(git -C "$TMP/bundle-copy" rev-parse main^{tree})" = "$(git -C "$ROOT" rev-parse HEAD^{tree})" ]
! git -C "$TMP/bundle-copy" cat-file -e "$(git -C "$ROOT" rev-parse HEAD)^{commit}" 2>/dev/null
! git --git-dir="$BARE" rev-parse refs/heads/main >/dev/null 2>&1

sha256sum "$RECEIPT" "$BUNDLE" "$BUNDLE.json" > "$TMP/reviewed.sha256"
# An export never overwrites a previously reviewed bundle and cannot acquire
# push or tagging semantics through another flag.
if "$ROOT/scripts/publish-to-github.sh" --source HEAD --target "$ATTACKER" \
  --receipt "$RECEIPT" --initial-bundle "$BUNDLE" > "$TMP/repeated.out" 2>&1; then
  echo 'Existing bundle was unexpectedly overwritten' >&2; exit 1
fi
grep -q 'outputs must not already exist' "$TMP/repeated.out"
sha256sum --check --status "$TMP/reviewed.sha256"

# Hostile synthetic credentials must be rejected before output or artifacts.
for target in \
  'https://user:PUBLICATION-FAKE-CREDENTIAL@example.invalid/repo.git' \
  'https://example.invalid/repo.git?PUBLICATION-FAKE-CREDENTIAL' \
  'https://example.invalid/repo.git#PUBLICATION-FAKE-CREDENTIAL' \
  'ssh://git:PUBLICATION-FAKE-CREDENTIAL@example.invalid/repo.git' \
  'ssh://git%3APUBLICATION-FAKE-CREDENTIAL@example.invalid/repo.git'; do
  if "$ROOT/scripts/publish-to-github.sh" --target "$target" \
    --receipt "$TMP/hostile.json" --initial-bundle "$TMP/hostile.bundle" > "$TMP/hostile.out" 2>&1; then
    echo 'Credential-bearing target unexpectedly accepted' >&2; exit 1
  fi
  ! grep -q 'PUBLICATION-FAKE-CREDENTIAL' "$TMP/hostile.out"
  grep -q 'credential-free' "$TMP/hostile.out"
  [ ! -e "$TMP/hostile.json" ] && [ ! -e "$TMP/hostile.bundle" ] && [ ! -e "$TMP/hostile.bundle.json" ]
done
# Valid SSH transport usernames reach the existing-output preflight without
# contacting a server. Local target acceptance is covered by the actual export.
for target in 'ssh://git@example.invalid:222/repo.git' 'git@example.invalid:repo.git'; do
  if "$ROOT/scripts/publish-to-github.sh" --target "$target" \
    --receipt "$RECEIPT" --initial-bundle "$BUNDLE" > "$TMP/ssh.out" 2>&1; then
    echo 'Reviewed outputs unexpectedly accepted' >&2; exit 1
  fi
  grep -q 'outputs must not already exist' "$TMP/ssh.out"
done

for mode in --push --test-push; do
  if "$ROOT/scripts/publish-to-github.sh" --initial-bundle "$TMP/refused.bundle" "$mode" > "$TMP/refused.out" 2>&1; then
    echo 'Initial bundle unexpectedly accepted a push mode' >&2; exit 1
  fi
  grep -q 'requires dry-run' "$TMP/refused.out"
done
if "$ROOT/scripts/publish-to-github.sh" --initial-bundle "$TMP/refused.bundle" \
  --release-tag v1.0.0-beta.1 > "$TMP/refused.out" 2>&1; then
  echo 'Initial bundle unexpectedly accepted a tag mutation' >&2; exit 1
fi
grep -q 'requires dry-run' "$TMP/refused.out"

HOME="$TMP/malicious-home" RELAYHALL_TEST_MODE=1 "$ROOT/scripts/publish-to-github.sh" \
  --source HEAD --target "$BARE" --receipt "$RECEIPT" --test-push > "$TMP/push.log"
grep -q '^PUSHED_PUBLIC_COMMIT=' "$TMP/push.log"
PUBLIC_COMMIT=$(git --git-dir="$BARE" rev-parse refs/heads/main)
[ "$(git --git-dir="$BARE" rev-list --count refs/heads/main)" = 1 ]
! git --git-dir="$ATTACKER" rev-parse refs/heads/main >/dev/null 2>&1
git --git-dir="$BARE" show -s --format=%B "$PUBLIC_COMMIT" | grep -q "Source-Gitea-Commit: $(git -C "$ROOT" rev-parse HEAD)"

"$ROOT/scripts/publish-to-github.sh" \
  --source HEAD --target "$BARE" --receipt "$TMP/second-receipt.json" > "$TMP/second-dry-run.log"
grep -q "^PUBLIC_COMMIT=$PUBLIC_COMMIT$" "$TMP/second-dry-run.log"
if "$ROOT/scripts/publish-to-github.sh" --source HEAD --target "$BARE" \
  --receipt "$TMP/non-root-receipt.json" --initial-bundle "$TMP/non-root.bundle" > "$TMP/non-root.out" 2>&1; then
  echo 'Initial bundle unexpectedly accepted an existing public main' >&2; exit 1
fi
grep -q 'requires a root commit' "$TMP/non-root.out"
[ ! -e "$TMP/non-root.bundle" ]

set +e
RELAYHALL_TEST_MODE=1 "$ROOT/scripts/publish-to-github.sh" \
  --source HEAD --target "$BARE" --receipt "$TMP/second-receipt.json" \
  --release-tag v0.0.1 --test-push > "$TMP/tag-reuse.out" 2> "$TMP/tag-reuse.err"
TAG_REUSE_RC=$?
set -e
[ "$TAG_REUSE_RC" = 1 ]
grep -q 'receipt does not match' "$TMP/tag-reuse.err"

TAG_RECEIPT="$TMP/tag-receipt.json"
"$ROOT/scripts/publish-to-github.sh" \
  --source HEAD --target "$BARE" --receipt "$TAG_RECEIPT" --release-tag v0.0.1 > "$TMP/tag-dry-run.log"
RELAYHALL_TEST_MODE=1 "$ROOT/scripts/publish-to-github.sh" \
  --source HEAD --target "$BARE" --receipt "$TAG_RECEIPT" --release-tag v0.0.1 --test-push > "$TMP/tag-push.log"
[ "$(git --git-dir="$BARE" rev-parse refs/tags/v0.0.1)" = "$PUBLIC_COMMIT" ]
[ "$(git --git-dir="$BARE" rev-parse refs/heads/main)" = "$PUBLIC_COMMIT" ]

# A later private change must go to a promotion branch, never directly to public main.
git clone --quiet "$ROOT" "$TMP/private-next"
git -C "$TMP/private-next" config user.name tester
git -C "$TMP/private-next" config user.email tester@example.invalid
printf '\nPublication routing regression fixture.\n' >> "$TMP/private-next/README.md"
git -C "$TMP/private-next" add README.md
git -C "$TMP/private-next" commit --quiet -m 'test later promotion routing'
NEXT_SHA=$(git -C "$TMP/private-next" rev-parse HEAD)
NEXT_RECEIPT="$TMP/next-receipt.json"
"$TMP/private-next/scripts/publish-to-github.sh" \
  --source HEAD --target "$BARE" --receipt "$NEXT_RECEIPT" > "$TMP/next-dry-run.log"
RELAYHALL_TEST_MODE=1 "$TMP/private-next/scripts/publish-to-github.sh" \
  --source HEAD --target "$BARE" --receipt "$NEXT_RECEIPT" --test-push > "$TMP/next-push.log"
[ "$(git --git-dir="$BARE" rev-parse refs/heads/main)" = "$PUBLIC_COMMIT" ]
git --git-dir="$BARE" rev-parse "refs/heads/promotions/gitea-${NEXT_SHA:0:12}" >/dev/null

grep -q '^OPEN_PROMOTION_PR=' "$TMP/next-push.log"

# The selected policy comes from SOURCE_SHA, not a clean alternate checkout.
git clone --quiet "$ROOT" "$TMP/policy-binding"
git -C "$TMP/policy-binding" config user.name tester
git -C "$TMP/policy-binding" config user.email tester@example.invalid
printf 'private fixture\n' > "$TMP/policy-binding/docs/policy-bypass-fixture.md"
git -C "$TMP/policy-binding" add docs/policy-bypass-fixture.md
git -C "$TMP/policy-binding" commit --quiet -m 'source with unallowlisted path'
POLICY_SOURCE=$(git -C "$TMP/policy-binding" rev-parse HEAD)
git -C "$TMP/policy-binding" checkout --quiet -b alternate HEAD~1
git -C "$TMP/policy-binding" ls-tree -r --name-only "$POLICY_SOURCE" > "$TMP/policy-binding/.relayhall-public-allowlist"
git -C "$TMP/policy-binding" add .relayhall-public-allowlist
git -C "$TMP/policy-binding" commit --quiet -m 'alternate checkout with expanded policy'
set +e
"$TMP/policy-binding/scripts/publish-to-github.sh" --source "$POLICY_SOURCE" \
  --target "$BARE" --receipt "$TMP/policy-binding-receipt.json" \
  > "$TMP/policy-binding.out" 2> "$TMP/policy-binding.err"
POLICY_BINDING_RC=$?
set -e
[ "$POLICY_BINDING_RC" = 2 ]
grep -q 'do not exactly match the allowlist' "$TMP/policy-binding.err"

# A repository with refs but no main is not an empty initial-import target.
ODD="$TMP/nonempty-without-main.git"
git clone --quiet --bare "$BARE" "$ODD"
git --git-dir="$ODD" update-ref refs/heads/other "$PUBLIC_COMMIT"
git --git-dir="$ODD" update-ref -d refs/heads/main
set +e
"$ROOT/scripts/publish-to-github.sh" --source HEAD --target "$ODD" \
  --receipt "$TMP/odd-receipt.json" > "$TMP/odd.out" 2> "$TMP/odd.err"
ODD_RC=$?
set -e
[ "$ODD_RC" = 2 ]
grep -q 'has refs but no main' "$TMP/odd.err"

# A nested committed path is not published until the file-level allowlist changes.
git clone --quiet "$ROOT" "$TMP/unallowlisted"
git -C "$TMP/unallowlisted" config user.name tester
git -C "$TMP/unallowlisted" config user.email tester@example.invalid
printf 'not approved for publication\n' > "$TMP/unallowlisted/docs/unallowlisted-fixture.md"
git -C "$TMP/unallowlisted" add docs/unallowlisted-fixture.md
git -C "$TMP/unallowlisted" commit --quiet -m 'test unallowlisted nested path'
set +e
"$TMP/unallowlisted/scripts/publish-to-github.sh" \
  --source HEAD --target "$BARE" --receipt "$TMP/unallowlisted-receipt.json" \
  > "$TMP/unallowlisted.out" 2> "$TMP/unallowlisted.err"
UNALLOWLISTED_RC=$?
set -e
[ "$UNALLOWLISTED_RC" = 2 ]
grep -q 'do not exactly match the allowlist' "$TMP/unallowlisted.err"

mkdir -p "$TMP/seeded"
python3 - "$TMP/seeded/leak.txt" <<'PY'
import sys
value = 'AKIA' + 'Q7W9E2R4T6Y8U1I3'
open(sys.argv[1], 'w').write('seeded_test_access_key=' + value + '\n')
PY
set +e
"$ROOT/scripts/publish-to-github.sh" --test-scan "$TMP/seeded" > "$TMP/seed.out" 2> "$TMP/seed.err"
SCAN_RC=$?
set -e
[ "$SCAN_RC" = 1 ]

mkdir -p "$TMP/seeded-archive/input"
python3 - "$TMP/seeded-archive/input/credential.txt" <<'PY'
import sys
value = 'AKIA' + 'Q7W9E2R4T6Y8U1I3'
open(sys.argv[1], 'w').write('archived_test_access_key=' + value + '\n')
PY
tar -czf "$TMP/seeded-archive/payload.tar.gz" -C "$TMP/seeded-archive/input" credential.txt
rm -rf "$TMP/seeded-archive/input"
set +e
"$ROOT/scripts/publish-to-github.sh" --test-scan "$TMP/seeded-archive" > "$TMP/archive.out" 2> "$TMP/archive.err"
ARCHIVE_RC=$?
set -e
[ "$ARCHIVE_RC" = 2 ]

mkdir -p "$TMP/seeded-encoded"
python3 - "$TMP/seeded-encoded/value.txt" <<'PY'
import base64, sys
value = 'AKIA' + 'Q7W9E2R4T6Y8U1I3'
payload = ('encoded_test_access_key=' + value + '\n').encode()
for _ in range(5): payload = base64.b64encode(payload)
open(sys.argv[1], 'wb').write(payload)
PY
set +e
"$ROOT/scripts/publish-to-github.sh" --test-scan "$TMP/seeded-encoded" > "$TMP/encoded.out" 2> "$TMP/encoded.err"
ENCODED_RC=$?
set -e
[ "$ENCODED_RC" = 1 ]

mkdir -p "$TMP/seeded-symlink"
ln -s /etc/passwd "$TMP/seeded-symlink/host-file"
set +e
"$ROOT/scripts/publish-to-github.sh" --test-scan "$TMP/seeded-symlink" > "$TMP/symlink.out" 2> "$TMP/symlink.err"
SYMLINK_RC=$?
set -e
[ "$SYMLINK_RC" = 2 ]
grep -q 'Symbolic links are not permitted' "$TMP/symlink.err"

echo 'dry_run_receipt=pass'
echo 'local_single_root_promotion=pass'
echo 'repeat_promotion_is_stable=pass'
echo 'ambient_git_rewrite_block=pass'
echo 'source_commit_policy_binding=pass'
echo 'non_main_remote_ref_block=pass'
echo 'release_tag_receipt_binding=pass'
echo 'release_tag_targets_public_main=pass'
echo 'later_promotion_uses_pr_branch=pass'
echo 'nested_unallowlisted_path_block=pass'
echo 'seeded_secret_block=pass'
echo 'archived_secret_block=pass'
echo 'encoded_secret_block=pass'
echo 'symlink_publication_block=pass'
