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

- `GET /services` (+`?kind=`, `?status=`, `?includeRetired=true`) · `POST /services` (a connector registration may carry its first `descriptor`; see below)
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

**Registering and publishing in one call.** `POST /services` with
`kind: "connector"` also accepts `descriptor`: the connector's first
descriptor. The board validates it and publishes it as version 1 in the same
transaction as the registration, and the service ends `published`. If any
step fails, nothing is written. `telemetryTier` defaults to the tier the
descriptor declares (an explicit value wins). A descriptor on a non-connector
registration is refused (`INVALID_SERVICE_VALUE`), and `?dryRun=true`
rehearses the whole act. The dashboard's Connect your agent wizard uses this
for the four harness templates (see
[connector-onboarding.md](connector-onboarding.md#one-connector-per-harness)),
because a connector the wake and the telemetry can use must be published and
must declare its tier and product; those steps are no longer separate calls
that could stop half-way. The second and third steps above remain the way to
evolve a descriptor after registration.

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

## Registering a knowledge source from an installer bundle

A knowledge source installed with its own installer joins the board in two
steps, with no new credential type. Registration is a human act on the
**Services** page (Settings → Services): root or an administrator, signed in
to the dashboard. Bearer credentials, root bearers included, are refused, and
no MCP tool offers it.

1. **The installer prints a registration bundle**
   (`rh.knowledge-source.registration/1`): `name`, optional `slug` and
   `description`, `endpoint` (the search URL), optional `getEndpoint` and
   `writeEndpoint`, a `descriptor` whose `knowledgeSource` block is
   `protocol_version: 2`, and `certificateSha256`, the sha256 fingerprint of
   the endpoint's TLS certificate.
2. **An administrator uploads it** on the Services page, compares the
   fingerprint the page shows with the one the installer printed on its
   console, ticks that they match, and confirms it is them (a single-use
   step-up bound to `knowledge.source.register` and the fingerprint). If the
   endpoint's address is private, the administrator also gives its allowed
   networks (CIDRs). In one transaction the board creates and publishes the
   Service with the bundle's descriptor, records the endpoints, the allowed
   networks and the channel credential reference name
   `knowledge-source/<slug>`, records the fingerprint as confirmed, and writes
   one audit row (`knowledge.source.register`) carrying the fingerprint and
   how it was confirmed. A duplicate endpoint, fingerprint or slug, an invalid
   bundle and an unconfirmed fingerprint are each refused by name, and a
   refused registration leaves nothing behind.

   The reference name must be **free**, because a new source cannot have had
   step 4 yet: a bearer already placed under the name would reach the new
   endpoint at once. The act refuses `REGISTRATION_CREDENTIAL_REFERENCE_TAKEN`
   (409, `field: slug`), before the step-up is spent and before anything is
   written, with a `reason`:
   - `resolves`: the exact name already resolves in
     `RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS`;
   - `environment-entry`: an entry of that variable, resolving or not, is the
     same name once case, Unicode compatibility forms, accents, invisible
     characters, whitespace and the separators `.` `_` `:` `-` are folded
     (for example `Knowledge_Source/Team.Notes` and `knowledge-source/team-notes`);
   - `service-reference`: any Service, draft, published or retired, records the
     same folded name as its channel credential reference.

   Choose another slug (the `slug` field of the request), or, if the entry is
   left over from a source that no longer exists, remove it on the core host
   and restart first. A hard-deleted Service leaves no row behind, so its old
   entry is caught only while it is still in the environment.
3. **The page offers the return bundle** (`rh.knowledge-source.return/1`) to
   download or copy for the installer: the Service id (the audience), the
   issuer, the board's assertion public keys and, once the lifecycle exporter
   signs snapshots for this Service, its lifecycle public key. It is public
   material only.
4. **The operator places the channel bearer on the core host.** This is one
   root act and a restart; the value never passes through the browser and is
   never stored on the board:
   - add an entry named `knowledge-source/<slug>` (the name the page shows) to
     the JSON in `RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS`, of the form
     `{"bearer": "<the channel bearer the installer printed>"}`, keeping every
     other entry;
   - restart the core.

   Until then every search of the source answers `unavailable:transport`,
   and the page says so. Once the core finds the reference, the page says
   **Channel credential in place**: the board now tries the source on a
   search. That is not yet a successful connection; the certificate rule below
   still decides it.

The board reaches a knowledge source only through Node's default trust store,
so the certificate at the endpoint must chain to a public certificate
authority for the endpoint's name. The fingerprint is checked by a person at
upload; it is not pinned when the board dials, and no installer certificate
authority is trusted.

People who search the source need `knowledge-contents:read` and a read grant
on its Service. The grant is made on Settings → Access grants (`POST /grants`:
resource type `service`, the Service id, verb `read`). That route's ceiling is
the `root` scope, so root, or an `admin` or `orchestrator` Account signed in to
the dashboard, makes it; an `operator` is refused there (the live suite proves
both an `admin` session's 201 and an `operator` session's 403). The page offers
no change request for this grant: today a `grant.rows` filing for a Service
read grant by an administrator is refused `ALREADY_HELD`, so the page links to
Access grants only.

REST (root or an administrator login session; every bearer is refused
`KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION`). A refused registration is
audited as denied with its code; a refused read (the three `GET` routes) is
not audited, by design, because it changes nothing:

- `GET /knowledge-source-registrations` — every registered source with its state
- `POST /knowledge-source-registrations` — `{bundle, confirmedFingerprint, confirmation, allowedNetworks?, slug?, stepUpToken}`
- `GET /knowledge-source-registrations/{id}` — one source's state and the operator's step, by name
- `GET /knowledge-source-registrations/{id}/return-bundle` — the return bundle;
  it carries Ed25519 (OKP) public keys only and answers 503
  `RETURN_BUNDLE_KEY_UNSUPPORTED` for a key of any other type rather than
  cutting it down
