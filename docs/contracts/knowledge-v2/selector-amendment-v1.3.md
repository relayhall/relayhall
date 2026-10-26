# Category selectors and dynamic Compartments amendment v1.3: the search budget

A first search for a new text answered `partial` with reason
`deadline` and no rows from a source whose store needed about 6 s for a cold
search, even when the caller allowed 8 s (`timeoutMs` 8000): the core never told
the source how long it would wait, so the source cut the search at its own
shorter constant. This amendment lets the core tell it, and lets the source say
which budget a `deadline` belongs to. It adds two optional wire properties and
nothing else. It does not represent deployment or human TST acceptance.

## 1. What changed in the schema

`selector-v2.schema.json` after this amendment: schema sha256 `53d03a7fadf3a2bb7992a3f633881bac93dc40f5c7409349731805d342fe8f43`
(14,817 bytes). The v1.2 file was `e557d432be1a6764f8ff95665f8d96929f9ca71bf57da19360a7091226acf99f`.

Two additive, optional properties:

- `$defs.sourceSearchRequest.properties.budget_ms`: `{"type": "integer",
  "minimum": 1, "maximum": 8000}`. The milliseconds the caller will wait for
  this search, sent by the core on every v2 search.
- `$defs.sourceSearchResponse.properties.deadline_fired`: `{"enum":
  ["caller_deadline", "source_deadline"]}`. Present only when `retrieval.reasons`
  contains `deadline`.

Unchanged, byte for byte: `query` (the caller's request), `filter`, `retrieval`
(there is no fifth reason), `result`, `compartment`, the descriptor and every
get shape. A source that ignores `budget_ms` and never sends `deadline_fired`
stays conformant; it keeps answering as before.

## 2. The budget rule

- **The core.** A v2 search leg is dialed under one budget, `min(timeoutMs,
  what is left of the legs phase)`, which both the dial client's socket timeout
  and the request clock enforce (`KnowledgeFanoutExecutor.ts`). The core sends
  `budget_ms` = that budget less `KNOWLEDGE_SOURCE_BUDGET_MARGIN_MS` (300 ms,
  `KnowledgeDeadline.ts`), never below 1. The margin covers the source's work
  after its own deadline (assembly, its audit append) and the trip back, so a
  source that spends the whole budget still answers before the core stops
  waiting. A v1 source's wire is unchanged.
- **The source.** When `budget_ms` is present it is the whole search's
  deadline: every store query and every hydration read is bounded by it, and a
  store keeps back only its own hydration reserve. When it is absent the
  source's own default budget governs.
- **Truthful deadlines.** A search that runs out of time answers `partial` with
  reason `deadline`, never an empty success, and names its budget:
  `caller_deadline` (the `budget_ms` the caller sent) or `source_deadline` (the
  source's own default). The core copies it into the coverage entry,
  `partialSources: [{id, reasons, deadlineFired?}]`. A `deadline_fired` that is
  not one of the two names, or that comes without the `deadline` reason, is a
  malformed v2 answer: the source is `unavailable` with reason `transport`.
- **The core's own deadline** is not a source's partial answer: a leg the core
  stops waiting for lands in `coverage.timedOut`, as before.

## 3. Pins

`backend/src/__tests__/knowledgeSelectorSchemaPin.test.ts` pins the sha256
above and reads it back from this file. `validate_contract_v1_2.py` pins the
v1.2 bytes and is that amendment's receipt; it is not re-run against v1.3.
