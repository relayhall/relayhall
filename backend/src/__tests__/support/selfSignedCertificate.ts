/**
 * __tests__/support/selfSignedCertificate.ts — a self-signed X.509 certificate
 * generated IN THE TEST PROCESS, for RH-KW1's hostile FIXTURE source.
 *
 * WHY THIS EXISTS RATHER THAN A COMMITTED PEM. Owner decision D7(a) wants "a
 * test-only CA supplied by the harness". A committed key pair would be a
 * private key in a repository with a publication allowlist — the wrong shape
 * of artefact regardless of what it protects — and a certificate with a fixed
 * validity window is a test that starts failing on a date nobody chose. This
 * mints a fresh Ed25519 self-signed certificate per run, so the anchor exists
 * only in memory, only while the fixture is up.
 *
 * WHY ED25519. Owner decision D4(a) is zero new packages, so the certificate
 * has to be assembled from `node:crypto` alone. Ed25519 makes that small: the
 * SPKI is exported whole by `crypto`, the AlgorithmIdentifier carries no
 * parameters, and the signature is one `crypto.sign(null, ...)` call — no
 * digest negotiation, no RSA parameter encoding.
 *
 * The DER writer below is deliberately minimal: exactly the structures a
 * self-signed leaf-and-anchor needs, and nothing that would tempt a future
 * reader to treat this as a general certificate library.
 */
import crypto from 'crypto';

// ── minimal DER ──────────────────────────────────────────────────────────

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), len(value.length), value]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const bool = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const octets = (value: Buffer): Buffer => tlv(0x04, value);
const utf8 = (value: string): Buffer => tlv(0x0c, Buffer.from(value, 'utf8'));
const explicitTag = (n: number, value: Buffer): Buffer => tlv(0xa0 | n, value);

function integer(value: Buffer): Buffer {
  let v = value;
  while (v.length > 1 && v[0] === 0x00 && (v[1] & 0x80) === 0) v = v.subarray(1);
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v]);
  return tlv(0x02, v);
}

function bitString(value: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), value]));
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const body: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunks: number[] = [];
    let v = part;
    do {
      chunks.unshift(v & 0x7f);
      v >>= 7;
    } while (v > 0);
    for (let i = 0; i < chunks.length - 1; i += 1) chunks[i] |= 0x80;
    body.push(...chunks);
  }
  return tlv(0x06, Buffer.from(body));
}

function utcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, '0');
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

// ── the certificate ──────────────────────────────────────────────────────

const OID_ED25519 = '1.3.101.112';
const OID_COMMON_NAME = '2.5.4.3';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';

export interface SelfSignedCertificate {
  /** PEM certificate, usable as both the server cert and the trust anchor. */
  cert: string;
  /** PEM PKCS#8 private key. Never leaves the test process. */
  key: string;
}

function generalNames(dnsNames: string[], ipAddresses: string[]): Buffer {
  const entries: Buffer[] = [];
  for (const name of dnsNames) entries.push(tlv(0x82, Buffer.from(name, 'ascii')));
  for (const address of ipAddresses) {
    entries.push(tlv(0x87, Buffer.from(address.split('.').map(Number))));
  }
  return seq(...entries);
}

/**
 * Mint a self-signed Ed25519 certificate valid from an hour ago for a day.
 * `CA:TRUE` and `keyCertSign` are set so the same certificate can be handed
 * to the dial client as a trust anchor — that IS the D7 seam being exercised.
 */
export function generateSelfSignedCertificate(options: {
  commonName: string;
  dnsNames?: string[];
  ipAddresses?: string[];
}): SelfSignedCertificate {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

  const algorithm = seq(oid(OID_ED25519));
  const name = seq(set(seq(oid(OID_COMMON_NAME), utf8(options.commonName))));
  const now = Date.now();
  const validity = seq(
    utcTime(new Date(now - 3600_000)),
    utcTime(new Date(now + 86_400_000)),
  );

  const extensions = explicitTag(3, seq(
    seq(oid(OID_BASIC_CONSTRAINTS), bool(true), octets(seq(bool(true)))),
    // digitalSignature (bit 0) + keyCertSign (bit 5) => 0b10000100, 2 unused.
    seq(oid(OID_KEY_USAGE), bool(true), octets(bitString(Buffer.from([0x84]), 2))),
    seq(
      oid(OID_SUBJECT_ALT_NAME),
      octets(generalNames(options.dnsNames ?? [], options.ipAddresses ?? [])),
    ),
  ));

  const tbs = seq(
    explicitTag(0, integer(Buffer.from([0x02]))), // v3
    integer(crypto.randomBytes(8)),
    algorithm,
    name,
    validity,
    name,
    spki,
    extensions,
  );

  const signature = crypto.sign(null, tbs, privateKey);
  const certificate = seq(tbs, algorithm, bitString(signature));

  const pem = (label: string, der: Buffer) =>
    `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END ${label}-----\n`;

  return {
    cert: pem('CERTIFICATE', certificate),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}
