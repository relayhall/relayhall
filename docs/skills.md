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
Each successful write commits one audit row with the write: `skill.create`,
`skill.create_version`, `skill.submit_review`, `skill.reject`, `skill.publish`,
`skill.retire`, `skill.set_global`, `skill.delete`, `skill.project_pin` or
`skill.project_unpin`. The underscore/dot names follow the audit sink's
existing action-name contract. Publication still names the Version and the
Version it replaced. Other writes retain safe Version IDs, lifecycle states,
provenance, audience flags or Project pin IDs as appropriate. Skill names,
descriptions, content and decision notes never enter this metadata.

Refused writes with a resolved caller record a separate `denied` row, including
route/authorization refusals and publish or review decisions. The row records
the caller's actual authentication method and credential ID when available,
plus the refusal code and status. Direct service callers without transport
evidence remain `unknown`; no caller is invented. A denied write is recorded
after rollback. Failure to write a successful act's audit row rolls back that
act; a failed denial audit returns `AUDIT_WRITE_FAILED` rather than claiming
the audit exists. Publication authority and independent review are unchanged.

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
relayhall skill owner <id> <account-id> --reason "assign to the drafting Account"
relayhall skill retire <id> 1
relayhall skill pin <id> <project> 2
relayhall skill unpin <id> <project>
relayhall skill delete <id> --confirm
relayhall skill context <project>
```

`PUT /skills/{id}` creates the next draft; it does not mutate an old Version.
`skill create` and `skill update` also take `--skill-md-file <path>`, which
sends a complete `SKILL.md`, frontmatter included, as the Version's exact
content: the digest the registry records is then the SHA-256 of that file.
[Connector onboarding](connector-onboarding.md) uses it to publish the
reviewed `relayhall-connector-bootstrap` source.
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

## Ownership

Every Skill has an owner, a person Account or a Group, or none (migration 162).
The Account that creates a Skill owns it. Published Versions are shared with
every reader; a Skill's unpublished drafts are shown to its owner (and an owning
Group's members), and to registry administrators when a Version waits in review
or when they ask for every owner's drafts (`relayhall skill list --all-owners`,
`GET /skills?owner=all`, the dashboard's "Every owner's drafts" view). An owner
may draft new Versions, submit them for review and return them to draft;
publication stays an independent human admin act. `relayhall skill owner`, the
dashboard's Owner panel and `PUT /skills/{id}/owner` assign the owner
(`skills:admin`, audited `skill.owner.change`); moving a Skill into or out of a
Group needs a login session, an administrator and a step-up. See "Skill
ownership" in [api.md](api.md).

## Scopes

- `skills:read`: catalog and Version metadata
- `skills:use`: exact full `SKILL.md` content
- `skills:write`: create drafts and request/respond to review
- `skills:admin`: publish, retire, change broad/global audience, assign the owner, hard delete

Brief compilation remains under `tasks:read`. It resolves only
published global Versions and exact project pins, and includes Version ID,
digest, provenance and explicit quoted-content delimiters.

## Skills vs Tools

A Skill is instruction content. A Tool is a callable operation exposed by a
Service, in MCP's sense of the word. The concepts and permissions remain
separate.
