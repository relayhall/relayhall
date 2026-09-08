# Skills

A Skill is Agent-Skills-conformant instruction content. RelayHall stores the
complete `SKILL.md` document, its SHA-256 digest, provenance, creator and an
append-only lifecycle. It serves instructions to agents but never executes
anything the Skill describes. Never store secrets in a Skill; reference the
approved vault or credential mechanism instead.

## Immutable Versions and review

The catalog name is stable and every content edit creates the next immutable
Version. Versions move through `draft → review → published → retired`.
Rejection returns `review → draft`; retirement is terminal. Publication is a
human-admin action and the Version creator cannot approve their own work.

Provenance is one of `human-authored`, `imported`, or `agent-drafted`.
Imported Versions require a source URI. Only a published Version can become a
new project pin or the current global Version.

## Global selection and exact project pins

- A global Skill resolves through its current published Version.
- A project link pins one exact published Version. Retiring it prevents new
  pins but never changes or breaks an existing pin.
- Project-specific adaptations are new reviewed Versions; unversioned
  instruction overrides no longer exist.

## Manage Skills

The dashboard Skills page shows Version history, provenance and lifecycle
actions. Equivalent CLI surfaces include:

```bash
relayhall skills
relayhall skill list
relayhall skill get <id> --version 2 --full
relayhall skill search <query>
relayhall skill create --name "vault-cli" --category infra --description "..."
relayhall skill update <id> --description "..."
relayhall skill versions <id>
relayhall skill submit-review <id> 2 --note "ready"
relayhall skill reject <id> 2 --note "revise safety section"
relayhall skill publish <id> 2 --note "approved"
relayhall skill audience <id> global
relayhall skill retire <id> 1
relayhall skill pin <id> <project> 2
relayhall skill unpin <id> <project>
relayhall skill delete <id> --confirm
relayhall skill context <project>
```

`PUT /skills/{id}` creates the next draft; it does not mutate an old Version.
Broad audience is a separate admin action after publication; draft creation
and updates therefore do not accept the retired `--global` / `--no-global`
shortcuts.
Hard deletion is admin-only and refused while history or pins exist. Routine
removal is retirement.

REST adds metadata and full-content separation:

- `GET /skills` and `GET /skills/{id}`
- `GET /skills/{id}/versions` and `GET /skills/{id}/versions/{version}`
- `GET /skills/{id}/versions/{version}/content`
- lifecycle routes ending in `submit-review`, `reject`, `publish`, `retire`
- `PUT|DELETE /projects/{project}/skills/{skill}` for exact pins

The old `/tools` family remains retired. MCP exposes the read-only
`relayhall_skill_list` and `relayhall_skill_get`; the latter accepts an exact
Version and can fetch full content.

## Scopes

- `skills:read`: catalog and Version metadata
- `skills:use`: exact full `SKILL.md` content
- `skills:write`: create drafts and request/respond to review
- `skills:admin`: publish, retire, change broad/global audience, hard delete

Brief compilation remains under `tasks:read` by owner ruling. It resolves only
published global Versions and exact project pins, and includes Version ID,
digest, provenance and explicit quoted-content delimiters.

## Skills vs Tools

A Skill is instruction content. A Tool is a callable operation exposed by a
Service, in MCP's sense of the word. The concepts and permissions remain
separate.
