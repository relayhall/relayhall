# Publication and repository model

RelayHall uses three deliberately separate Git repositories:

- **private working repository:** the owner-controlled Gitea repository;
- **private release-staging repository:** an owner-controlled Gitea repository
  containing the sanitized release candidate, with no private working ancestry;
- **canonical public repository:** `https://github.com/relayhall/relayhall`.

The private working repository retains development history. The private staging
repository is where the exact sanitized first-release candidate is tested and reviewed. GitHub is
the public source of record once a snapshot is promoted. Gitea must not be
configured as an automatic push mirror: publication is an explicit, allowlisted,
secret-scanned release action.

## Publication gate

`scripts/publish-to-github.sh` defaults to dry-run and cannot push accidentally.
For an exact committed source it:

1. requires a clean private working tree;
2. requires every committed file path to match
   `.relayhall-public-allowlist` exactly;
3. exports only those individually allowlisted files with `git archive`;
4. rejects deployment-specific host, account, path, operator, and unapproved private-IP residue;
5. rejects archive payloads and symbolic links, recursively expands Base64-like
   content to a fail-closed resource budget, and scans both original and expanded
   bytes with Gitleaks exactly at version `8.28.0`;
6. builds a deterministic public commit linked to the private source SHA;
7. prints the complete public diff and writes a mode-`0600` receipt.

A production push additionally requires all of:

- the canonical GitHub URL;
- `RELAYHALL_PRIVATE_ORIGIN` matching the exact private origin;
- private `main` as the source;
- `RELAYHALL_PUBLICATION_APPROVED_SHA` matching the exact 40-character source;
- `RELAYHALL_PUBLICATION_APPROVED_PUBLIC_COMMIT` matching the reviewed public
  commit;
- `RELAYHALL_PUBLICATION_APPROVED_RECEIPT_SHA256` matching the reviewed,
  mode-`0600` dry-run receipt;
- a short-lived `GITHUB_TOKEN` supplied through the environment.

The token is moved into a temporary mode-`0600` file, removed from the process
environment, and read by a temporary mode-`0700` askpass helper. It is not
written into a command argument, remote URL, Git configuration, receipt, report,
or log; the temporary directory is removed on exit.

Example dry-run (safe; no GitHub write):

```bash
./scripts/publish-to-github.sh \
  --source main \
  --receipt /tmp/relayhall-publish-receipt.json
```

Only after the owner has inspected the exact SHA, public commit, target, push
reference, optional release tag, path diff, and scan result may the same receipt
be used with `--push`. Production recomputes the snapshot and requires the
owner-approved public commit and receipt SHA-256; it does not overwrite the
prior receipt.

## Private staging before the first public release

The initial candidate can be transported without granting the publisher another
network push mode:

```bash
RELAYHALL_RESIDUE_PATTERNS_FILE=/secure/path/residue-patterns.local.json \
./scripts/publish-to-github.sh \
  --source main \
  --target "$PRIVATE_RELEASE_REPOSITORY" \
  --receipt /secure/output/publication.json \
  --initial-bundle /secure/output/initial.bundle
```

This remains a dry-run: it performs the same allowlist, residue and pinned
Gitleaks checks, then exports only `refs/heads/main` with exactly one parentless
commit. The bundle and its adjacent `.json` artifact receipt are mode `0600`;
existing outputs are never overwritten. The receipt binds the source commit,
sanitized commit/tree, bundle digest, publication-receipt digest and scan results.
It contains no credentials or deployment-pattern contents. Prerelease tags such
as `v1.0.0-beta.1` are supported by the normal publication gate, but bundle export
does not create a tag and cannot be combined with `--release-tag` or a push mode.

If the private target cannot be inspected with the gate's isolated Git identity,
the artifact explicitly records `targetState: unverified`. That is not evidence
of an empty repository. Before staging, the operator independently verifies the
exact destination is private, is empty, and has no automatic mirror. Review the
artifact hashes and root commit, clone with `git clone --branch main initial.bundle
release-candidate` into a separate checkout, and
push **only that exact main ref** to the approved private staging destination.
Never push development `main`, use `--mirror`, or force an existing staging ref.
Keep the working repository's origin and history unchanged.

Run the required CI and installation checks against the staged root commit and
record its relationship to the tested working-source SHA. Any source change
requires a new scanned candidate and new exact review evidence; it does not
authorize overwriting an already reviewed remote commit. A beta tag is assigned
only to the confirmed candidate, with explicit release authorization.

Staging approval is **not GitHub publication approval**. Before the first GitHub
write, obtain owner approval for the exact source, public root, tag and canonical
target. Generate a fresh canonical-target dry-run receipt and confirm it produces
the same root/tree as the tested staging candidate; then use the existing
`--push` gate with its exact approval variables. A private-staging receipt cannot
be reused as a canonical-target approval. No script automatically mirrors staging
to GitHub.

After GitHub has community history, do not create another root import or reset
either public history or staging refs. Follow the normal promotion-branch/PR
workflow below, with the current canonical public main as parent. Staging is a
review checkpoint, not a replacement for public history or reverse synchronization.

## Initial import and later promotions

If the public repository is completely empty, the gate creates one curated root
commit. A target with any existing ref but no `main` is rejected rather than
misclassified as empty. The private Gitea history is intentionally not published.

After public `main` exists, the gate never updates it directly. It pushes a
`promotions/gitea-<source>` branch and prints the comparison URL. That branch is
merged through an ordinary reviewed pull request with required CI. This keeps
GitHub canonical and preserves community history.

Release tags use `vMAJOR.MINOR.PATCH`, optionally with a prerelease suffix such as
`v1.0.0-beta.1`. A tag is not created on an unmerged
promotion branch; it must identify the accepted public commit.

## GitHub configuration

The configuration helper never pushes Git content:

```bash
./scripts/configure-github-repository.sh --plan
```

With explicit owner authorization and an appropriately scoped token,
`--prepare` creates or updates only an empty public repository, topics, merge policy,
and private vulnerability reporting. After the first import, `--protect` makes
`main` require one independent approval, conversation resolution, strict success
from all four CI jobs, administrator enforcement, and force-push/deletion denial.
The helper reads the protection object back and fails closed unless every required
setting matches.

## Community changes and reverse synchronization

Community changes begin as GitHub pull requests. GitHub changes are **not**
automatically pulled into Gitea and Gitea is never allowed to overwrite them.
Before the next private promotion, a maintainer deliberately reviews the accepted
public change, applies or adapts it to private Gitea `main`, runs the normal gates,
and records the public PR/commit in release evidence. The next promotion then
uses current GitHub `main` as its parent and shows any remaining tree difference.

This deliberate reverse-sync step is the conflict-resolution boundary. When the
private and public trees disagree, publication stops for human reconciliation;
neither side silently wins.

## Name-reservation packages

The source for the previously published npm, PyPI, and crates.io version `0.0.1`
reservation packages lives under `name-reservation/`. Generated artifacts and
registry credentials are excluded. Those stubs are not an SDK or server release,
and later registry publication is a separate gated action.

Publication targets must be credential-free HTTPS URLs or SSH URLs using the
`git` transport username (for example `ssh://git@host:222/owner/repo.git` or
`git@host:owner/repo.git`). HTTPS user information, URL query strings and
fragments, and SSH passwords or encoded user information are rejected before
network access or output. Use the supported credential mechanism separately.
Absolute local paths and local `file://` URLs remain available for gate tests.

Initial bundle exports require three new, distinct paths outside the source
checkout: the publication receipt, bundle, and bundle `.json` receipt. Existing
outputs are refused before any write; the publication receipt is created
exclusively and atomically. Keep reviewed artifacts immutable and choose new
paths for a new candidate.
