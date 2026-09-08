# Charter

A Charter is a project's **authority index**: one document per project that
locates every governing agreement — with status and precedence — carries the
standing directives, and **asserts nothing new**. Where the Charter appears to
conflict with a document it points at, the underlying document wins; fixing the
index is the bug fix. A Charter locates authority, it never restates it —
duplication is drift.

Every compiled Brief for the project includes the Charter automatically, so an
agent picking up a single task starts with the project's governing agreements
in hand — nobody has to remember to send them.

## Behaviour

- **One Charter per project.** Creating a second is impossible by schema.
- **Owner-plane writes.** Reading a Charter needs only `projects:read`;
  writing one is reserved for the deployment's human authority (the `root`
  sentinel — not grantable to agent credentials). Agents propose changes
  through Reports; the owner applies them.
- **Versioned.** Every content change bumps a version counter and records the
  full content with attribution. Restoring an old version is an ordinary
  write of that version's content.
- **Revision-bound writes.** Replacing an existing Charter requires the last
  observed `revision` (`If-Match`); a stale revision is `412
  REVISION_MISMATCH`. Creating the first version needs no revision.
- **Archived projects are read-only.** The Charter stays readable, but writes
  answer `409 PROJECT_ARCHIVED`. Archived projects compile no Briefs, so they
  carry no Charter context either.

## Manage a Charter

```bash
relayhall charter get <project>
relayhall charter get <project> --content-only
relayhall charter set <project> --file <file>
relayhall charter set <project> --content "Charter text" --revision <revision>
relayhall charter versions <project>
relayhall charter show-version <project> <version>
```

`charter set` creates the Charter when the project has none (no `--revision`
needed) and replaces it otherwise (`--revision` required). Identical content
is a no-op: no version churn.

REST:

- `GET /projects/{id}/charter` — the head: content, `version`, `revision`
- `PUT /projects/{id}/charter` — create (201) or replace (200, `If-Match`)
- `GET /projects/{id}/charter/versions` — version metadata, newest first
- `GET /projects/{id}/charter/versions/{n}` — one version, with content

The stdio MCP server exposes read-only access through `relayhall_charter_get`;
mutation is owner-plane and goes through the CLI or REST.

## What belongs in a Charter

An index, not an essay: the governing documents (strategies, rulings,
contracts) each with a one-line scope and precedence note; the standing
directives agents must follow; the open owner gates. Substance lives in the
documents the Charter points to — usually Reports — and the Charter cites
them. A Charter that restates content will drift from it; a stale index is
worse than none.
