# Repository scripts

An inventory of everything in `scripts/`. For database backup and restore,
**[database/README.md](../database/README.md) is the canonical guide** — it
documents the current `database/backup.sh` / `database/restore.sh` helpers.

## Quality gates (run by CI; run them locally before merging)

| Script | What it enforces |
|---|---|
| `check-doc-terminology.py` | Ratified vocabulary across all Markdown documentation |
| `test-terminology-gate.py` | Self-proof of the terminology gate (known-bad fixtures must fail) |
| `check-design-tokens.py` | Every `var(--token)` in frontend CSS resolves to a defined or runtime-set custom property |
| `test-design-token-gate.py` | Self-proof of the design-token gate |
| `audit-dead-css.py` | The rendered-class gate run backwards: every class a guarded stylesheet OWNS (the first class token of a selector's first compound) must be rendered, assemblable at runtime, or written down somewhere on purpose. Modifier and context classes are out of scope by construction. `--check` is the CI arm |
| `test-dead-css-audit.py` | Self-proof of the dead-selector census (a rendered class must never be called dead; an invented one must be) |
| `check-public-allowlist.py` | `.relayhall-public-allowlist` matches the tracked tree exactly |
| `check-public-residue.py` | No private deployment provenance in the tree. Generic checks are built in; deployment-specific patterns load from the `RELAYHALL_RESIDUE_PATTERNS` secret (CI) or an untracked `.residue-patterns.local.json` — they are deliberately not published inside the scanner |
| `test-public-residue-gate.py` | Self-proof of the residue gate's pattern loader (malformed sets must exit 2) |
| `test-deployment-safety.sh` | Deployment-procedure safety checks |
| `test-publish-gate.sh` | Publication gate self-test (rejects symlinks, archive payloads; secret-scans expanded content) |
| `test-github-config.sh` | Public repository configuration checks |

## Publication

- `publish-to-github.sh` — builds and gates the curated public snapshot.
- `configure-github-repository.sh` — applies the expected public repository
  settings.
- `prepare-secret-scan-inputs.py` — expands encoded content for the
  publication secret scan.

## Operational helpers

- `backup-db.sh` / `restore-db.sh` — legacy database helpers kept for
  compatibility; prefer `database/backup.sh` / `database/restore.sh`
  (see [database/README.md](../database/README.md)). Restores are
  destructive and prompt for confirmation.
- `relayhall-doctor-weekly.sh` — wraps the CLI doctor for scheduled runs;
  scheduling is deployment-specific and not preconfigured.

## Setup helpers

- `../setup.sh` (repository root) — interactive first-run setup: generates
  `.env` and hashes the dashboard password, then prints the validation and
  start commands (`docker compose config --quiet`, `docker compose up -d
  --build --wait`) as next steps — it does not start the stack itself.
- `../backend/scripts/hash-password.js` — bcrypt hash generator for
  `DASHBOARD_PASSWORD_HASH`; run it with the backend dependencies installed:

  ```bash
  cd backend && npm ci && node scripts/hash-password.js yourpassword
  ```
