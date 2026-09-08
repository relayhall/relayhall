/**
 * jsonBodyTypes — the request content types the server parses as JSON, in
 * ONE place.
 *
 * `server.ts` registered `express.json()` with its default type, so a body
 * sent as `application/scim+json` — the media type RFC 7644 §3.1 gives SCIM
 * and the one `routes/scim` itself answers with — was never parsed, and a
 * conforming provisioning client was refused `400 userName is required`
 * while the same bytes as `application/json` were accepted. Found by the W4
 * candidate-A live drill (card `127556e1`), which spoke the protocol's own
 * type where every suite had spoken `application/json`; folded into
 * candidate C by owner ruling `6bdcc16c` §3.
 *
 * The list is data rather than an inline option so that the contract test
 * mounts the SAME parser the server mounts, and so a census can see the
 * server passing it — a test that configured its own parser would prove
 * only that the test's parser understood SCIM.
 */
export const JSON_BODY_TYPES = ['application/json', 'application/scim+json'] as const;

/** The `express.json()` options the server and every drill mount with. */
// Explicitly preserve Express's shipped100 KiB limit so Blueprint size
// validation derives from the same options object passed to express.json.
export const jsonBodyOptions = { type: [...JSON_BODY_TYPES], limit: 102400 };
