# Current authority preview

`relayhall access preview --resource-type task --limit 20` and MCP
`relayhall_access_preview` read your own current authority through
`GET /principals/me/effective-access` (authenticated, self-only).

Choose task, phase, project, report, skill, personality or service. Pages contain
1–50 permitted object IDs, sorted by exact UUID. Send `nextCursor` as `after`
(`--after` in CLI) for the same type. This is a current-state keyset cursor,
not a frozen snapshot; authority changes apply immediately. No hidden-object
count, titles, SQL or secret credential material are returned.

`resources[].actions[]` carries `action` and `sources` from the same SQL
predicate arms used by protected objects: task roles, initiators, Agent context,
report evidence, assigned Connector claim, grants/profiles, visibility and
chain sources. The current credential scope ceiling, live chain, own() caps
where applicable and Agent bound-task final write cap remain. Acting role and
context exceptions keep their existing semantics. Roles never inherit from
an ancestor. Stored grants/profiles are bounded inventory, not permission promises.

`envelope` identifies the credential, transport pin, expiry, effective scopes,
chain and cap modes. Transport, task state, step-up and handler conditions still
gate actual actions. Expired, revoked, disabled, terminal-bound or expired-lease
authority shows no permitted objects in an owner preview. Evaluator failure is
a whole-request 503, never partial success. Self credential failures are refused
by ordinary authentication before the preview runs.

The Access manager uses the existing root owner-plane
`GET /access-profiles/what-if?principalId=...`. Select one exact `credentialId`
for a delegated identity; no union of several keys is invented. Up to 50 key
references are listed.
The UI discloses a truncated credential list and accepts an exact credential UUID
for this identity, including keys beyond the first 50 and inactive historical keys.
A parentless Account without a selected credential is a hypothetical login-session
view. Missing/foreign credentials are 404; malformed
IDs, types, limits or cursors are 400. Original owner/self/transport gates remain.

`agent.minted` records mint-transaction Task/Phase/Project coordinates,
observation time, context basis and role-grant IDs. This is historical evidence;
live previews resolve current context again after movement. It is never a cache.

This current-predicate projection is separate from future Main/account extensions.
The object-first view of the same predicate is the Access Explorer
(`GET /access-explorer/objects/{type}/{id}`, see [api.md](api.md)). Neither adds a
permission or mutation surface.
