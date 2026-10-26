/**
 * __tests__/support/knowledgeSearchStubSource.ts — a STUB v2 knowledge source
 * with a SEARCH and a GET surface, for the default-scope suite (card 40e0e542,
 * owner ruling E127 (5), selector amendment v1.2).
 *
 * It plays the source side of the v2 read wire closely enough for the core's
 * default scope to be measured against it:
 *
 *  - HTTPS with a self-signed certificate minted per run, dialed by the REAL
 *    dial client under the real outbound policy (the suite hands the trust
 *    anchor to the dial client through a spy, never through a route option);
 *  - the channel bearer is checked BEFORE a body is read;
 *  - every request's READ assertion is VERIFIED with the core's published
 *    keyset (alg, typ, kid, signature, act, aud = the source addressed);
 *  - one listener serves several sources, routed by the first path segment
 *    (`/<slug>/search`, `/<slug>/get`), each with its own declared categories;
 *  - search answers one v2 result per category it was asked to search — the
 *    filter's categories, or every declared category when the filter names
 *    none — and ECHOES the filter it received in each snippet;
 *  - AUTHORITY is the source's, not the core's: a subject outside a source's
 *    `archiveReaders` whose search reaches an archive category is REFUSED (403),
 *    as a source's own access control would refuse it;
 *  - get answers the v2 content shape for a ref it issued, with the ref's
 *    category (or a re-filed one, to drill a handle against moved content). It
 *    deliberately does NOT enforce the filter it is sent, so a refusal of moved
 *    content can only be the core's.
 *
 * It is a STUB: what it releases to whom is a fixture table, not a Guardian.
 */
import https from 'https';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { generateSelfSignedCertificate, type SelfSignedCertificate } from './selfSignedCertificate';

export const STUB_SEARCH_READ_TYP = 'rh-knowledge-assertion+jwt';

export interface StubSourceConfig {
  slug: string;
  sourceId: string;
  compartmentId: string;
  categories: string[];
  archiveCategories: string[];
  /** Subjects (as the assertion names them) this source releases its archive to. */
  archiveReaders: Set<string>;
}

export interface StubSearchRequest {
  slug: string;
  verb: string;
  rawBody: string;
  body: Record<string, unknown> | null;
  claims: Record<string, unknown> | null;
  refusal: string | null;
  status: number;
}

export class KnowledgeSearchStubSource {
  constructor(private readonly commonName = 'scope40-search-stub') {}

  private server: https.Server | null = null;
  certificate!: SelfSignedCertificate;
  port = 0;
  host = '127.0.0.1';
  bearer = '';
  jwks: Array<Record<string, string>> = [];
  readonly sources = new Map<string, StubSourceConfig>();
  /** Every request that passed the channel check, in order. */
  readonly requests: StubSearchRequest[] = [];
  /** One-shot: the next search also returns an archive-category hit, whatever it was asked. */
  misbehaveOnce = false;
  /** Refs the source has re-filed into another category since it issued them. */
  readonly refiled = new Map<string, string>();

  async start(host: string, bindAddress = '0.0.0.0'): Promise<void> {
    this.host = host;
    this.certificate = generateSelfSignedCertificate({
      commonName: this.commonName,
      dnsNames: ['scope40-search-stub.invalid'],
      ipAddresses: [...new Set(['127.0.0.1', host])],
    });
    this.server = https.createServer({ cert: this.certificate.cert, key: this.certificate.key }, (req, res) => {
      if (req.headers.authorization !== `Bearer ${this.bearer}`) {
        req.resume();
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"refused":"channel"}');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const segments = (req.url ?? '').split('?')[0].split('/').filter(Boolean);
        const [slug = '', verb = ''] = segments;
        let body: Record<string, unknown> | null = null;
        try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { body = null; }
        const answer = this.handle(slug, verb, body);
        this.requests.push({ slug, verb, rawBody, body, claims: answer.claims, refusal: answer.refusal, status: answer.status });
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

  url(path: string): string {
    return `https://${this.host}:${this.port}${path}`;
  }

  searches(slug?: string): StubSearchRequest[] {
    return this.requests.filter((entry) => entry.verb === 'search' && (slug === undefined || entry.slug === slug));
  }

  /** The ref a search hit carries for one category (stable, so a suite can name it). */
  static ref(slug: string, category: string): string {
    return `doc/${slug}/${category}`;
  }

  private verify(token: unknown, audience: string): { claims: Record<string, unknown> | null; refusal: string | null } {
    if (typeof token !== 'string') return { claims: null, refusal: 'no assertion' };
    const parts = token.split('.');
    if (parts.length !== 3) return { claims: null, refusal: 'not compact' };
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return { claims: null, refusal: 'not json' };
    }
    if (header.alg !== 'EdDSA' || header.typ !== STUB_SEARCH_READ_TYP) return { claims: null, refusal: 'header' };
    const jwk = this.jwks.find((key) => key.kid === header.kid);
    if (!jwk) return { claims: null, refusal: 'kid' };
    const publicKey = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
    if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'), publicKey, Buffer.from(parts[2], 'base64url'))) {
      return { claims: null, refusal: 'signature' };
    }
    if (claims.act !== 'relayhall-core') return { claims: null, refusal: 'act' };
    if (claims.aud !== audience) return { claims: null, refusal: 'aud' };
    if (typeof claims.sub !== 'string' || !claims.sub) return { claims: null, refusal: 'sub' };
    return { claims, refusal: null };
  }

  private refused(status: number, claims: Record<string, unknown> | null, refusal: string) {
    return { status, body: JSON.stringify({ protocol_version: 2, status: 'refused', code: 'refused' }), claims, refusal };
  }

  private handle(slug: string, verb: string, body: Record<string, unknown> | null): { status: number; body: string; claims: Record<string, unknown> | null; refusal: string | null } {
    const source = this.sources.get(slug);
    if (!source || !['search', 'get'].includes(verb)) return this.refused(404, null, 'route');
    if (!body || body.protocol_version !== 2) return this.refused(400, null, 'protocol');
    const verified = this.verify(body.assertion, source.sourceId);
    if (!verified.claims) return this.refused(403, null, verified.refusal ?? 'assertion');
    const claims = verified.claims;
    const filter = body.filter as { version?: number; kinds?: string[]; categories?: string[] } | undefined;
    if (!filter || filter.version !== 2) return this.refused(400, claims, 'filter');

    if (verb === 'search') {
      const reached = filter.categories ?? source.categories;
      const archiveReached = reached.some((category) => source.archiveCategories.includes(category));
      // The SOURCE's authority, never the core's: an archive reach by a subject
      // this source does not release its archive to is refused.
      if (archiveReached && !source.archiveReaders.has(String(claims.sub))) return this.refused(403, claims, 'archive not released to this subject');
      const asked = reached.filter((category) => source.categories.includes(category));
      if (this.misbehaveOnce) {
        this.misbehaveOnce = false;
        for (const category of source.archiveCategories) if (!asked.includes(category)) asked.push(category);
      }
      const echo = JSON.stringify(filter);
      const results = asked.map((category) => ({
        ref: KnowledgeSearchStubSource.ref(slug, category),
        title: `${slug} ${category}`,
        snippet: `filter=${echo}`,
        contentKind: 'docs',
        category,
        compartment: { id: source.compartmentId, label: 'stub' },
        score: 0.5,
      }));
      return { status: 200, body: JSON.stringify({ protocol_version: 2, results, retrieval: { status: 'complete', reasons: [] } }), claims, refusal: null };
    }

    // get
    const ref = String(body.ref ?? '');
    const issued = source.categories.find((category) => ref === KnowledgeSearchStubSource.ref(slug, category));
    if (!issued || body.compartment_id !== source.compartmentId) return this.refused(404, claims, 'unknown ref');
    const category = this.refiled.get(ref) ?? issued;
    const bytes = Buffer.from(`content of ${ref} (${category})\n`, 'utf8');
    return {
      status: 200,
      claims,
      refusal: null,
      body: JSON.stringify({
        protocol_version: 2,
        status: 'content',
        content_base64: bytes.toString('base64'),
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        offset: 0,
        byteLength: bytes.length,
        totalBytes: bytes.length,
        truncated: false,
        compartment: { id: source.compartmentId, label: 'stub' },
        contentKind: 'docs',
        category,
        retrieval: { status: 'complete', reasons: [] },
      }),
    };
  }
}
