# Service registry

A **Service** is a registered external system. A **Connector** is a *kind of
Service* — one that pulls and executes work (a Claude Code runner, an n8n
instance, a Semaphore host). A shared browser, an artifact store or a RAG
endpoint are Services that are not Connectors. One registry, one table; the
`kind` field carries the distinction. A **Tool** is one callable operation a
Service exposes — descriptors *declare* Tools today; the Tool surface that
binds to those declarations is not built yet.

RelayHall stays connector-agnostic: a registered Service declares its own
selectable execution options in a **capability descriptor**, and the board
validates shape and renders pickers without ever interpreting the values.
Each connector owns its vocabulary.

## Capability descriptors

A descriptor is a versioned JSON contract:

- **`options`** — a flat list of typed option descriptors. Types:
  `enum | boolean | number | string | secretReference | resourceSelector`.
  Enum options carry `values`; every option may carry `label`, `help`,
  `required` and a type-matching `default`.
- **Per-option `parameters`** — exactly one level of typed parameters under
  an option (for example, the variables of an n8n workflow chosen by the
  `workflow` option). Parameters use the same types and may never nest
  further — a list, not a tree.
- **`secretReference`** entries never carry secret material. They declare
  `allowedReferences`: the *names* of credentials the connector resolves on
  its own side. The board stores and pins names; secret bytes never reach it.
- **`tools`** — declared exposed Tools (name + description). Registry data
  today; the Tool surface that binds to it is not built yet.
- **`discovery.optionsEndpoint`** and **`health.endpoint`** — declared seats
  for option discovery and health probing. Nothing calls these URLs yet: at
  v1 the descriptor version itself is the option source (a connector
  republishes to change its options), so live remote discovery stays a
  declared seam.

**Descriptor versions are immutable.** Publishing writes a new version and
bumps the head pointer; nothing edits a published version. Publishing
byte-identical content is refused (`409 DESCRIPTOR_UNCHANGED`) rather than
silently bumping the version. A task's execution profile pins the descriptor
version it was validated against; retiring a version stops new consumers
while existing pins keep resolving, and dispatch against a retired pin fails
closed at the execution-profile paths.

## Lifecycle and authority

Services use the `draft · published · retired` subset of the registry
lifecycle vocabulary. A service starts `draft`, may move to `published` once
it has a descriptor version, and retires irreversibly.

| Operation | Requires |
|---|---|
| List / read services and descriptors | `services:read` |
| Register, update metadata, publish a descriptor version | `services:write` |
| Retire a service or a descriptor version, hard delete | `services:admin` |
| Delivery configuration, visibility tier, runtime mode | owner plane (`root`) |

The last row is deliberate: the delivery endpoint — and the delivery-mode
switch itself — is **subscription-class** configuration. It is settable only
through the owner plane, never with agent-plane `services:write`, so a
prompt-injected connector can never repoint its own delivery to an attacker
URL. The same applies to the visibility tier (how much of the board a
service sees; new registrations default to `assigned-only`) and the runtime
mode (`direct` today; `brokered` is a post-v1 capability and registration
refuses it with `BROKERED_MODE_NOT_AVAILABLE`).

Registration is deliberately cheap; trust is expressed in grants. Every
mutation records the acting principal, and descriptor history is append-only
— these records join the board-wide audit log when the Phase-2 audit scope
lands.

## Manage services

```bash
relayhall service list
relayhall service list --kind connector --status published
relayhall service get <service>
relayhall service register <slug> --name <name>
relayhall service register <slug> --name <name> --kind connector --dry-run
relayhall service update <service> --name <name> --revision <revision>
relayhall service publish-descriptor <service> --file <file> --revision <revision>
relayhall service descriptor <service>
relayhall service descriptor <service> --version <version>
relayhall service versions <service>
relayhall service retire <service> --revision <revision>
relayhall service retire-descriptor-version <service> <version>
relayhall service delete <service>
relayhall services
```

Every mutating verb accepts `--dry-run`: the full validation path runs —
slug uniqueness, revision binding, descriptor validation — inside a
transaction that rolls back, and the response says `DRY RUN` so a rehearsal
is never mistaken for the real thing.

REST:

- `GET /services` (+`?kind=`, `?status=`, `?includeRetired=true`) · `POST /services`
- `GET /services/{id}` · `PATCH /services/{id}` · `DELETE /services/{id}` — `{id}` is a UUID or slug
- `GET /services/{id}/descriptor` — the current version
- `PUT /services/{id}/descriptor` — publish a new immutable version (`If-Match`)
- `GET /services/{id}/descriptor/versions` (+`/{version}`)
- `POST /services/{id}/retire` · `POST /services/{id}/descriptor/versions/{version}/retire`
- `PATCH /services/{id}/owner-plane` — subscription-class fields, `root` only
- Mutating routes accept `?dryRun=true`

MCP exposes a read-only pair — `relayhall_service_list` and
`relayhall_service_get`; registry mutation stays on CLI/REST behind
`services:write` and `services:admin`.

## Registering a connector: the contract

What an external system's author does, end to end:

1. **Register**: `relayhall service register my-runner --name "My Runner"
   --kind connector` (needs `services:write`). The registration starts
   `draft`, `direct` mode, `assigned-only` visibility, no delivery.
2. **Publish a descriptor**: declare the options your runner actually
   honours — models, effort levels, workflows, templates — plus per-option
   parameters where choosing an option requires arguments. If an option
   needs a secret, declare a `secretReference` with the *names* your runner
   resolves locally; never put secret material in a descriptor.
3. **Publish the service**: `relayhall service update my-runner --status
   published --revision <revision>`.
4. **Ask the deployment's human authority** to set delivery (webhook or
   poll) and, where appropriate, a wider visibility tier — these are
   owner-plane by design and no agent credential can set them.
5. **Evolve by version**: changing options or parameter schemas is a new
   descriptor version. Old pins keep resolving until versions are retired;
   retirement is the admin verb and existing work fails closed rather than
   silently running against a changed contract.

What the board will do with each field today, honestly: options and
parameters drive the dynamic execution-profile form and are validated at
profile-set against the pinned version (see
[execution-profiles.md](execution-profiles.md)); declared Tools are stored but
not yet listed on a Tool surface; `discovery`/`health` are stored, not yet
called;
delivery configuration is stored, dispatched by the Phase-3 delivery worker;
the telemetry tier is stored, consumed by the Phase-3 ingest; the visibility
tier is stored, enforced by the Phase-2 shared authorization predicate.
Descriptor text shown to agents renders as delimited, provenance-labelled
data — never in instruction position.
