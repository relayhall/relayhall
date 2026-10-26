# Category selectors and dynamic Compartments amendment v1.2: the default scope

Decided 11 Oct 2026: searches cover current
knowledge by default; the archive is searched only when the caller opts in,
with a clear "include archive" control for people and an explicit parameter for
agents, and every answer states which scopes were searched. This amendment adds
what that needs to the v1.1 contract and nothing else. It does not represent
deployment or human TST acceptance.

## 1. What changed in the schema

`selector-v2.schema.json` after this amendment: schema sha256 `e557d432be1a6764f8ff95665f8d96929f9ca71bf57da19360a7091226acf99f`
(14,572 bytes). The v1.1 file was
`f13bbfb97ba6fb3bd5403e42af4c11aaad554fe1b93ebe7cd7ad1e4614003650`.

Two additive, optional properties:

- `$defs.query.properties.includeArchive` — `{"type": "boolean"}`. Absent or
  `false` is the default scope, current knowledge. The query keeps
  `additionalProperties: false`, so this is the only new request key.
- `$defs.descriptor.properties.archiveCategories` — an array of category
  strings (the category pattern, 1..64 items, unique). It names the declared
  `categories` that are this source's archive.

Unchanged, byte for byte: `filter`, `retrieval`, `sourceSearchRequest`,
`sourceSearchResponse`, `result`, `compartment` and every get shape. There is
no fifth retrieval reason, no new skip reason and no new wire field: a source
never receives `includeArchive`.

## 2. The descriptor field

`archiveCategories` is valid only on a v2 dynamic-opaque descriptor and must be
a non-empty SUBSET of the declared `categories`, without duplicates. JSON
Schema cannot state the subset rule, so it is a supplemental semantic check
(v1.1 §6) that the core enforces when a descriptor is published: a category
outside the declared vocabulary would be subtracted from nothing while the real
archive stayed in every default search, so the descriptor is refused. Declaring
every category as archive is legal: such a source is searched only on opt-in.
A source that declares no archive is unaffected by this amendment.

## 3. The flag is never authority

The core converts `includeArchive` into the EXISTING `filter.categories`; it
never forwards the flag. For each consulted v2 source:

- `includeArchive: true`, or a source without `archiveCategories`: the
  request's categories, unchanged (absent when the request named none).
- otherwise: `(request categories, or the declared categories when the request
  named none) minus archiveCategories`, sorted. When nothing is left the source
  is skipped with the existing reason `categories`.

Categories AND with authority at the source (v1.1 §2), so the subtraction can
only narrow, and stopping it restores exactly the request the caller could
already make. The flag cannot reach a compartment the caller does not hold, a
source the caller cannot see, or a row the source does not release to that
caller. The visible-vocabulary check, the sixteen-source ceiling and the
fan-out bounds are unchanged; a source skipped by the narrowing is not dialed
and does not count towards the ceiling.

## 4. Coverage

The coverage record gains two fields, so every answer states what was searched:

- `searchedCategories: [{id, categories: string[] | "all"}]` — a modifier of
  `consulted`: one entry per consulted id, every id in `consulted`. It names
  the categories that source was asked to search and declares, or `all` when
  no category filter was sent (a v1 source, or a v2 source with neither a
  requested nor a narrowed set).
- `archive: {included: boolean}` — the caller's opt-in.

Invariant: when `archive.included` is `false`, no entry names a category its
source declares as archive, and no entry is `all` for a source that declares
one. The core's coverage builder refuses to build a record that breaks it, so
an answer cannot say "archive excluded" about a search that reached the
archive. The rendered answer (MCP text and the dashboard) leads with one
sentence: `Searched: current knowledge; archive excluded (pass includeArchive: true).`
or `Searched: current knowledge and the archive (includeArchive: true).`

## 5. Sealed handles

The filter sealed into every v2 handle is the filter the source was SENT, so a
handle from a default search carries the narrowed categories. A cited GET
re-sends that filter and the core refuses content whose category is outside it
(`source_protocol_error`), so a default-search handle can never open an archive
document, whatever the source answers. A result in an archive category returned
to a default search is dropped and named in `invalidResults`.

## 6. Four surfaces, one normalized request

REST `POST /knowledge-queries` with `protocol_version: 2` accepts
`includeArchive`; a non-boolean value, or the key on a v1 request, is
`400 INVALID_SELECTOR`. The MCP tool `relayhall_knowledge_source_search` has an
`includeArchive` boolean argument. The CLI has `knowledge search
--include-archive`. The dashboard Knowledge page has an "Include archive"
checkbox, off by default and remembered per Account in the browser (local
storage key `knowledge-include-archive:<principalId>`); nothing is stored on the
server. All four normalize to the same `$defs.query` object.

## 7. One schema, pinned on both sides

A source that validates requests against this schema keeps a byte-identical
copy. The core pins the sha256 above BY VALUE in
`backend/src/__tests__/knowledgeSelectorSchemaPin.test.ts`; the pin moves only
with a contract amendment, in the same change as the schema, and the source's
copy moves with it.

## 8. Executable scope

`validate_contract_v1_2.py` replays the v1.1 fixtures against the amended
schema, runs the structural fixtures for the two new properties, the semantic
subset and default-scope cases, four-surface parity for `includeArchive`, and
checks the sha256 recorded in section 1 against the file. It writes
`fixtures-v1.2.json`. It claims no network, security, scale or runtime
acceptance; those are the core's suites.
