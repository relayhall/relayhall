/**
 * The wire contract for `POST /telemetry/events/batch`, in ONE place.
 *
 * Owner decision D2 ruled that TW1a's spool endpoint IS the ratified home of
 * canonical batch ingest, and design §3.1 fixes its format: **JSONL of full
 * `rh.ai.telemetry/1.0` records**, one JSON object per line. Integrity rides
 * the authenticated transport at upload; there is deliberately **no separate
 * payload signature in v1** — a ratified simplification, not an omission.
 *
 * The types and limits are data rather than inline options for the reason
 * `jsonBodyTypes` records: a contract test must be able to mount the SAME
 * parser the server mounts. A test that configured its own parser would prove
 * only that the test's parser understood NDJSON.
 */

/**
 * `application/x-ndjson` is the type NDJSON is actually sent as; `application/jsonl`
 * is the newer spelling. Both are accepted because a reporter that spells it
 * the other way is not malformed, it is early or late.
 */
export const NDJSON_BODY_TYPES = ['application/x-ndjson', 'application/jsonl'] as const;

/**
 * The largest batch body the receiver will accept, in bytes.
 *
 * The BODY PARSER enforces it, which is a bound on buffering rather than on
 * reading: with `Content-Length` the request is refused up front, and with a
 * chunked upload the parser reads until it can tell the limit is exceeded and
 * then stops. Either way no oversized body is ever fully buffered, parsed, or
 * seen by the handler — which is the guarantee that matters, and is weaker
 * than "no byte is read". Review `d9697a35` F4 corrected the earlier claim.
 */
export const TELEMETRY_BATCH_MAX_BYTES = 1_048_576;

/**
 * The largest number of records one batch may carry.
 *
 * A second, independent bound: a megabyte of two-byte lines is half a million
 * records, and each one costs a validation and a write. Bytes bound the read;
 * this bounds the work.
 */
export const TELEMETRY_BATCH_MAX_RECORDS = 500;

/** The `express.text()` options the server and every drill mount with. */
export const ndjsonBodyOptions = {
  type: [...NDJSON_BODY_TYPES],
  limit: TELEMETRY_BATCH_MAX_BYTES,
};
