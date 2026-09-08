# Grants

A **grant** is object-level authority: it says a grantee may perform a
**verb** on a **resource**. Grants complement credential scopes — scopes say
*what kind of thing* a credential may do board-wide; a grant narrows or
widens that to *specific objects*.

```
(grantee, resource_type, resource_id | *, verb, expires?)
```

- **grantee** — a **principal** or a **Group** (`grantee_type`). A group
  grant reaches its member Accounts by a membership join **at query time**
  — nothing is materialized per member, so membership changes apply on the
  very next request, and a member whose Account is not `active` gets
  nothing from its groups. Deleting a group deletes its grant rows in the
  same transaction. (Groups arrived with AZ-S1, design `4d961e37` §3; see
  [groups](api.md).)
- **resource_type** — one of `task`, `phase`, `project`, `report`, `skill`,
  `personality`, `service`, `plugin`. (`phase` and `plugin` are accepted by
  the schema ahead of their objects landing.)
- **resource_id** — a specific object's UUID, or **omitted/null** for the
  type-wide **wildcard** (every object of that type).
- **verb** — one of `read`, `write`, `use`, `invoke`, `admin` (the five
  ratified authority verbs).
- **expires** — an optional future timestamp; an expired grant stops
  applying.

## Behaviour

- **Revocation is deletion.** A grant is live authority configuration, not
  history; removing it deletes the row. There is no "revoked" state to
  resurrect — which is deliberate, because a revoked-but-present row is
  exactly the kind of thing an accidental re-create can silently lift.
- **Duplicates are refused.** The same `(grantee, resource, verb)` — with
  the wildcard counting as one specific target — cannot be granted twice
  (`409 GRANT_EXISTS`).
- **Grants are enforced** by the shared authorization predicate (RH-P2.5)
  on every identity path: point decisions and list narrowing compose the
  same SQL seam, so a grant — principal- or group-addressed — applies
  identically to both.

## Authority

**Grant mutation is owner-plane.** Creating, widening and revoking grants
sit behind the `root` sentinel — grant management stays out of the agent
plane, because a prompt-injected agent that could grant itself authority
would defeat the whole model. A principal may **introspect its own** grants
with `principals:read`; reading another principal's grants requires the
management gate (the same split as credentials).

Internal server-side writers that are not request principals — the
credential-less `system` principal and the synthetic task-Verifier actor —
are outside the grants domain; grants address principals.

## Manage grants

```bash
relayhall grant list
relayhall grant list --grantee <principal-uuid> --resource-type task
relayhall grant add <principal-uuid> report read
relayhall grant add <principal-uuid> task read --resource <task-uuid> --expires-at <iso>
relayhall grant remove <grant-uuid>
relayhall principal grants <principal>
```

`grant add` with no `--resource` creates the type-wide wildcard. The
mutating verbs need a `root` credential.

REST:

- `GET /grants` (+`?granteeId=`, `?resourceType=`) — owner plane
- `POST /grants` — owner plane; grantees are principals or Groups
- `DELETE /grants/{id}` — owner plane
- `GET /principals/{id}/grants` — own grants at `principals:read`, others behind the manage gate
