# Execution Profiles

An execution profile names a **Connector** — a registered Service that pulls
and executes work — and carries **only the options that Connector declared**
in its pinned capability-descriptor version. RelayHall never runs agents
itself: the profile is structured task data that travels with the compiled
Brief; the pulling harness reads it, revalidates it, and decides.

## Data model

```json
{
  "serviceId": "<uuid of a published Connector>",
  "descriptorVersion": 3,
  "options": { "template": "patch-fleet", "dryRun": false },
  "parameters": { "template": { "inventoryLimit": "web*", "deployKey": "semaphore-deploy-key" } }
}
```

- `serviceId` — a **published** Connector from the Service registry
  (see [services.md](services.md)). A plain Service or a draft/retired
  Connector is refused by name.
- `descriptorVersion` — the immutable capability-descriptor version the
  options were validated against. Omitted on write, it resolves to the
  Connector's current version and is stored resolved. A **retired** version
  is refused (`PROFILE_DESCRIPTOR_RETIRED`): retirement stops new consumers
  while existing pins keep resolving read-only, and re-pinning forces full
  re-validation.
- `options` — scalar values for descriptor-declared option keys. Undeclared
  keys, wrong types, non-member enum values and missing required options
  are refused with the exact field named.
- `parameters` — one level of per-option parameters (for example the
  variables of the chosen workflow). A `secretReference` value must be one
  of the Connector's declared reference *names* — the board stores and pins
  names; secret material never reaches it.

A task may instead carry **no profile at all** — the *basic* shape: `model`
and `thinking` stay board-native fields and no Connector is involved.

## Authority

Setting or changing a profile that targets a service requires
**`services:invoke`** (or `root`) on top of the route's ordinary
`tasks:write` — filling arguments is choosing what executes, so bare
task-write is never enough. Clearing a profile (`executionProfile: null`)
and basic tasks need only `tasks:write`.

## The retired legacy shape

The pre-connector shape (`mode`, `harness`, `accessProfile`,
`requiredCapabilities`, `allowOverrideAtSpawn`, `planningMode`) retired with
the ratified vocabulary (D-15). The write path refuses it by name
(`FIELD_RETIRED`), and `executionMode` is likewise refused on writes.

**Stored legacy values are held, never dropped.** Reads surface them as a
separate `legacyExecutionProfile` field; the GUI shows a read-only
"Legacy profile (compatibility)" row; an ordinary save never rewrites the
held bytes. The orchestration-lease harness binding keeps reading the held
legacy value until the connector pickup protocol replaces that contract in
a later phase.

## Surfaces

- **REST** — `executionProfile` on `POST /tasks` and `PATCH /tasks/{id}`.
- **GUI** — the AI Execution section is service-first: pick
  "Basic (no Connector)" or a published Connector; every remaining field is
  discovered from the pinned descriptor and rendered by type (enum,
  boolean, number, string, secret reference name, resource selector).
- **CLI** — `relayhall create`/`update` take `--service`,
  `--descriptor-version`, repeatable `--option` and `--parameter`, and
  `update` takes `--clear-profile`. Values are explicit about type:
  `key=value` sends the **exact string** (so a Connector-declared string
  such as `"true"` or `"001"` survives verbatim), and `key:=json` sends a
  typed JSON literal (`enabled:=true`, `rate:=1.5`).
- **MCP** — `relayhall_task_create` accepts the same `executionProfile`
  object; the REST layer enforces the invoke requirement on the caller's
  own credential.
- **Brief** — a connector profile renders as a delimited, quoted JSON block
  labelled as connector-declared data — never in instruction position.
