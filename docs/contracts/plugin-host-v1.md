# Plugin host contract v1 (P02)

Core baseline: release 1.0.0-beta.56 (first written for the four-plugin migration). Product contracts are deployment-neutral.

## Installation and trust
Each plugin is a separate repository/service. Add manifest schema_version: "rh.plugin/1", relayhall: {api_version: 1, trust: "installed", capabilities: ["telemetry.sessions", "usage.quotas"]}. Existing legacy manifests remain compatible but do not get v1 bridge/assertions. Installed same-origin UI is fully trusted code with board-origin authority; this is NOT hostile-code sandboxing. Only install reviewed code.

Private plugin config adds access: {default: ["view"], accounts: {"<Account UUID>": ["view", "generate"]}, assertion_key_env: "<environment variable name>"}. default is optional and is absent, [] or exactly ["view"]; any other value refuses the installation at load. With ["view"] every active Account holds view (listing, view settings entries, the bridge, and GET/HEAD through view rules); it never satisfies a non-view capability, a non-view settings entry or any proxied write, and never sets hostProxyAccess.writeCapable: those need the explicit per-Account entry. Without a default, no accounts entry means no v1 access (root is also narrowed to its own Account here). Each api.allow rule may name capability; default is view. Writes must declare a non-view capability. The upstream verifies the HMAC-SHA256 assertion using its private per-plugin key, with issuer "relayhall", audience manifest.name, and expiration. Header X-RelayHall-Assertion is synthesized by core (client header is dropped); claims sub=Account UUID, actor=acting principal UUID, capability=selected rule capability. Token expires after 60 seconds. Upstream MUST scope stored data by sub and check capability. No board credential goes upstream. Serve the plugin only on the private installation network or enforce this assertion on its external ingress.

V1 iframe/API access requires an active RelayHall login session or Bearer credential. Legacy browser-access cookies alone cannot access v1 data. No owner identity can be supplied by a request body. Account grant removal applies on the next request. Plugin removal/disable removes routes and navigation, retaining data.

## UI and bridge
Plugin ui.sidebar_widget optionally carries {path:"/avatar",height:160,grow:false,frame:"section"}; bounded height 48..240. grow is an opt-in boolean (absent = false; any other value refuses the installation with PLUGIN_SIDEBAR_WIDGET_INVALID), and the registry carries grow:true to the dashboard only when the manifest declares exactly true. frame is an opt-in with exactly one accepted value, "section" (absent = the boxed block; any other value, of any type, refuses the installation with PLUGIN_SIDEBAR_WIDGET_INVALID), and the registry carries frame:"section" to the dashboard only when the manifest declares exactly that string. A widget with frame:"section" is drawn as a sidebar section: a folding heading styled as the navigation group headings and the frame directly under it at the full sidebar width, with no border, background, radius or inner padding. The frame element is transparent and the body the heading controls paints no background, so the sidebar's own background shows through; the host keeps the frame element's colour scheme equal to the one its document declares (read on load and after each resize report), because a browser paints an opaque backdrop behind a frame whose scheme differs from its element's, and the body takes the navigation's own side inset so the heading text, the rows and the menu share one left edge. Folding, its remembered state, the declared height bound and the frame's sandbox are unchanged, and the identity widget and every widget without the opt-in render as before. Capability-based widgets replace hardcoded plugin identity. UI routes continue using /plugins/<manifest name>. Core supplies GET /plugin-host/<name>/bridge under services:read and the installation's per-Account view grant. It returns {schemaVersion:"rh.plugin.bridge/1", observedAt, sessions?, quotas?}; fields are included only for declared capabilities. sessions uses current caller-scoped /telemetry/sessions projection and freshness; no sessions:snapshot, no root/global totals. Missing queue and throughput remain unknown; no new feed emission.

Iframe sends {type:"relayhall-plugin-ready",version:1}. Host sends {type:"relayhall-plugin-data",version:1,plugin:<name>,payload:<bridge>}. Both sides validate source window and same origin. Data is polled only while mounted; listeners/timers/fetches stop on unmount. Resize {type:"iframeResize",height:<finite number>} is accepted only from the actual iframe at same origin.

Frame sizing. Full-page frames (a plugin UI route, and the frame on the Settings hub) fill the space the host lays out for them; a received iframeResize height does not size them. The received height is honoured by the sidebar widget only: it is rounded up and clamped between 48 and the widget's declared ui.sidebar_widget.height, and the widget returns to its declared height when its document reloads. A sidebar widget that declares grow:true is instead clamped between 48 and the host ceiling of 1600 px: it starts at, and on reload returns to, its declared height, then takes the content height its own frame reports, so content within the ceiling needs no scroll bar inside the frame and the sidebar column scrolls as a whole. A report above the ceiling is clamped, never trusted; the same-origin and source-window checks apply unchanged. The opt-in never changes the declared height bound, and a widget without it is sized exactly as before. A full-page plugin UI must therefore scroll within its own document rather than rely on the host growing the frame.

## Quota telemetry
POST /telemetry/quotas requires telemetry:write and the existing Connector-derived telemetry identity/policy, with declared sourceProduct. Closed JSON snapshot:
{
 "schemaVersion":"rh.usage-quota/1",
 "sourceProduct":"openai-codex",
 "provider":"openai",
 "providerAccountId":"stable-safe-opaque-id",
 "label":"Personal",
 "observedAt":"2026-09-10T19:00:00Z",
 "status":"reported",
 "windows":[{"id":"weekly","label":"Weekly","unit":"percent","used":35,"limit":100,"resetsAt":"2026-09-17T19:00:00Z"}]
}
provider is a stable lowercase slug (e.g. openai, github-copilot, claude-code); providerAccountId is a stable nonsecret opaque identifier, never credential/email. status: reported | not-reported | unsupported | removed. Unknown states have empty windows. Window unit: percent | requests | tokens | credits; used and limit finite nonnegative, limit > 0; optional resetsAt timestamp. At most 16 windows, no duplicates. For reported status, observedAt is the successful quota measurement (not latest attempted refresh). For not-reported or unsupported, it is the account discovery/support-status observation and carries no quota measurement; windows must be empty. A discovered Account without a successful provider read must still emit this status receipt. Max body 16 KiB. No collection resets, purchases or account switching.

Server derives Account and Connector exclusively from authenticated chain; reporter body cannot name owner. Latest snapshot key is Account+Connector+provider+providerAccountId. Older timestamps do not overwrite; same timestamp exact replay idempotent, conflicting content rejected. GET /telemetry/quotas requires services:read and ALWAYS current caller Account (even root), returns {schemaVersion:"rh.usage-quota/1",accounts:[...],truncated:boolean}. Each row includes safe source identity, snapshot and stale derived from observedAt age (>15 minutes), never fake 0%. Maximum 200 rows, latest first. Removed snapshots are retained as tombstones and excluded from normal display. Unknown/unreported must not become zero. Providers without reporters are explicitly unsupported/not-reported when discovered by an authorized collector.

## Acceptance
Tests must prove incompatible manifest and duplicate routes fail, v1 unknown/revoked caller fails, account scopes cannot widen, assertion audience/capability binding, out-of-order/conflicting quota snapshots, invalid units/times/windows, cross-account reads, and message source/origin checks. Full-tier CI on exact final SHA precedes TST deployment. Production, public publication, provider writes and destructive cleanup are outside this delivery.

### Clarifications after integration review
Proxy view methods require services:read and writes require services:write, in addition to installation per-Account domain capabilities. Root never widens the data Account.
Quota snapshots optionally include checkedAt (latest attempted refresh) and errorCode (unavailable | auth-required | rate-limited | timeout | untrusted-binary). untrusted-binary means the connector's harness binary failed publisher trust, so no read ran; show it as an untrusted binary, not as stale. A failed refresh may repeat retained values/observedAt with later checkedAt and errorCode: the server updates attempt metadata only if all observation fields are unchanged. Staleness always uses observedAt. Successful collectors default checkedAt to observedAt. Fresh input may be at most 60 seconds ahead of server time.
Account keys remain Connector-qualified deliberately: two reporters are independent evidence, not automatically merged. UI must display source identity and avoid summing quota percentages; matching providerAccountId may be grouped with newest observation preferred and conflicts visible. Current source ancestry and every ancestor active status are checked on reads; moved/disabled connectors' prior-owner snapshots are withheld as historical data.
Metrics extension rh.plugin.metrics/1 has queue and throughput fields; each is null when unavailable or {value,unit,observedAt,windowSeconds,source}. Queue units jobs, throughput units jobs/minute; metrics need a caller-authorized service reporter. Initial core bridge supplies null and never derives throughput from session count or event/token totals. The sessions array is capped at 200, so it cannot establish an estate-wide exact total.

### Governed metric producer (implemented seam)
POST /telemetry/service-metrics requires telemetry:write, Connector-derived identity and its declared sourceProduct, then stores rh.plugin.metrics/1:
{schemaVersion:"rh.plugin.metrics/1",sourceProduct:"gpu-gateway",observedAt:"2026-09-10T19:00:00Z",queue:{value:2,unit:"jobs"},throughput:{value:1.5,unit:"jobs/minute",windowSeconds:60}}.
queue and throughput may independently be null. The server rejects negative/nonfinite values, fractional queue depth, unsupported units, invalid calendar timestamps/absent timezone/future time, extra owner fields, and windows outside 1..86400 seconds. Equal timestamps are exact duplicate or 409 conflict; older observations are ignored explicitly. Reads check current active Account ancestry, bound 200 sources, and stamp each metric with server-derived {connectorId,sourceProduct}, observedAt, stale (>90 seconds). No source identity comes from the payload.
Bridge metricsSources is {truncated,sources:[...]}; direct metrics is populated only with exactly one source and no truncation, otherwise null fields. Private metrics_source_product may narrow the source product. Publishers report current measurements; having the route alone is not live blend acceptance.

### Board metrics (rh.plugin.board-metrics/1, additive)

For a `telemetry.sessions` plugin the bridge also carries `boardMetrics`: the core's own count of the CALLER's Account's board work, computed from the board's rows on every bridge read. It is an additive field with its own version; `metrics`, `metricsSources` and every other bridge field keep their meaning, and `rh.plugin.bridge/1` is unchanged. A plugin that ignores unknown fields sees no difference.

```json
{"schemaVersion":"rh.plugin.board-metrics/1","observedAt":"2026-10-19T03:00:00.000Z","stale":false,"freshnessSeconds":90,
 "source":{"kind":"core","producer":"board"},
 "queue":{"status":"reported","value":2,"unit":"jobs","observedAt":"2026-10-19T03:00:00.000Z","stale":false,"source":{"kind":"core","producer":"board"}},
 "throughput":{"status":"reported","value":0.05,"unit":"jobs/minute","windowSeconds":3600,"count":3,"observedAt":"2026-10-19T03:00:00.000Z","stale":false,"source":{"kind":"core","producer":"board"}}}
```

Definitions. The Account is the caller's own (the same Account the bridge already resolves; root is narrowed to its own Account), never a global count and never another Account. A Task belongs to the Account when its effective Account owner, `COALESCE(tasks.account_owner_principal_id, projects.owner_principal_id)`, is that Account; a Group-owned Task belongs to no person's Account and is not counted.

- `queue` (unit `jobs`): Tasks waiting for the Account = its Tasks in status `todo` that are armed (`auto_start`). An unarmed `todo` Task is parked (the claim path refuses it) and is not waiting; `ideas`, `in-progress`, `review`, `stuck`, `completed` and `archived` are not waiting. Dependencies are not consulted: an armed Task behind an unfinished dependency is still in the queue.
- `throughput` (unit `jobs/minute`, `windowSeconds` 3600): handbacks per hour = the `handover.finish` Task stream entries (written by `POST /tasks/{id}/finish` in the transaction that moves the Task into Review) on the Account's Tasks in the rolling hour before the read. `count` is the integer number of handbacks in the rolling hour, the figure to show as "handbacks per hour"; `value` is `count / 60`, in jobs/minute, only for parity with the `rh.plugin.metrics/1` throughput unit (3 handbacks in the hour is `count` 3 and `value` 0.05). The system `task.transitioned` twin of a handback is not counted again.

Freshness. Each reported metric carries `observedAt` (the database transaction time of its count) and `stale` (older than 90 seconds, the rule shared with `rh.plugin.metrics/1`); the top-level `observedAt` is the earliest of them and `stale` is true when nothing was measured. Counts are computed per bridge read; a plugin holding an older payload judges it with `freshnessSeconds`.

Unknown is never 0. A metric that cannot be computed is `{"status":"unknown","value":null,...,"reason":...}` and has no `observedAt` or `count`: `reason` is `unavailable` when its statement fails or overruns its 2-second budget (the rest of the bridge still answers), or `caller-reach` when the caller's authority does not reach its whole Account (effective scopes without `tasks:read`, although the bridge route itself needs only `services:read`; a Connector or Agent with an explicit object selector; an Agent bound to a Task; or a delegated link without an expression). A reported `value` of 0 is a measured zero.

### Authorized task correlation
Optional client X-RelayHall-Task-Id is consumed by core and never forwarded directly. Core requires tasks:read plus tasks:write and the existing task read and write authorization decision for the authenticated actor, then adds taskId to the signed per-plugin assertion. Gateway must ignore arbitrary body taskId and associate only signed taskId. Gateway result publication uses its separately authorized reporting Connector through existing TaskElement/ReportManager flows, never task field-history writes or a forwarded board bearer token.

### Known-account discovery
A collector emits one not-reported (or unsupported) receipt for every discovered owned provider account even if its first collection fails. observedAt records when that status/discovery was observed; checkedAt records the attempt. A renderer must gate quota bars on status=reported AND a valid window; status timestamps never imply a fresh quota. snapshot:null is absence of a receipt, not a representation of a known unsupported account.


## P03 routing and authorization clarification

The approved P02 Account-scoped registry discovery GET /plugins uses services:read
and filters entries by installed Account grants. It is no longer an ungoverned
root-fallthrough family. GET /plugins/:name remains root-only legacy detail
administration. The /plugin-host protected mount belongs to the same middleware
census as the registry; its bridge still performs capability and Account checks.

The host compiles the public namespace once: only a leading claw- compatibility
prefix is removed. Enabled installation names that compile to the same namespace
are rejected before registration or health checks. Registry consumers use api_base.
Health paths are bounded absolute paths within the configured plugin origin;
authority forms, traversal, queries and fragments are rejected, and health requests
do not follow redirects.

Custom UI routes take precedence over their containing API route. The unmatched
suffix is appended under proxy_to (including its path), and the allowlist plus
assertion capability are selected against that final upstream pathname. Thus a
public alias cannot turn a restricted upstream path into a view-only operation.


## Settings navigation registration

Installed `rh.plugin/1` plugins may declare `ui.settings` (at most 20 entries):

```json
{"id":"reading-options","label":"Reading preferences","scope":"personal","path":"/settings","capability":"view"}
```

`scope` is exactly `personal` (this Account) or `deployment` (shared configuration).
IDs use the existing plugin-name syntax and are unique within the plugin. Labels
are non-empty, at most 80 characters, without control characters. Paths use the
existing safe plugin path syntax and must not overlap any UI route alias (including
its descendants): settings address direct internal endpoints, never rewrites.
Every entry must match a GET proxy allow rule
whose capability equals the declared capability; deployment scope cannot use
`view`. Installation metadata never creates a grant. The registry returns only
entries the requesting Account has the corresponding explicit existing plugin
capability for, or, for a `view` entry only, the deployment view default; the
proxy independently enforces that capability on access.
Write endpoints still require their own protected allow rules. The host stores
the settings a plugin declares in `ui.settings_schema` (see "Plugin
availability and host-stored settings" below): it validates, renders and
resolves them per Account, delivers them in the bridge as `settings` and to the
plugin backend through the assertion-confined effective read, and refuses
credential-shaped values. It is not a credential store: a `secret` setting only
describes a value the plugin keeps in its own installer configuration, and the
host adds no credential endpoint. A plugin that keeps its own settings pages
remains responsible for the storage and authorization behind them.

The Settings hub at `/settings/plugins` groups authorized registered entries by
scope. Plugins without a registered settings UI are explicitly unavailable there,
not redirected to an unrelated operational page. Plugin authors must implement
the destination before advertising it. `?plugin=<name>&setting=<id>` is a link,
never authority; unregistered/revoked entries cannot mount a frame.

For a visible `rh.plugin/1` entry, `GET /api/plugins` adds
`hostProxyAccess: { "writeCapable": boolean }` for the current authenticated
request. `true` means the caller has `services:write` or `root` scope **and**
the active Account has an explicit grant for at least one effective declared
POST, PUT, PATCH, or DELETE proxy allow rule. Overlapping rules use the proxy's
longest-path and exact-match precedence. A settings entry's path, scope, or
capability name alone does not determine this plugin-level value. `root` does
not create an Account grant. The host computes the field per request from its
compiled proxy rules; plugin-authored registry or manifest values cannot set it.
The proxy independently checks the current scope, active Account, selected
rule, and grant on every request. The field describes RelayHall connection
access, not what an installed same-origin UI can do within its page or which
specific setting can be edited. Personal versus deployment scope is displayed
separately.

Each listed settings entry also carries `readOnly: boolean` for the current
authenticated request. `readOnly` is `false` only when the caller has
`services:write` or `root` scope **and** a POST, PUT, PATCH or DELETE request
to the entry's own `path` would select (with the proxy's longest-path and
exact-match precedence) an allow rule whose non-view capability the active
Account holds in its explicit per-Account entry. A write rule that reaches only
a descendant or a sibling of the entry path does not count, the deployment view
default never counts, and an entry of a plugin with no compiled base proxy
route is `readOnly: true`. The entry's own capability does not decide it: a
`view` entry can be writable through a `manage` POST rule on its path, and a
GET-only entry under a non-view capability is read-only even while
`hostProxyAccess.writeCapable` is `true` for another endpoint. The host
computes the flag per request from its compiled proxy rules and replaces any
`readOnly` a manifest supplies. The Settings hub states for each entry whether
this Account can change it; a page whose entry is read-only is shown for
viewing, never advertised as changeable. Like `hostProxyAccess`, the flag is a
description: the proxy checks every request again. Older registry responses
omit it; clients treat absence as unknown.

Older registry responses or an entry with no compiled base proxy route omit
`hostProxyAccess`; clients treat absence as unknown, not read-only. If active
Account resolution returns no Account, the registry conceals `rh.plugin/1`
entries. The existing tolerant Account lookup can return no Account for more
than one cause, so that result does not prove an outage. An actual thrown
lookup error produces a fixed `503` response. Legacy plugin listing behavior
is unchanged.


## Upgrade compatibility

These rules decide whether an installed `rh.plugin/1` plugin loads on a given
host and how its proxied traffic behaves across upgrades. Legacy manifests
(no `schema_version`) keep their existing compatibility path.

**Declared minimum host version.** `relayhall.min_version` is optional. When
present it must be a strict SemVer 2.0.0 string (no `v` prefix, no surrounding
space, at most 160 characters). The host compares it with its release
identity, `RELAYHALL_VERSION`: the version the backend reports at `GET /api/`,
in OpenAPI `info.version` and in MCP `serverInfo.version`. That is the version
the image was built as, or the package base marked `+unreleased` for a build
without release tooling; it is never the bare `backend/package.json` version.
SemVer precedence applies: a prerelease sorts below its stable release
(`1.0.0-beta.56` does not satisfy `1.0.0`), numeric identifiers compare as
numbers (`1.0.0-beta.9` is below `1.0.0-beta.56`) and build metadata never
changes the order. `relayhall.api_version` remains the host API contract; a
plugin never infers compatibility from a phase name or a commit identifier.

**Refusal semantics.** A malformed minimum, a host that reports no valid
version, or a host below the minimum refuses that installation at load, with
the other contract checks: nothing is registered, no proxy route or navigation
is compiled and no health request is made. Other installations still load. The
refusal is re-evaluated when the backend restarts; nothing is rewritten.

**Refusal reason in the log.** Each contract refusal carries a fixed reason
code, and the backend log line for a refused installation names it (an
installation whose own name is invalid, `PLUGIN_NAME_INVALID` or
`PLUGIN_NAMESPACE_EMPTY`, is refused on its own line too, and the other
installations still load):
`[PluginLoader] plugin load failed reason=<code> (Error) [class=PluginContractError code=ERROR_UNCLASSIFIED id=<failure id>]`.
The codes include `PLUGIN_MIN_VERSION_MALFORMED`, `PLUGIN_MIN_VERSION_UNSATISFIED`,
`PLUGIN_HOST_VERSION_UNAVAILABLE`, `PLUGIN_ALLOW_PATH_NOT_CANONICAL` and
`PLUGIN_ALLOW_RULE_MALFORMED`; the closed set is `PLUGIN_CONTRACT_REFUSALS` in
`backend/src/services/PluginHostContract.ts`. A load failure that is not a
contract refusal (for example an unreadable `plugin.json`) logs
`reason=PLUGIN_LOAD_UNCLASSIFIED`. The line never carries the refusal text or a
manifest value. The same failure id appears in the installation's
`Plugin load failed (errorId <failure id>)` error.

**Canonical allow paths.** `api.allow` paths use canonical slash boundaries:
`/` is allowed, any other path must not end in `/`. A protected prefix such as
`/private` covers `/private` and `/private/child` and excludes
`/private-sibling`. A rule spelled `/private/` would miss its own descendants
and let a broader rule select them, so the loader refuses it before health
checks or registration instead of changing its meaning.

**Conditional ranges.** The host proxy forwards `If-Range` together with
`Range`, so a client holding a stale validator receives the complete
representation (upstream `200`) and a matching validator a partial one (`206`).
The upstream status and its `Content-Range`, `Content-Length`, `Accept-Ranges`
and `ETag` headers are relayed unchanged.

**Stream abort.** Response bodies are streamed; an event stream reaches the
client chunk by chunk. If the upstream response aborts or fails after its
headers, the host destroys the downstream response: the client sees an
incomplete transfer, never a clean end. When the client goes away the host
destroys the upstream request. An upstream request error or a 30-second idle
timeout after the headers ends the downstream the same way. An upstream failure
before headers keeps the generic `502` unavailable response.


## Plugin availability and host-stored settings

Stage 1 of the plugin availability and settings design.
It applies to installed `rh.plugin/1` plugins only; legacy manifests are
outside it and keep their behaviour.

### Availability

Administrators set one state per installed plugin, stored in the database and
changed in the dashboard (no restart, no root act):

| State | Shown to an Account the installation file allows | The Account's own switch |
|---|---|---|
| `required` | always | none (`409 CHOICE_NOT_ALLOWED`) |
| `default_on` (no row) | unless the Account turned it off | off and on |
| `available` | only if the Account turned it on | on and off |
| `disabled` | never | none |

Availability only narrows. A plugin is visible to an Account only when the
installation file already lets it view the plugin AND the state, with the
Account's own choice, resolves to on. It is ANDed with each site's existing
check and never replaces one: the bridge, the registry list and its settings
entries, `GET /plugins/:name` (which uses the active Account), and the proxy
for reads and writes, after the capability check. An explicit non-view grant
such as `generate` therefore never bypasses a hidden plugin. A hidden plugin
answers each site's existing 404; on the host routes that is the byte-identical
`404 {"code":"PLUGIN_NOT_FOUND"}`.

The Account's own choice is kept while the state is `required` or
`disabled` and applies again when the state returns. An administrator may
clear every choice of a plugin with a state change (`clearChoices: true`).
Rows of a plugin removed from the installation file are kept.

Availability is read from the database, in one store round trip per request
at each site (the registry list reads every listed plugin's state in that one
statement). A store outage therefore answers `503` for v1 plugins rather than
serving them unchecked: `PLUGIN_UNAVAILABLE` on the registry, `GET /plugins/:name`
and the proxy, `PLUGIN_BRIDGE_UNAVAILABLE` on the bridge. Legacy plugins are
outside policy and never wait on it, though a registry list that holds a v1
entry answers `503` as a whole.

### `ui.settings_schema`

A v1 manifest may declare `ui.settings_schema`, at most 64 settings. It is
optional: a plugin without it has no host settings and loads as before. Each
setting is an object with exactly these fields:

| Field | Rule |
|---|---|
| `key` | unique, plugin-name syntax (`^[a-z][a-z0-9-]{1,63}$`) |
| `label` / `help` | text, at most 80 / 400 characters, no control characters |
| `type` | `boolean`, `string`, `text`, `integer`, `number`, `enum`, `multi_enum` or `secret` (closed set) |
| `options` | `enum` and `multi_enum` only: 1 to 64 `{value, label}`, unique values |
| `min`, `max` | `integer` and `number` only; `max_length` (1 to 4096) for `string` and `text` only |
| `default` | optional; must fit the type and bounds and must not look like a credential |
| `scope` | `deployment` (administrators), `account` (each person) or `account_overridable` (administrators set it; a person may override it unless locked) |
| `deliver` | `frame_and_backend` (default) or `backend` (never sent to the browser) |

A `secret` setting has scope `deployment` and no default: it describes a
value the plugin's installer configures in the plugin's own environment, and
the host never stores or accepts a value for it. Any other schema refuses the
installation at load with `reason=PLUGIN_SETTINGS_SCHEMA_INVALID`.

### Values and resolution

Each layer's values document is at most 16 KiB, nests at most 8 levels and
holds strings of at most 4 KiB; a larger one is refused, never truncated.
Unknown keys, keys of the wrong scope for the writer, `secret` keys, values
outside their type or bounds and values shaped like a credential are refused
at write. Key names are not word-matched: a `token-sort` setting is accepted.

The effective value for an Account and a key is the first of: the Account's own
value (an `account` key, or an `account_overridable` key that is not locked);
the administrators' deployment value; the schema default. A locked key ignores
the Account's value but keeps it, so unlocking restores it. A stored value the
current schema no longer accepts is ignored and reported as stale; it is
removed only by its owner's next write or by an administrator's clean-up.

### Routes

| Route | Who |
|---|---|
| `GET /plugin-host/choices` | `services:read`: the Account's eligible plugins (file view, v1, not `disabled`), each `{name, label, state, enabled, userControlled, revision}`. A switched-off `default_on` or `available` plugin is listed here and found on the choice route, and nowhere else. |
| `PUT /plugin-host/:name/choice` | the Account's own login session, `{enabled}` |
| `GET /plugin-host/:name/settings` | `services:read`: the schema, effective values, per-key sources and the Account's revision; `deliver: backend` values are omitted |
| `PUT /plugin-host/:name/settings/account` | the Account's own login session, `{values}` |
| `GET /plugin-admin`, `GET /plugin-admin/:name/policy`, `GET /plugin-admin/:name/settings` | an `admin` or `operator` login session |
| `PUT /plugin-admin/:name/policy` | the same, `{availability, clearChoices?, stepUpToken}` |
| `PUT /plugin-admin/:name/settings` | the same, `{values, lockedKeys?, stepUpToken}` |
| `POST /plugin-admin/:name/settings/cleanup` | the same, `{stepUpToken}` |
| `GET /plugin-host/:name/settings/effective` | the plugin backend, with its assertion (below) |

The Account is always derived from the request (the active Account, as for the
bridge); no route names one. The Account's own writes need its own login
session with no delegation link (anything else is `403 SESSION_ONLY`); every
caller of the Account with `services:read` may read. The administrator
routes refuse every bearer credential, a root bearer included
(`PLUGIN_ADMIN_REQUIRES_SESSION`), and every session that is not an `admin` or
`operator` Account's (`PLUGIN_ADMIN_REQUIRES_ADMINISTRATOR`); each write also
burns a single-use step-up bound to (`plugin.admin`, the plugin name),
`403 STEP_UP_REQUIRED` otherwise. Every PUT requires `If-Match` with the
revision last read (an absent row is revision `0`): absent is
`400 REVISION_REQUIRED`, stale is `412 REVISION_MISMATCH`. Every write honours
`Idempotency-Key` (operations `plugin.settings.account.put`,
`plugin.choice.put`, `plugin.policy.put`, `plugin.settings.deployment.put`,
`plugin.settings.cleanup`, each credential-scoped with its receipt replayed).
A reset is a PUT with an empty object.

`PUT /plugin-host/:name/settings/account` replaces the Account's own values
with one exception. The Account's own read never shows the value of a
`deliver: backend` key, so a form built from that read cannot send it back: a
stored Account value of such a key that the request does not name is kept
(while the current schema still accepts it), an empty object included. A
request that names the key replaces its value, validated like every value, and
naming any of the Account's own keys with `null` removes the Account's value
for it (`null` passes the key checks, unknown, wrong-scope, `secret` and locked
keys are still refused, and nothing is stored for it). Locked keys keep their
stored values in the same way. Every change is audited with the actor,
the Account, the plugin, the changed keys and the new revision, never a value.
These routes are not exposed over MCP.

### Delivery

The bridge carries two ungated members: `availability` `{state, enabled}` and
`settings` `{values, sources}`, where `sources` says per key whether the value
came from the Account, the administrators (and whether it is locked) or the
default. `deliver: backend` keys and `secret` settings are left out. There is
no change notification: frames re-read through the bridge poll.

Every assertion the core signs carries a random `jti`, recorded with the
plugin, the Account and the capability until it expires (in the serving
process's memory). A plugin backend reads one Account's effective settings,
`deliver: backend` keys included, with `GET /plugin-host/<name>/settings/effective`
and the assertion it received in `X-RelayHall-Assertion`; `Authorization` is
never read and the assertion authenticates no other route. The core verifies
HS256 only, issuer `relayhall`, audience = the plugin, expiry, the plugin's own
key, and a `jti` it issued for that plugin, that Account and that capability;
it then re-reads that the Account is an active Account and that the plugin is
still available to it under the proxy's composition (the assertion's capability
still held, ANDed with availability). Every failed check answers
`404 {"code":"PLUGIN_NOT_FOUND"}`; an internal failure after the checks answers
`503 PLUGIN_SETTINGS_UNAVAILABLE` with an `errorId`. Reuse within the assertion's 60 seconds by
the same plugin is accepted. Two installations whose `assertion_key_env` name
the same variable, or variables holding the same key, are both refused at load
(`reason=PLUGIN_ASSERTION_KEY_SHARED`); keys and their digests are never logged.
