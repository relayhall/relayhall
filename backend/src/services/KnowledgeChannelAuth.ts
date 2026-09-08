/**
 * KnowledgeChannelAuth.ts — RH-KW1 candidate C (card `0b4b779b`).
 *
 * §4.2's core→source CHANNEL AUTHENTICATION, at dial time.
 *
 * ── THE REQUIREMENT, VERBATIM ──
 *
 * §4.2, on `knowledge_core_credential_ref`: "the credential (never on the
 * board) core resolves to authenticate ITSELF to this source: mutual TLS
 * client identity or a core bearer the source pins. **REQUIRED for every
 * external source in BOTH claims modes** (sol R1-2): every knowledge dial
 * (search and get) authenticates core to the source over this channel BEFORE
 * anything else is read — the assertion is attested data on an
 * already-authenticated channel, never the sole authenticator (§5.6). What
 * `claims_mode='none'` omits is the ASSERTION, never channel authentication."
 *
 * ── WHY THIS MODULE EXISTS IN CANDIDATE C ──
 *
 * Candidate A shipped the owner-plane half: the `knowledge_core_credential_ref`
 * column, its REQUIRED-for-external CHECK, and the named refusal for a source
 * registered without one. What it did not ship is the DIAL-TIME half — no code
 * resolved the reference or put anything on the wire — so until this module
 * every knowledge dial was anonymous. Three acceptance clauses assigned to
 * candidate C cannot close without it, which is how the gap surfaced:
 *
 *   • item 2: "a captured assertion replayed by a party that cannot
 *     channel-authenticate as core is refused BEFORE the assertion is read";
 *   • item 2: "a `none`-mode source STILL receives only channel-authenticated
 *     dials (mutation: disable channel auth for the `none` fixture, its drill
 *     fails; sol R1-2)";
 *   • item 8: "channel-auth failure ⇒ `unavailable:transport`".
 *
 * The evidence report records this as a DECLARED substrate addition inside
 * candidate C, not as a design change: §4.2 already required it, and the
 * subtask that named it ([0], "owner-plane config + outbound policy + channel
 * auth") shipped only the configuration half.
 *
 * ── WHERE THE SECRET LIVES, AND WHY NOT ON THE BOARD ──
 *
 * The estate's rule is absolute and predates this feature: "the board stores
 * reference NAMES, never secret material" (`utils/serviceDescriptor.ts:316`,
 * RH-DESIGN.5 R5). So the row keeps the NAME, and the material comes from the
 * deployment environment — the same shape `RELAYHALL_CREDENTIAL_KEYS` and
 * `RELAYHALL_KNOWLEDGE_ASSERTION_KEYS` already use. One variable,
 * `RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS`, maps a reference name to either a
 * bearer token or a client-certificate pair.
 *
 * ── FAIL CLOSED, WITH THE OUTCOME THE DESIGN NAMES ──
 *
 * A source whose reference resolves to nothing is NOT dialed. It is not
 * "dialed anonymously and refused by the source" — that would send the query
 * text to a party core cannot authenticate itself to, which is the exfiltration
 * surface §7.7 is written about. The caller sees `unavailable:transport`,
 * which is item 8's ruled outcome for a channel-auth failure and says nothing
 * about the deployment's configuration.
 */

/** What a resolved reference authenticates core WITH. */
export type KnowledgeChannelCredential =
  | { kind: 'bearer'; token: string }
  | { kind: 'mtls'; certificate: string; privateKey: string };

/** The environment variable that carries the material. */
export const KNOWLEDGE_CHANNEL_CREDENTIALS_ENV = 'RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS';

interface RawEntry {
  bearer?: unknown;
  certificate?: unknown;
  privateKey?: unknown;
}

/**
 * Resolve one reference name.
 *
 * Returns `null` for every failure — absent variable, unparseable JSON, an
 * unknown name, a malformed entry — because the caller's disposition is the
 * same in all four cases and a reason here would only travel as far as a log.
 * The distinction an operator needs is in the configuration they wrote, not in
 * a token core invents about it.
 */
export function resolveChannelCredential(
  reference: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeChannelCredential | null {
  if (!reference) return null;
  const raw = env[KNOWLEDGE_CHANNEL_CREDENTIALS_ENV];
  if (!raw) return null;
  let parsed: Record<string, RawEntry>;
  try {
    parsed = JSON.parse(raw) as Record<string, RawEntry>;
  } catch {
    return null;
  }
  const entry = parsed?.[reference];
  if (!entry || typeof entry !== 'object') return null;

  if (typeof entry.bearer === 'string' && entry.bearer.length > 0) {
    return { kind: 'bearer', token: entry.bearer };
  }
  if (typeof entry.certificate === 'string' && entry.certificate.length > 0
    && typeof entry.privateKey === 'string' && entry.privateKey.length > 0) {
    return { kind: 'mtls', certificate: entry.certificate, privateKey: entry.privateKey };
  }
  return null;
}

/**
 * The dial options one credential contributes.
 *
 * Split this way so a caller cannot accidentally dial with the credential
 * half-applied: it either spreads both fields or it has no credential and must
 * not dial at all.
 */
export function channelAuthDialOptions(credential: KnowledgeChannelCredential): {
  headers?: Record<string, string>;
  clientCertificate?: { certificate: string; privateKey: string };
} {
  if (credential.kind === 'bearer') {
    // A bearer the SOURCE pins (§4.2). It authenticates CORE — it is not the
    // caller's credential, which never leaves core (§5.4).
    return { headers: { authorization: `Bearer ${credential.token}` } };
  }
  return { clientCertificate: { certificate: credential.certificate, privateKey: credential.privateKey } };
}
