/**
 * The provider double for the §4.5(a) conformance gate.
 *
 * It substitutes for `SsoTransport` — the ONE seam through which the relying
 * party opens an outbound connection — so fixtures drive the real production
 * flow while this stands in for an Identity provider.
 *
 * ── IT RECORDS, IT DOES NOT ASSERT ──
 *
 * Every request the relying party makes is recorded verbatim: the URL dialled,
 * the method, the headers and the form. That is what lets a class assert
 * something **observed on the wire** rather than merely that a call succeeded —
 * shape class 8 asserts the client authentication form the provider RECEIVED
 * equals the one configured, and T-SS4 asserts the token endpoint dialled is
 * the pending row's provider's.
 *
 * The ID tokens it issues are REALLY SIGNED with a really generated key, and
 * the relying party really verifies them against the JWKS this double serves.
 * A double that returned a pre-agreed "valid" answer would make §5.3 vacuous
 * for every fixture that runs through it.
 */
import crypto from 'crypto';
import type { SsoOutboundRequest, SsoTransport } from '../../services/identity/ssoOutbound';

export interface RecordedRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  form: Record<string, string>;
}

/** The four §4.1 methods, as observed from the wire rather than declared. */
export type ObservedClientAuth = 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt' | 'none';

export interface RegisteredProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  kid: string;
  privateKey: crypto.KeyObject;
  publicJwk: crypto.JsonWebKey;
  /** The discovery document, mutable so a fixture can be hollowed. */
  document: Record<string, unknown>;
}

export interface RegisterProviderInput {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Merged over the defaults — this is how a fixture states its shape. */
  documentOverrides?: Record<string, unknown>;
}

export class ProviderDouble implements SsoTransport {
  readonly requests: RecordedRequest[] = [];
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly codes = new Map<string, { issuer: string; claims: Record<string, unknown> }>();

  register(input: RegisterProviderInput): RegisteredProvider {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = `kid-${crypto.randomBytes(6).toString('hex')}`;
    const base = input.issuer.replace(/\/+$/, '');
    const document: Record<string, unknown> = {
      issuer: input.issuer,
      // Endpoints live UNDER the issuer path, not under the host root. That is
      // what makes shape class 1 real: two providers on the same host resolve
      // to different endpoint sets because the DOCUMENT says so, and nothing
      // in the relying party templates them from the origin.
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      jwks_uri: `${base}/jwks`,
      userinfo_endpoint: `${base}/userinfo`,
      end_session_endpoint: `${base}/logout`,
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'private_key_jwt',
        'none',
      ],
      authorization_response_iss_parameter_supported: true,
      ...(input.documentOverrides ?? {}),
    };
    const registered: RegisteredProvider = {
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecret: input.clientSecret ?? 'conformance-secret',
      kid,
      privateKey,
      publicJwk: { ...(publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey), kid },
      document,
    };
    this.providers.set(input.issuer, registered);
    return registered;
  }

  get(issuer: string): RegisteredProvider {
    const found = this.providers.get(issuer);
    if (!found) throw new Error(`the provider double has no provider registered for ${issuer}`);
    return found;
  }

  /** Arm an authorization code with the claims its ID token will carry. */
  issueCode(issuer: string, claims: Record<string, unknown>): string {
    const code = `code-${crypto.randomBytes(12).toString('hex')}`;
    this.codes.set(code, { issuer, claims });
    return code;
  }

  /** Mint a genuinely signed compact JWS for this provider's key. */
  signIdToken(issuer: string, claims: Record<string, unknown>): string {
    const provider = this.get(issuer);
    const header = { alg: 'RS256', typ: 'JWT', kid: provider.kid };
    const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const signingInput = `${b64(header)}.${b64(claims)}`;
    const signature = crypto.sign('sha256', Buffer.from(signingInput), {
      key: provider.privateKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    });
    return `${signingInput}.${signature.toString('base64url')}`;
  }

  /** Forget the request log between fixtures, so assertions cannot bleed. */
  resetRequests(): void {
    this.requests.length = 0;
  }

  /** Which URLs were dialled, in order. */
  dialled(): string[] {
    return this.requests.map((request) => request.url);
  }

  /** The client authentication form the LAST token request actually carried. */
  observedClientAuth(): ObservedClientAuth | null {
    const tokenRequests = this.requests.filter((request) => request.url.endsWith('/token'));
    const last = tokenRequests[tokenRequests.length - 1];
    if (!last) return null;
    const authorization = last.headers.Authorization ?? last.headers.authorization ?? '';
    if (authorization.startsWith('Basic ')) return 'client_secret_basic';
    if (last.form.client_assertion) return 'private_key_jwt';
    if (last.form.client_secret) return 'client_secret_post';
    return 'none';
  }

  async send(request: SsoOutboundRequest): Promise<unknown> {
    const url = request.url.toString();
    this.requests.push({
      url,
      method: request.method,
      headers: { ...(request.headers ?? {}) },
      form: { ...(request.form ?? {}) },
    });

    if (url.endsWith('/.well-known/openid-configuration')) {
      const issuer = url.replace('/.well-known/openid-configuration', '');
      return this.get(issuer).document;
    }
    for (const provider of this.providers.values()) {
      if (url === String(provider.document.jwks_uri)) return { keys: [provider.publicJwk] };
      if (url === String(provider.document.token_endpoint)) return this.tokenResponse(provider, request);
      if (url === String(provider.document.userinfo_endpoint)) {
        // Refusal 11's input. The subject is echoed from the code that was
        // exchanged, so a mismatch is expressible by a fixture that wants one.
        const armed = this.lastExchanged;
        return { sub: armed?.claims.sub ?? 'unknown-subject' };
      }
    }
    throw new Error(`the provider double was dialled at an unregistered URL: ${url}`);
  }

  private lastExchanged: { issuer: string; claims: Record<string, unknown> } | undefined;

  private tokenResponse(provider: RegisteredProvider, request: SsoOutboundRequest): unknown {
    const code = request.form?.code;
    if (!code) throw new Error('the token request carried no code');
    const armed = this.codes.get(code);
    if (!armed) throw new Error(`the token request carried an unknown code: ${code}`);
    // T-SS4's on-the-wire assertion depends on this: a code armed for provider
    // A must not be redeemable at provider B's token endpoint.
    if (armed.issuer !== provider.issuer) {
      throw new Error(`code armed for ${armed.issuer} was redeemed at ${provider.issuer}`);
    }
    this.codes.delete(code);
    this.lastExchanged = armed;
    return {
      id_token: this.signIdToken(provider.issuer, armed.claims),
      access_token: `at-${crypto.randomBytes(8).toString('hex')}`,
      token_type: 'Bearer',
    };
  }
}
