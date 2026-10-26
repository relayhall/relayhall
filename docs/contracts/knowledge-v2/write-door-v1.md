# Knowledge write door v1 — the wire the core dials

The RelayHall core's half of the knowledge write path (RB-11 Governor v0,
ratified design C.2, C.3, C.8, C.11, C.12 and C.16). It states exactly what the
core sends to a registered source's write surface and what it accepts back, so a
source implementation and the core can be checked against one text. The source
decides who may write where and who will read the note (C.4–C.6); the core
decides who is asking and relays.

## 1. Where the core dials

- **Owner plane.** A Service carries `knowledgeWriteEndpoint` beside its query
  and get endpoints (`PATCH /services/{id}/owner-plane`, root only). It is the
  BASE URL of the write surface; the core appends `/propose`, `/preview` or
  `/commit` to its path (a trailing slash is dropped first, a query string is
  kept). It is https only, needs the query endpoint, needs claims mode
  `asserted`, and is dialed under the same allowed networks, the same channel
  credential (`knowledgeCoreCredentialRef`) and the same outbound address
  policy as reads. Redirects are not followed.
- **Descriptor.** The current descriptor must be a v2 dynamic-opaque
  `knowledgeSource` block carrying `write: {"protocol_version": 1, "kinds":
  ["note"]}`. Publish that descriptor version first, then set the endpoint: the
  owner-plane act refuses an endpoint without the block
  (`KNOWLEDGE_WRITE_BLOCK_REQUIRED`), and a publish may not drop the block from
  under a configured endpoint.
- A source is **write-capable** only with both halves
  (`KnowledgeSourcePolicy.isKnowledgeWriteCapable`). The reserved board row is
  never write-capable.

## 2. The channel and the assertion

Every request carries the channel credential (the bearer header, or the
client certificate) exactly as a read does. The body carries a compact JWS in
`assertion`:

- header `{"alg": "EdDSA", "typ": "rh-knowledge-write-assertion+jwt", "kid": <active key>}`
  — the read keyset and kid (the published JWKS), a different `typ`;
- claims `iss`, `act: "relayhall-core"`, `sub` (pairwise by default), `grp`
  (minimised to the source's relevant groups), `aud` (the Service id), `iat`,
  `nbf = iat - 10`, `exp = iat + 30` (never more than 60), `jti` (fresh per
  act), `op` (the verb of the endpoint), and `tsk` + `prj` — both or neither.

`tsk`/`prj` are attested by the core, never taken from the request body: an
Agent's live bound Task, or a `taskId` the caller may read, with `prj` read
from the Task row; a Task without a Project gives neither. Preview and commit
re-attest the context of the proposal.

A source verifies the `typ` per endpoint (a read assertion never authorises a
write, and the reverse), `op` against the endpoint, and keeps a write-side jti
seen-set: a replayed write assertion is refused `assertion_invalid`.

## 3. Requests (JSON, `protocol_version: 1`)

| Verb | Body |
|---|---|
| `propose` | `assertion`, `title`, `content`, `note_type`, `tags`, `target`, `basis`, `revision_of`?, `expected_revision` |
| `preview` | `assertion`, `proposal_id` |
| `commit` | `assertion`, `proposal_id`, `preview_digest`, `expected_revision` |

- `target` is `{"kind": "default"}`, `{"kind": "personal"}` or
  `{"kind": "compartment", "id": <opaque id>}`. With `revision_of` the core
  always sends the revision's own compartment.
- `basis` items are unsealed from the caller's sealed handles by the core: an
  item of THIS source is `{"ref", "compartment"}`; an item of any other source
  (the board included) is `{"source", "compartment"}` — another source's ref is
  never sent.
- `revision_of` is `{"ref", "compartment"}` of this source only.
- `expected_revision` is `"absent"` for a create and the 64-hex sha256 the
  caller read for an update.

The core enforces its caller-input bounds BEFORE it dials (C.16): title 1–200
characters on one line; content at most 32768 bytes of UTF-8 and not opening
with `---`; `note_type` `[a-z][a-z0-9-]{0,31}` (default `note`); at most 16
tags `[a-z0-9-]{1,32}`; at most 25 basis items; and the serialised request,
with room for the assertion, at most 64 KiB. Open proposals per account and the
proposal lifetime are the source's.

## 4. Answers the core accepts

The core validates every answer field by field and recomputes digests itself.

- **propose / preview, 200:** `protocol_version: 1`, `status: "proposed"`,
  `proposal_id` (UUID; preview: the one asked about), `preview_digest` (64 hex),
  `expires_at`, `content_base64` (canonical base64, at most 64 KiB decoded),
  `byte_length` (= decoded length), `content_sha256` (= the sha256 of the
  decoded bytes — recomputed), `target.compartment {id, label?, kind}` (opaque
  id; kind `personal`, `project` or `base`), `audience` (an object, relayed as
  is), `expected_revision` (propose: the one sent) and optional `snapshot`. The
  caller receives this object UNCHANGED.
- **`base`** is the source's shared compartment, with its label as the source
  announces it (for example "Knowledge Fabric: shared"). The source alone
  decides whether a caller may write there; the core only relays the act and
  checks the answer's shape. What the source decides that with is the core's
  shared-area writer list, delivered in the signed lifecycle snapshot
  (`shared_writers`): the core governs who is on the list
  (root or an administrator login session with step-up) and the source
  enforces it on every write verb. A base compartment has no single owner or
  Project: its audience sentence must say that every Knowledge Fabric
  credential with content reads can read the note. Any other kind is
  `source_protocol_error`.
- **commit, 200:** `protocol_version: 1`, `status: "committed"`, `ref`,
  `compartment {id, label?}`, `sha256` (64 hex), `committed_at`. The caller
  receives it with ONE substitution: `ref` is sealed into a v2 handle against
  the source's current descriptor version, readable through
  `GET /knowledge-contents`. A repeated commit of a committed proposal must
  answer the stored commit (C.8 step 8).
- **refusals:** `{"protocol_version": 1, "status": "refused", "code": <code>}`
  with the status C.11 binds to the code: `assertion_invalid`,
  `target_not_writable`, `no_private_scope`, `audience_exceeds_basis`,
  `basis_unreadable`, `not_own_note`, `content_secret_suspect`, `egress_blocked`,
  `reserved_name` (403); `content_invalid` (400); `audience_changed`,
  `preview_mismatch`, `revision_conflict` (409); `proposal_expired` (410); `daily_cap` (429);
  `internal_error` (500); `commit_unverified` (502, with `ref` and
  `compartment`, which the core seals into a handle); `unavailable` (503). A
  429 is read from its status alone: the shared dial client does not read a
  429 body, and `daily_cap` is the only 429.
- **`reserved_name`** (403): the rendered note name is reserved for curator
  files; choose another title. The core relays it unchanged with `refusedBy:
  source`.

Anything else — an unknown code, a code at another status, an invalid 200 —
is `source_protocol_error` (502) to the caller; an unreachable source is
`source_unavailable` (503) or `source_timed_out` (504). Response cap 256 KiB;
deadline 8 s.

## 5. What the core keeps

No note content: not the title, a tag, the body or the rendered bytes. The
fail-closed `knowledge_write_audit` table gets an `intent` row before the dial
(no row, no dial) and an `outcome` row after: the acting principal, the
credential, the Account, the source, the proposal, the assertion `jti`, the
Task and Project, the outcome, `content_sha256`, the compartment id and the
sha256 of the committed ref. A keyed commit's retry receipt holds the sealed
handle and digests.

## 6. Governor ceilings and implementation agreement

The source-side governor ceilings are configuration, not core limits. The
current reference source defaults are 20 open proposals per Account, 100 commits
per Account per UTC day, and 40 open proposals globally. Reaching the
per-Account open-proposal ceiling returns `429 daily_cap` with reason
`open_ceiling`; reaching the daily commit ceiling returns `429 daily_cap`;
reaching the global open-proposal ceiling returns `503 unavailable` with reason
`open_ceiling`. The core reads any 429 by status alone and maps it to
`daily_cap`, as described in section 4. The source's governor settings are
`open_per_account`, `open_total` and `daily_commits_per_account`, defaulting to
20, 40 and 100; `daily_commits_per_account` accepts values from 1 through 400.
Deployment preflight checks that governor keys are recognized and that
`open_total` does not exceed 49. Source initialization validates the numeric
ranges for the governor settings. A settings change requires a backup, preflight
and quiet-window source recreation with read-back; it does not require a code
release.

The implementations must also agree on the base URL plus `/<verb>`;
snake_case body fields; the assertion inside the body; the bearer channel
credential being the source's existing `knowledgeCoreCredentialRef`; the
refusal shape and statuses above; the commit answer shape; and the 8 s
deadline. The core passes through only the refusal codes listed in section 4.
