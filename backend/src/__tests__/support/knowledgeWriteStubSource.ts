/**
 * __tests__/support/knowledgeWriteStubSource.ts — a STUB knowledge source with
 * a WRITE surface, for RB-11 Governor v0's core-door suites (card `b796067e`).
 *
 * It plays the source side of the ratified write wire (design C.2, C.3, C.7,
 * C.8, C.11) closely enough that the core door can be measured against it:
 *
 *  - HTTPS with a self-signed certificate minted per run, so the real dial
 *    client dials it under the real outbound policy (the trust anchor reaches
 *    the dial client through the suite's spy, never through a route option);
 *  - the channel bearer is checked BEFORE a body is read, as a source must;
 *  - every write request's assertion is VERIFIED with the core's PUBLISHED
 *    keyset (`knowledgeAssertionJwks()`), as the source verifier does: alg
 *    EdDSA, the write `typ`, a known `kid`, `act`, `aud` = this source, a
 *    0 < exp - iat <= 60 lifetime, nbf = iat - 10, a live window, `op` equal to
 *    the endpoint's verb, `tsk`/`prj` both or neither, and a write-side jti
 *    SEEN-SET that refuses a replayed assertion (C.3);
 *  - the three verbs answer C.2's shapes: propose and preview return rendered
 *    bytes with their sha256, an opaque target compartment, an audience and a
 *    preview digest; commit checks the digest and the expected revision, and a
 *    repeated commit of a committed proposal returns the stored commit (C.8
 *    step 8); refusals use C.11's one shape;
 *  - `/get` answers the v2 read wire for a committed ref, verifying the READ
 *    assertion type, so a committed handle can be read back through the door.
 *
 * The write verbs are routed by the LAST path segment, whatever the prefix, and
 * every request records its full path. A suite can therefore assert the path
 * the core dialed (the owner-plane base URL plus the verb) without the stub
 * refusing an unexpected prefix and turning every other control red.
 *
 * It is a STUB: it decides no authority. Who may write where is the source's
 * Governor's business (C.4-C.6), out of the core door's scope.
 */
import https from 'https';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { generateSelfSignedCertificate, type SelfSignedCertificate } from './selfSignedCertificate';

export const STUB_WRITE_TYP = 'rh-knowledge-write-assertion+jwt';
export const STUB_READ_TYP = 'rh-knowledge-assertion+jwt';

export interface StubRequest {
  method: string;
  path: string;
  verb: string;
  body: Record<string, unknown> | null;
  /** The verified assertion header and claims, or null when it did not verify. */
  header: Record<string, unknown> | null;
  claims: Record<string, unknown> | null;
  /** The raw compact assertion, for replay drills. */
  assertion: string | null;
  /** Why verification failed, when it did. */
  refusal: string | null;
  status: number;
  answer: string;
}

interface StoredProposal {
  proposalId: string;
  sub: string;
  bytes: Buffer;
  sha256: string;
  digest: string;
  compartment: { id: string; label: string; kind: 'personal' | 'project' | 'base' };
  expectedRevision: string;
  committed: { ref: string; committedAt: string } | null;
}

export interface StubOverride {
  /** Answer the NEXT write request with this status and body, whatever it asked. */
  status: number;
  body: string;
}

export class KnowledgeWriteStubSource {
  constructor(private readonly commonName = 'rb11-write-stub') {}

  private server: https.Server | null = null;
  certificate!: SelfSignedCertificate;
  port = 0;
  host = '127.0.0.1';

  /** Every request that passed the channel check, in order. */
  readonly requests: StubRequest[] = [];
  /** Requests refused at the channel, before their body was read. */
  readonly channelRefusals: string[] = [];

  /** The bearer core must present (§4.2). */
  bearer = '';
  /** This source's id: the write assertion's required audience. */
  sourceId = '';
  /** The core's PUBLISHED keyset (public JWKs), set by the suite. */
  jwks: Array<Record<string, string>> = [];

  /** The C.2 answers, per proposal; the ref store for `/get`. */
  readonly proposals = new Map<string, StoredProposal>();
  readonly notes = new Map<string, { bytes: Buffer; sha256: string; compartment: string }>();
  /** The write-side jti seen-set (C.3). */
  readonly seenJti = new Set<string>();

  /** Compartment ids this stub answers as its shared (`base`) area, with the label it announces. */
  readonly baseCompartments = new Map<string, string>();

  /** One-shot answer override, for the C.11 pass-through and protocol drills. */
  override: StubOverride | null = null;

  async start(host: string, bindAddress = '0.0.0.0'): Promise<void> {
    this.host = host;
    this.certificate = generateSelfSignedCertificate({
      commonName: this.commonName,
      dnsNames: ['rb11-write-stub.invalid'],
      ipAddresses: [...new Set(['127.0.0.1', host])],
    });
    this.server = https.createServer({ cert: this.certificate.cert, key: this.certificate.key }, (req, res) => {
      if (req.headers.authorization !== `Bearer ${this.bearer}`) {
        this.channelRefusals.push(req.url ?? '');
        req.resume();
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"refused":"channel"}');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const path = (req.url ?? '').split('?')[0];
        const verb = path.split('/').filter(Boolean).pop() ?? '';
        let body: Record<string, unknown> | null = null;
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = null; }
        const answer = this.handle(verb, body);
        const entry: StubRequest = {
          method: req.method ?? '', path, verb, body,
          header: answer.header, claims: answer.claims,
          assertion: typeof body?.assertion === 'string' ? body.assertion : null,
          refusal: answer.refusal, status: answer.status, answer: answer.body,
        };
        this.requests.push(entry);
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, bindAddress, () => {
        this.port = (this.server!.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** The base URL the core is configured with (the owner-plane write endpoint). */
  url(path: string): string {
    return `https://${this.host}:${this.port}${path}`;
  }

  writeRequests(): StubRequest[] {
    return this.requests.filter((entry) => ['propose', 'preview', 'commit'].includes(entry.verb));
  }

  // ───────────────────────────── verification ─────────────────────────────

  /**
   * Verify a compact assertion as the source verifier does. Returns the claims,
   * or the refusal reason. `typ` decides which assertion this endpoint takes.
   */
  verify(token: unknown, typ: string, verb: string | null): { header: Record<string, unknown> | null; claims: Record<string, unknown> | null; refusal: string | null } {
    if (typeof token !== 'string') return { header: null, claims: null, refusal: 'no assertion' };
    const parts = token.split('.');
    if (parts.length !== 3) return { header: null, claims: null, refusal: 'not compact' };
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return { header: null, claims: null, refusal: 'not json' };
    }
    if (header.alg !== 'EdDSA') return { header, claims: null, refusal: 'alg' };
    if (header.typ !== typ) return { header, claims: null, refusal: 'typ' };
    const jwk = this.jwks.find((key) => key.kid === header.kid);
    if (!jwk) return { header, claims: null, refusal: 'kid' };
    const publicKey = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
    if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'), publicKey, Buffer.from(parts[2], 'base64url'))) {
      return { header, claims: null, refusal: 'signature' };
    }
    const now = Math.floor(Date.now() / 1000);
    const iat = Number(claims.iat); const nbf = Number(claims.nbf); const exp = Number(claims.exp);
    if (claims.act !== 'relayhall-core') return { header, claims: null, refusal: 'act' };
    if (claims.aud !== this.sourceId) return { header, claims: null, refusal: 'aud' };
    if (typeof claims.iss !== 'string' || claims.iss.length === 0) return { header, claims: null, refusal: 'iss' };
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return { header, claims: null, refusal: 'sub' };
    if (!(exp - iat > 0 && exp - iat <= 60) || nbf !== iat - 10) return { header, claims: null, refusal: 'lifetime' };
    if (now < nbf || now > exp + 10) return { header, claims: null, refusal: 'window' };
    if (typeof claims.jti !== 'string' || claims.jti.length < 16) return { header, claims: null, refusal: 'jti' };
    if (typ === STUB_WRITE_TYP) {
      if (claims.op !== verb) return { header, claims: null, refusal: 'op' };
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const hasTsk = claims.tsk !== undefined; const hasPrj = claims.prj !== undefined;
      if (hasTsk !== hasPrj || (hasTsk && (!uuid.test(String(claims.tsk)) || !uuid.test(String(claims.prj))))) {
        return { header, claims: null, refusal: 'task context' };
      }
      // C.3: the write-side jti seen-set. A replayed write assertion is refused.
      if (this.seenJti.has(claims.jti)) return { header, claims: null, refusal: 'replayed jti' };
      this.seenJti.add(claims.jti);
    }
    return { header, claims, refusal: null };
  }

  // ───────────────────────────── the verbs ─────────────────────────────

  private refused(status: number, code: string, extra: Record<string, unknown> = {}): { status: number; body: string } {
    return { status, body: JSON.stringify({ protocol_version: 1, status: 'refused', code, ...extra }) };
  }

  private render(sub: string, body: Record<string, unknown>, claims: Record<string, unknown>): Buffer {
    const lines = [
      '---',
      `title: ${JSON.stringify(String(body.title))}`,
      `type: ${String(body.note_type)}`,
      `tags: [${(body.tags as string[]).join(', ')}]`,
      `captured-by: relayhall-account/${sub}`,
      ...(claims.prj ? [`relayhall_project: ${String(claims.prj)}`] : []),
      ...(claims.tsk ? [`relayhall-task-id: "${String(claims.tsk)}"`] : []),
      '---',
      '',
      String(body.content),
    ];
    return Buffer.from(lines.join('\n'), 'utf8');
  }

  private compartmentFor(sub: string, body: Record<string, unknown>, claims: Record<string, unknown>): StoredProposal['compartment'] {
    const target = body.target as Record<string, unknown>;
    if (target?.kind === 'compartment' && this.baseCompartments.has(String(target.id))) {
      return { id: String(target.id), label: this.baseCompartments.get(String(target.id)) as string, kind: 'base' };
    }
    if (target?.kind === 'compartment') return { id: String(target.id), label: 'named compartment', kind: 'project' };
    if (target?.kind === 'default' && claims.prj) return { id: String(claims.prj), label: 'project', kind: 'project' };
    const personal = crypto.createHash('sha256').update(`personal|${sub}`).digest('hex');
    return {
      id: `${personal.slice(0, 8)}-${personal.slice(8, 12)}-4${personal.slice(13, 16)}-8${personal.slice(17, 20)}-${personal.slice(20, 32)}`,
      label: 'personal', kind: 'personal',
    };
  }

  private proposalAnswer(proposal: StoredProposal): string {
    return JSON.stringify({
      protocol_version: 1,
      status: 'proposed',
      proposal_id: proposal.proposalId,
      preview_digest: proposal.digest,
      expires_at: new Date(Date.now() + 540_000).toISOString(),
      content_base64: proposal.bytes.toString('base64'),
      content_sha256: proposal.sha256,
      byte_length: proposal.bytes.length,
      target: { compartment: proposal.compartment },
      audience: {
        rule: 'intersection',
        relayhall: { compartment: proposal.compartment, readers: { accounts: ['fixture account'], groups: 0 }, owner_only: proposal.compartment.kind === 'personal' },
        knowledge_fabric: {
          class: proposal.compartment.kind === 'personal' ? 'private:fixture' : 'base',
          sentence: proposal.compartment.kind === 'base'
            ? 'Every Knowledge Fabric credential with content reads can read this note.'
            : 'fixture audience sentence',
        },
        basis: { implicit: proposal.compartment.label, declared: 0, resolved: 0, unresolved: 0 },
        writers: 'fixture governor',
      },
      expected_revision: proposal.expectedRevision,
      snapshot: { generation: 7 },
    });
  }

  private handle(verb: string, body: Record<string, unknown> | null): { status: number; body: string; header: Record<string, unknown> | null; claims: Record<string, unknown> | null; refusal: string | null } {
    if (verb === 'get') return this.handleGet(body);
    if (!['propose', 'preview', 'commit'].includes(verb)) {
      return { status: 404, body: '{"error":"no such verb"}', header: null, claims: null, refusal: 'verb' };
    }
    if (!body || body.protocol_version !== 1) {
      return { ...this.refused(400, 'content_invalid'), header: null, claims: null, refusal: 'protocol' };
    }
    const verified = this.verify(body.assertion, STUB_WRITE_TYP, verb);
    if (!verified.claims) return { ...this.refused(403, 'assertion_invalid'), header: verified.header, claims: null, refusal: verified.refusal };
    const claims = verified.claims;
    const sub = String(claims.sub);
    const wrap = (answer: { status: number; body: string }) => ({ ...answer, header: verified.header, claims, refusal: null });

    if (this.override) {
      const override = this.override;
      this.override = null;
      return wrap(override);
    }

    if (verb === 'propose') {
      const proposalId = crypto.randomUUID();
      const bytes = this.render(sub, body, claims);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const compartment = this.compartmentFor(sub, body, claims);
      const expectedRevision = String(body.expected_revision);
      const digest = crypto.createHash('sha256')
        .update(JSON.stringify({ proposal_id: proposalId, content_sha256: sha256, target: compartment.id, expected_revision: expectedRevision }))
        .digest('hex');
      const proposal: StoredProposal = { proposalId, sub, bytes, sha256, digest, compartment, expectedRevision, committed: null };
      this.proposals.set(proposalId, proposal);
      return wrap({ status: 200, body: this.proposalAnswer(proposal) });
    }

    const proposal = this.proposals.get(String(body.proposal_id));
    if (!proposal || proposal.sub !== sub) return wrap(this.refused(410, 'proposal_expired'));
    if (verb === 'preview') return wrap({ status: 200, body: this.proposalAnswer(proposal) });

    // commit (C.8)
    if (body.preview_digest !== proposal.digest) return wrap(this.refused(409, 'preview_mismatch'));
    if (body.expected_revision !== proposal.expectedRevision) return wrap(this.refused(409, 'revision_conflict'));
    if (!proposal.committed) {
      const ref = `notes/${proposal.compartment.kind}/${proposal.proposalId}.md`;
      proposal.committed = { ref, committedAt: new Date().toISOString() };
      this.notes.set(ref, { bytes: proposal.bytes, sha256: proposal.sha256, compartment: proposal.compartment.id });
    }
    // C.8 step 8: a repeated commit of a committed proposal returns the stored result.
    return wrap({
      status: 200,
      body: JSON.stringify({
        protocol_version: 1,
        status: 'committed',
        ref: proposal.committed.ref,
        compartment: { id: proposal.compartment.id, label: proposal.compartment.label },
        sha256: proposal.sha256,
        committed_at: proposal.committed.committedAt,
      }),
    });
  }

  /** The v2 read wire for a committed ref (§8.2), READ assertion verified. */
  private handleGet(body: Record<string, unknown> | null): { status: number; body: string; header: Record<string, unknown> | null; claims: Record<string, unknown> | null; refusal: string | null } {
    const verified = this.verify(body?.assertion, STUB_READ_TYP, null);
    if (!verified.claims) {
      return { status: 403, body: JSON.stringify({ protocol_version: 2, status: 'refused', code: 'refused' }), header: verified.header, claims: null, refusal: verified.refusal };
    }
    const note = this.notes.get(String(body?.ref));
    if (!note || body?.compartment_id !== note.compartment) {
      return { status: 404, body: JSON.stringify({ protocol_version: 2, status: 'refused', code: 'refused' }), header: verified.header, claims: verified.claims, refusal: 'unknown ref' };
    }
    return {
      status: 200,
      header: verified.header,
      claims: verified.claims,
      refusal: null,
      body: JSON.stringify({
        protocol_version: 2,
        status: 'content',
        content_base64: note.bytes.toString('base64'),
        sha256: note.sha256,
        offset: 0,
        byteLength: note.bytes.length,
        totalBytes: note.bytes.length,
        truncated: false,
        compartment: { id: note.compartment, label: 'fixture' },
        contentKind: 'docs',
        category: 'notes:note',
        retrieval: { status: 'complete', reasons: [] },
      }),
    };
  }
}
