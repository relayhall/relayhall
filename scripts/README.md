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
| `test-first-install.py` | Fresh install: `setup.sh` generates the four key sets once in the parsers' formats, never changes them, keeps values supplied another way, keeps `relayhall.config.json` readable, and Compose forwards them; `--self-proof` runs its mutants |
| `test-publish-gate.sh` | Publication gate self-test (rejects symlinks, archive payloads; secret-scans expanded content) |
| `test-github-config.sh` | Public repository configuration checks |

## Manual drills (not run by CI)

- `mobile-overflow-census.mjs` — serves the built dashboard against a stubbed
  API in headless Chromium and visits every dashboard route (the Action Center
  on all five tabs) at 375 px and 320 px, failing when any route scrolls
  sideways. It reads the page-frame containers as well as the document, because
  the frame clips sideways overflow and `document.scrollingElement` alone reads
  clean. It needs a Chromium and the `playwright` package, which the frontend
  job does not install: `(cd frontend && npx vite build) && node
  scripts/mobile-overflow-census.mjs frontend/dist <output dir>` (`--shots`
  keeps a screenshot per route; `--expect-fail=<route ids>` is the red-first
  proof against a base build). A route may also name control rows (the Tasks
  page header, the board status tabs, the Map toolbar): each must be ONE line
  (every control on one top edge, the row no taller than its tallest control
  plus its own padding), scroll inside itself when it overflows, keep every
  control reachable by focus (not covered by a neighbour) and by scrolling to
  the end, and the header's More menu must open unclipped. E466 adds the
  phone checks read at rest: New task fully visible and clear of the row's
  edge fade, the Map's "N tasks in view" count seen without scrolling, Re-pack
  layout / Show as list / Map and list as icon-only buttons (accessible name from
  the browser's accessibility tree, tooltip, 44 px square), the 44 px touch
  floor of both rows (also read at 768 px) and an axe-core pass over the rows
  (axe-core is read from `frontend/node_modules` when installed). E469 adds:
  every control of the Tasks header clear of the row's end fade at rest (Search
  icon-only, its word hidden visually), and for every icon-only button of both
  rows a real long press (CDP touch input, at 375 px and 320 px) that shows a
  `role=tooltip` label inside the viewport (not before ~500 ms), moves nothing,
  fires no click and is gone on release, plus a resting mouse and keyboard
  focus (Escape and blur hide it), and the label in the relay-dark,
  relay-light and high-contrast themes (its own contrast >= 4.5:1, axe clean).

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
