/**
 * __tests__/support/knowledgeFixtureSource.ts — the hostile FIXTURE knowledge
 * source of KW1 acceptance (design `94747de9` §11, wave line "a FIXTURE source
 * exercising the full wire contract hostilely").
 *
 * Candidate A uses it for the OUTBOUND half: the fixture's REQUEST LOG is the
 * instrument behind every "with its log empty" clause of acceptance item 5. A
 * refusal that is only observed as a returned token proves the caller said no;
 * an EMPTY fixture log proves nothing was sent. Candidates B–D extend the
 * behaviours without re-opening the seam (breakdown `abc71ffb` §2, seam S1).
 *
 * The certificate is minted per run by `selfSignedCertificate.ts` and handed
 * to the dial client through its TEST-ONLY `trustAnchors` option (owner
 * decision D7(a)).
 */
import https from 'https';
import type { AddressInfo } from 'net';
import { generateSelfSignedCertificate, type SelfSignedCertificate } from './selfSignedCertificate';

export interface FixtureRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FixtureBehaviour {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Answer this many milliseconds late. Item 8's `timedOut` clause is about a
   * source that ANSWERS slowly, which is a different failure from one that
   * never accepts a connection.
   */
  delayMs?: number;
  /**
   * Demand core's channel credential (§4.2) before reading anything. A request
   * without exactly this `authorization` header is answered 401 and its BODY
   * IS NEVER PARSED — which is what item 2's "refused BEFORE the assertion is
   * read" asks a source to do.
   */
  requireBearer?: string;
}

export class KnowledgeFixtureSource {
  /**
   * The certificate's common name.
   *
   * It is a constructor argument because a suite running TWO fixtures hands
   * the dial client both certificates as trust anchors, and two self-signed
   * certificates sharing a subject/issuer name cannot both be verified out of
   * one store — the dial fails `connect-failed` with nothing wrong at either
   * end. The default preserves the single-fixture behaviour candidate A's
   * suite depends on.
   */
  constructor(private readonly commonName = 'kw1-knowledge-fixture') {}

  private server: https.Server | null = null;

  /** Every request that REACHED the fixture. The "log empty" instrument. */
  readonly requests: FixtureRequest[] = [];

  /**
   * Requests the fixture refused at the CHANNEL, before reading their body.
   * The instrument for "refused BEFORE the assertion is read": an entry here
   * carries no body, because the fixture never looked at one.
   */
  readonly channelRefusals: Array<{ method: string; url: string }> = [];

  /** What the fixture answers next. Set per drill. */
  behaviour: FixtureBehaviour = { status: 200, body: '{"results":[]}' };

  /**
   * Minted in `start()`, once the bind address is known, so the certificate
   * carries that address in its subjectAltName. Acceptance item 5's
   * allow-listed clause dials the fixture at a PRIVATE address, and a
   * certificate that only named loopback would fail identity verification
   * there for a reason that has nothing to do with the control under test.
   */
  certificate!: SelfSignedCertificate;

  port = 0;

  host = '127.0.0.1';

  /**
   * `host` is the address drills ADDRESS the fixture by; `bindAddress` is what
   * the listener binds. They differ deliberately: acceptance item 5 needs the
   * SAME fixture reachable both at loopback (to prove the unconditional
   * refusal, and to prove that removing it lets a dial through) and at a
   * private address (to prove the allow-list admits and refuses the same
   * host). One listener on the wildcard address serves both without a second
   * certificate or a second port.
   */
  async start(host = '127.0.0.1', bindAddress = '0.0.0.0'): Promise<void> {
    this.host = host;
    this.certificate = generateSelfSignedCertificate({
      commonName: this.commonName,
      dnsNames: ['localhost', 'kw1-fixture.invalid', 'rebind.example.invalid'],
      ipAddresses: [...new Set(['127.0.0.1', host])],
    });
    this.server = https.createServer(
      { cert: this.certificate.cert, key: this.certificate.key },
      (req, res) => {
        // §4.2's channel authentication, from the SOURCE's side: the header is
        // checked before a single byte of the body is consumed, so a caller
        // that cannot authenticate as core is refused before its assertion —
        // however valid — is read at all.
        const required = this.behaviour.requireBearer;
        if (required !== undefined && req.headers.authorization !== required) {
          this.channelRefusals.push({ method: req.method ?? '', url: req.url ?? '' });
          req.resume();
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{"refused":"channel"}');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          this.requests.push({
            method: req.method ?? '',
            url: req.url ?? '',
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
          const behaviour = this.behaviour;
          const answer = (): void => {
            res.writeHead(behaviour.status ?? 200, {
              'content-type': 'application/json',
              ...(behaviour.headers ?? {}),
            });
            res.end(behaviour.body ?? '{}');
          };
          if (behaviour.delayMs && behaviour.delayMs > 0) setTimeout(answer, behaviour.delayMs);
          else answer();
        });
      },
    );
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

  reset(): void {
    this.requests.length = 0;
    this.channelRefusals.length = 0;
    this.behaviour = { status: 200, body: '{"results":[]}' };
  }

  /** The literal-address URL. Loopback, so the policy must refuse it. */
  loopbackUrl(path = '/query'): string {
    return `https://127.0.0.1:${this.port}${path}`;
  }

  /** A NAME that resolves to loopback through the host resolver. */
  loopbackNameUrl(path = '/query'): string {
    return `https://localhost:${this.port}${path}`;
  }

  /** The address the fixture is actually bound to. */
  boundUrl(path = '/query'): string {
    return `https://${this.host}:${this.port}${path}`;
  }
}
