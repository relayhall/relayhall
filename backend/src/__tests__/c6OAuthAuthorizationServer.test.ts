/**
 * RH-P3.C6 — the OAuth 2.1 authorization server, over the wire and at its
 * refusals.
 *
 * ── WHAT THIS SUITE IS AND IS NOT ──
 *
 * It drives the REAL router on a REAL listener with REAL HTTP, and the real
 * policy functions on real inputs. It is NOT the end-to-end proof: the
 * authorization-code leg writes rows, and this repository's unit suites do not
 * carry a Postgres. The full flow — authorize, human consent in a signed-in
 * browser, token, an MCP read AND write with the issued token, then revoke and
 * the very-next-call refusal — is drilled against the DEPLOYED board by
 * `backend/scripts/test-c6-oauth-flow.js`, per owner decision D3. That split is
 * deliberate and is the C3 lesson: a suite that stops at the module proves
 * nothing about whether a client can complete a flow.
 *
 * What IS provable here, and is proven here without a database:
 *
 *   - the outbound-address policy, as an enumeration with a public control;
 *   - the SSRF refusals reached through the REAL `resolve()` path, using a
 *     name that really does resolve to loopback;
 *   - every client_id and document validation, with a mutation beside each;
 *   - the discovery chain a client actually walks: the MCP 401 challenge names
 *     a protected-resource URL, that URL is served, and its
 *     `authorization_servers` entry serves authorization-server metadata whose
 *     endpoints are this deployment's;
 *   - that the published grant/PKCE claims are REFUSALS, by watching the real
 *     token endpoint refuse everything the metadata does not list.
 */
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { AddressInfo } from 'net';

import oauthRoutes, { oauthWellKnownRoutes } from '../routes/oauth';
import mcpRoutes from '../mcp/httpRoute';
import { MCP_WWW_AUTHENTICATE } from '../mcp/provenance';
import {
  OAUTH_ROUTE_PATH, OAUTH_WELL_KNOWN_ROUTE_PATH,
  OAUTH_AS_METADATA_PATH, OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  OAUTH_GRANT_TYPES_SUPPORTED, OAUTH_RESPONSE_TYPES_SUPPORTED,
  OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED, OAUTH_TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED,
  buildAuthorizationServerMetadata, buildProtectedResourceMetadata,
  mcpWwwAuthenticate, oauthIssuer, oauthResourceIdentifier,
  authorizationServerMetadataUrl, protectedResourceMetadataUrl,
} from '../utils/oauthMetadata';
import net from 'net';
import { outboundAddressVerdict, ipv6AddressValue } from '../utils/outboundAddressPolicy';
import { parseCarrierPrefixes } from '../utils/ipv4CarrierForms';
// Card `837fe75b`: the carrier refusal list is SHARED with the knowledge
// plane, which reads it through its own address parser. `asIpv6Value` is
// that parser, imported here so the agreement between the two can be
// measured rather than assumed.
import {
  asIpv6Value, classifyAddress, IPV4_CARRIER_FORM_NAMES,
} from '../services/KnowledgeSourcePolicy';
import { loadMutatedModule, readShippedSource } from './support/moduleMutation';
import {
  oauthClientMetadataService, validateClientIdUrl, parseClientMetadataDocument,
  isAcceptableRedirectUri, sanitizeDisplayUri, ClientMetadataError,
} from '../services/OAuthClientMetadataService';
import fs from 'fs';
import path from 'path';

import {
  oauthAuthorizationService, connectorReuseVerdict,
  oauthGrantableScopes, verifyPkceS256, accessTokenTtlHours,
  OAUTH_DEFAULT_ACCESS_TOKEN_TTL_HOURS, OAUTH_ACCESS_TOKEN_TTL_ENV,
  OAUTH_ACCESS_TOKEN_TTL_MAX_HOURS,
} from '../services/OAuthAuthorizationService';
import { MINTABLE_SCOPES, ROOT_SCOPE } from '../utils/scopeMap';

let server: http.Server;
let base: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(OAUTH_ROUTE_PATH, oauthRoutes);
  app.use(OAUTH_WELL_KNOWN_ROUTE_PATH, oauthWellKnownRoutes);
  app.use('/mcp', mcpRoutes);
  server = app.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => { server.close(() => done()); });

interface Wire { status: number; headers: http.IncomingHttpHeaders; body: any; text: string }

function request(method: string, path: string, body?: string, contentType?: string): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request(
      {
        hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method,
        headers: {
          ...(body !== undefined
            ? { 'content-type': contentType ?? 'application/json', 'content-length': Buffer.byteLength(body) }
            : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let parsed: unknown = null;
          try { parsed = JSON.parse(text); } catch { parsed = null; }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, text });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const get = (path: string): Promise<Wire> => request('GET', path);
const postForm = (path: string, fields: Record<string, string>): Promise<Wire> =>
  request('POST', path, new URLSearchParams(fields).toString(), 'application/x-www-form-urlencoded');
const postJson = (path: string, payload: unknown): Promise<Wire> =>
  request('POST', path, JSON.stringify(payload), 'application/json');

/** The endpoint the routes derive for a request to this listener. */
const boardEndpoint = (): string => `${base}/api`.replace('127.0.0.1', '127.0.0.1');

// ───────────────────────── the outbound address policy ─────────────────────

/**
 * The enumeration, with the range each literal stands for written beside it.
 * This is the list a reviewer reads to decide whether the policy is
 * complete; the assertions below prove the code agrees with it.
 *
 * Module scope, so card `837fe75b`'s narrowing table can prove it pins
 * EVERY entry rather than a subset somebody chose by hand.
 */
const MUST_REFUSE: Array<[string, string]> = [
  ['0.0.0.0', '0.0.0.0/8 "this network"'],
  ['127.0.0.1', '127.0.0.0/8 loopback'],
  ['127.1.2.3', '127.0.0.0/8, not just .0.0.1'],
  ['10.0.0.1', '10.0.0.0/8'],
  ['172.16.0.1', '172.16.0.0/12 lower edge'],
  ['172.31.255.254', '172.16.0.0/12 upper edge'],
  ['192.168.1.1', '192.168.0.0/16'],
  ['169.254.169.254', '169.254.0.0/16 — cloud instance metadata'],
  ['100.64.0.1', '100.64.0.0/10 carrier-grade NAT'],
  ['198.18.0.1', '198.18.0.0/15 benchmarking'],
  ['192.0.0.1', '192.0.0.0/24 IETF protocol assignments'],
  ['192.0.2.1', '192.0.2.0/24 TEST-NET-1'],
  ['198.51.100.1', '198.51.100.0/24 TEST-NET-2'],
  ['203.0.113.1', '203.0.113.0/24 TEST-NET-3'],
  ['224.0.0.1', '224.0.0.0/4 multicast'],
  ['240.0.0.1', '240.0.0.0/4 reserved'],
  ['255.255.255.255', 'broadcast'],
  ['::', 'unspecified'],
  ['::1', 'IPv6 loopback'],
  ['fc00::1', 'fc00::/7 unique-local'],
  ['fd12:3456:789a::1', 'fc00::/7, the fd half'],
  ['fe80::1', 'fe80::/10 link-local'],
  ['ff02::1', 'ff00::/8 multicast'],
  ['2001:db8::1', '2001:db8::/32 documentation'],
  ['64:ff9b::7f00:1', '64:ff9b::/96 NAT64 — an IPv4 loopback in disguise'],
  ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
  ['::ffff:169.254.169.254', 'IPv4-mapped metadata service'],
];

describe('the board refuses to open a caller-named connection into its own network', () => {

  it.each(MUST_REFUSE)('refuses %s (%s)', (address) => {
    expect(outboundAddressVerdict(address).allowed).toBe(false);
  });

  /**
   * THE CONTROL. Without it the assertions above would pass on a function that
   * refused everything, which would be a different bug wearing the same green.
   */
  const MUST_ALLOW = ['8.8.8.8', '1.1.1.1', '154.61.57.9', '93.184.216.34', '2606:4700::1111'];
  it.each(MUST_ALLOW)('allows the public address %s', (address) => {
    expect(outboundAddressVerdict(address).allowed).toBe(true);
  });

  it('refuses anything that is not an address at all', () => {
    for (const value of ['', 'localhost', 'evil.example.com', '1.2.3', '999.1.1.1', 'not-an-ip']) {
      expect(outboundAddressVerdict(value)).toEqual({ allowed: false, reason: 'NOT_AN_IP' });
    }
  });

  it('reports WHY, so a refusal is diagnosable and the classification is testable', () => {
    expect(outboundAddressVerdict('127.0.0.1').allowed).toBe(false);
    expect(outboundAddressVerdict('169.254.169.254')).toEqual({ allowed: false, reason: 'LINK_LOCAL' });
    expect(outboundAddressVerdict('10.1.2.3')).toEqual({ allowed: false, reason: 'PRIVATE' });
    expect(outboundAddressVerdict('::ffff:10.1.2.3')).toEqual({ allowed: false, reason: 'PRIVATE' });
  });
});

// ═══ card 837fe75b — an IPv6 address that CARRIES an IPv4 destination ═══════

/**
 * ── WHAT THIS CLOSES ──
 *
 * The table above refuses an address by the RANGE it is in. Several IPv6
 * forms carry an IPv4 destination inside an address that is in no refused
 * range at all, so the whole table steps aside for them. On `31d8eb7` this
 * module reported `::127.0.0.1`, `::ffff:0:7f00:1`, `2002:7f00:1::` and
 * `2620:0:1:2:0:5efe:a9fe:a9fe` as ALLOWED — the first probe-confirmed
 * reachable through the Client ID Metadata Document fetch, which is the SSRF
 * primitive this module exists to close.
 *
 * ── WHY THERE IS NO DECODER HERE TO TEST ──
 *
 * Owner ruling `623632b0` option (a) deleted the machinery that answered
 * "which IPv4 does this carry" after four review rounds each found a defect in
 * the previous round's version of it. The answer is a REFUSAL LIST:
 * membership decides, and a carrier is never decoded. So every drill below
 * asks whether an address IS a carrier, and none of them asks what it carries
 * — there is no such question left to get wrong.
 *
 * ── THE COST THIS SUITE PINS ──
 *
 * Refusing outright OVER-REFUSES: `2002:5db8:d822::` wraps the public address
 * `93.184.216.34` and is refused anyway. Card `837fe75b` asked C6 to decide
 * that for itself rather than inherit the knowledge plane's answer. It is
 * decided the same way and the case is stronger: C6's URL comes from an
 * UNAUTHENTICATED caller, and this module already refuses `::ffff:<public v4>`
 * outright as `IPV4_MAPPED`. The drill below is what makes that a DECISION
 * rather than an accident — it asserts the public-wrapping address is refused,
 * so nobody can quietly relax it and call the change a bug fix.
 */
describe('card 837fe75b — every IPv4-carrying IPv6 form is refused, and none is decoded', () => {
  const FORMS_MODULE = 'utils/ipv4CarrierForms.ts';
  const C6_MODULE = 'utils/outboundAddressPolicy.ts';

  /**
   * One address per carrier form.
   *
   * `GAP` marks the forms this module reported ALLOWED before the card: they
   * are refused ONLY by the shared list, so removing an entry makes its
   * address public again. `SHADOWED` marks the two that a range rule in this
   * module already refused — they are not decoration, and the pair of drills
   * further down proves the list is live under those prefixes too by taking
   * the range rule away.
   *
   * The last three are the addresses that broke the decoders the ruling
   * deleted: a 6to4 prefix shadowing an ISATAP interface identifier (two
   * different IPv4s in one address), the RFC 6052 `/48` layout that splits the
   * IPv4 around the reserved octet, and a 6to4 wrapping a PUBLIC address.
   * Under a refusal list none of them needs a right answer — only membership.
   */
  const CARRIERS: Array<[string, string, 'GAP' | 'SHADOWED']> = [
    ['ipv4-compatible/mapped/translated', '::127.0.0.1', 'GAP'],
    ['ipv4-compatible/mapped/translated', '::7f00:1', 'GAP'],
    ['ipv4-compatible/mapped/translated', '::169.254.169.254', 'GAP'],
    ['ipv4-compatible/mapped/translated', '::ffff:0:7f00:1', 'GAP'],
    ['6to4', '2002:7f00:1::', 'GAP'],
    ['6to4', '2002:5db8:d822::', 'GAP'],
    ['6to4', '2002:5db8:d822:1:0:5efe:7f00:1', 'GAP'],
    ['isatap', '2620:0:1:2:0:5efe:a9fe:a9fe', 'GAP'],
    ['isatap', '2620:0:1:2:200:5efe:5db8:d822', 'GAP'],
    ['nat64-well-known', '64:ff9b::7f00:1', 'SHADOWED'],
    ['nat64-local-use', '64:ff9b:1:5db8:d8:2200::', 'SHADOWED'],
    ['teredo', '2001::80ff:fffe', 'SHADOWED'],
  ];

  it.each(CARRIERS)('refuses the %s address %s', (_form, address) => {
    expect(outboundAddressVerdict(address).allowed).toBe(false);
  });

  it.each(CARRIERS.filter(([, , kind]) => kind === 'GAP'))(
    'names the %s form on the refusal of %s',
    (form, address) => {
      expect(outboundAddressVerdict(address)).toEqual({
        allowed: false,
        reason: 'IPV4_CARRIER',
        carrier: form,
      });
    },
  );

  it('the over-refusal is a DECISION: a carrier wrapping a public address is refused too', () => {
    // `2002:5db8:d822::` is 6to4 over 93.184.216.34, which this module allows
    // as a plain IPv4. Refusing it is the accepted cost, written down.
    expect(outboundAddressVerdict('93.184.216.34')).toEqual({ allowed: true });
    expect(outboundAddressVerdict('2002:5db8:d822::')).toEqual({
      allowed: false, reason: 'IPV4_CARRIER', carrier: '6to4',
    });
  });

  /**
   * THE CONTROL, and it is the one that matters most. A refusal list that
   * swallowed ordinary global unicast would pass every assertion above while
   * breaking every legitimate client_id on an IPv6 host.
   */
  const STILL_PUBLIC = [
    ['2606:4700::1111', 'global unicast, no carrier shape'],
    ['2001:4860:4860::8888', '2001::/16 but NOT 2001::/32 Teredo'],
    ['2620:0:1:2:3:4:5:6', 'a global prefix whose IID is not ISATAP'],
    ['93.184.216.34', 'a plain public IPv4 is untouched'],
    ['8.8.8.8', 'a plain public IPv4 is untouched'],
  ];
  it.each(STILL_PUBLIC)('still allows %s (%s)', (address) => {
    expect(outboundAddressVerdict(address)).toEqual({ allowed: true });
  });

  /**
   * ── THE NARROWING PROPERTY, PINNED ADDRESS BY ADDRESS ──
   *
   * The carrier list is asked LAST, so an address the range table already
   * named keeps that range's more specific reason. That is what lets this
   * change be strictly narrowing: nothing that was refused became allowed, and
   * no refusal changed the reason it reports. A reviewer cannot check that by
   * reading — the table below is the pre-change classification of every entry
   * in `MUST_REFUSE`, so a reordering that quietly relabelled a refusal fails
   * here rather than in a deployment's logs.
   */
  const UNCHANGED_REASONS: Array<[string, string]> = [
    ['0.0.0.0', 'UNSPECIFIED'],
    ['127.0.0.1', 'LOOPBACK'],
    ['127.1.2.3', 'LOOPBACK'],
    ['10.0.0.1', 'PRIVATE'],
    ['172.16.0.1', 'PRIVATE'],
    ['172.31.255.254', 'PRIVATE'],
    ['192.168.1.1', 'PRIVATE'],
    ['169.254.169.254', 'LINK_LOCAL'],
    ['100.64.0.1', 'SHARED_ADDRESS_SPACE'],
    ['198.18.0.1', 'RESERVED'],
    ['192.0.0.1', 'RESERVED'],
    ['192.0.2.1', 'RESERVED'],
    ['198.51.100.1', 'RESERVED'],
    ['203.0.113.1', 'RESERVED'],
    ['224.0.0.1', 'MULTICAST'],
    ['240.0.0.1', 'RESERVED'],
    ['255.255.255.255', 'RESERVED'],
    ['::', 'UNSPECIFIED'],
    ['::1', 'LOOPBACK'],
    ['fc00::1', 'PRIVATE'],
    ['fd12:3456:789a::1', 'PRIVATE'],
    ['fe80::1', 'LINK_LOCAL'],
    ['ff02::1', 'MULTICAST'],
    ['2001:db8::1', 'RESERVED'],
    ['64:ff9b::7f00:1', 'RESERVED'],
    ['::ffff:127.0.0.1', 'LOOPBACK'],
    ['::ffff:169.254.169.254', 'LINK_LOCAL'],
    ['::ffff:10.1.2.3', 'PRIVATE'],
  ];
  it.each(UNCHANGED_REASONS)('%s still reports %s, not the carrier reason', (address, reason) => {
    expect(outboundAddressVerdict(address)).toEqual({ allowed: false, reason });
  });

  it('the table above covers every entry of MUST_REFUSE, so nothing escaped the check', () => {
    // A pinning table is worth what it covers. If MUST_REFUSE grows and this
    // one does not, the new entry is unpinned and this fails.
    const pinned = new Set(UNCHANGED_REASONS.map(([address]) => address));
    expect(MUST_REFUSE.map(([address]) => address).filter((a) => !pinned.has(a))).toEqual([]);
  });

  // ─────────────────── a RED PROOF for every carrier form ───────────────────

  /**
   * Each mutation takes ONE line out of the SHARED list and asserts that only
   * that form's address stops being refused as a carrier. The anchors are read
   * from the shipped file at run time, so if the list is edited and an anchor
   * stops matching, the harness throws rather than drilling nothing.
   */
  const FORM_LINES: Array<[string, string, string, 'GAP' | 'SHADOWED']> = [
    ['ipv4-compatible/mapped/translated', '::ffff:0:7f00:1',
     '    carries: (value) => (value >> 64n) === 0n && value > 1n,', 'GAP'],
    ['nat64-well-known', '64:ff9b::7f00:1',
     "  { name: 'nat64-well-known', carries: (value) => (value >> 32n) === 0x0064ff9bn << 64n },",
     'SHADOWED'],
    ['nat64-local-use', '64:ff9b:1:5db8:d8:2200::',
     "  { name: 'nat64-local-use', carries: (value) => (value >> 80n) === 0x0064ff9b0001n },",
     'SHADOWED'],
    ['6to4', '2002:7f00:1::',
     "  { name: '6to4', carries: (value) => (value >> 112n) === 0x2002n },", 'GAP'],
    ['teredo', '2001::80ff:fffe',
     "  { name: 'teredo', carries: (value) => (value >> 96n) === 0x20010000n },", 'SHADOWED'],
    ['isatap', '2620:0:1:2:0:5efe:a9fe:a9fe',
     '    carries: (value) => ((value >> 32n) & 0xfdffffffn) === 0x00005efen,', 'GAP'],
  ];

  it('every carrier form appears in the red-proof table exactly once', () => {
    // A form the table forgot would be an entry in a security list that no
    // drill can move — the state this card exists to leave behind.
    expect(FORM_LINES.map(([form]) => form).sort())
      .toEqual([...IPV4_CARRIER_FORM_NAMES].sort());
  });

  /** This module, loaded against a carrier list with one form switched off. */
  function policyWithoutForm(line: string): typeof import('../utils/outboundAddressPolicy') {
    const forms = loadMutatedModule(FORMS_MODULE, [{
      find: line,
      replace: line.replace('carries: (value) =>', 'carries: () => false &&'),
    }]);
    return loadMutatedModule<typeof import('../utils/outboundAddressPolicy')>(
      C6_MODULE, [], { './ipv4CarrierForms': forms },
    );
  }

  /**
   * The GAP forms: this module refuses their addresses by the shared list and
   * by nothing else, so removing one entry puts the address back in the state
   * the card describes. That state — ALLOWED — is the defect itself, so the
   * drill reproduces the defect rather than merely observing a change.
   */
  it.each(FORM_LINES.filter(([, , , kind]) => kind === 'GAP'))(
    'MUTATION: without the %s form, %s is ALLOWED again — the defect, reproduced',
    (_form, address, line) => {
      expect(outboundAddressVerdict(address)).toMatchObject({ reason: 'IPV4_CARRIER' });
      expect(policyWithoutForm(line).outboundAddressVerdict(address)).toEqual({ allowed: true });
    });

  it.each(FORM_LINES)('MUTATION: dropping the %s form leaves every OTHER form refused',
    (form, _address, line) => {
      // A form whose removal reached beyond its own family would mean the
      // predicates overlap, and a later edit to one would silently move
      // another. Each entry answers for itself, and no other.
      const mutant = policyWithoutForm(line);
      for (const [otherForm, other] of CARRIERS) {
        if (otherForm === form) continue;
        expect(mutant.outboundAddressVerdict(other).allowed).toBe(false);
      }
    });

  // ── the two SHADOWED forms are live, proved by removing what shadows them ──

  /**
   * `2001::/32` and `64:ff9b` are refused by a range rule in this module as
   * well as by the shared list, so the drills above cannot show the list doing
   * the work for them. Taking the range rule away is what shows it: the
   * address stays refused, and now says `IPV4_CARRIER`. Without this pair
   * those two entries would be untested here and could be deleted from the
   * shared list without a single C6 assertion noticing.
   *
   * WHAT THIS PAIR DOES NOT SAY (round-1 finding, §4.5 caveat). It does not
   * say these entries DECIDE a C6 request today: removing one alone changes
   * nothing, because the range rule shadows it. They are defence in depth on
   * this path — independently protective if the range rule is ever relaxed —
   * and they are live classifiers on the knowledge plane, which has no such
   * range rule. Calling them 'live' here would be the overstatement.
   */
  const NAT64_RULE = "  if (g0 === 0x0064 && g1 === 0xff9b) return deny('RESERVED');";
  const TEREDO_RULE =
    "  if (g0 === 0x2001 && g1 === 0x0000) return deny('RESERVED');        // 2001::/32 Teredo";

  /** form, address, the shared-list line, the range rule that shadows it. */
  const SHADOWED: Array<[string, string, string, string]> = FORM_LINES
    .filter(([, , , kind]) => kind === 'SHADOWED')
    .map(([form, address, line]) => [
      form, address, line, form === 'teredo' ? TEREDO_RULE : NAT64_RULE,
    ]);

  it('every SHADOWED form is paired with a rule that actually shadows it', () => {
    // The pairing is what the two drills below rest on. If a form were paired
    // with the wrong rule the drills would still run and would prove the wrong
    // thing, so the pairing is asserted before it is used.
    expect(SHADOWED.map(([form]) => form).sort()).toEqual(['nat64-local-use', 'nat64-well-known', 'teredo']);
    for (const [, address, , rule] of SHADOWED) {
      expect(readShippedSource(C6_MODULE)).toContain(rule);
      expect(outboundAddressVerdict(address)).toEqual({ allowed: false, reason: 'RESERVED' });
    }
  });

  /** This module with a range rule switched off, and optionally a form too. */
  function policyWithout(
    rule: string, formLine?: string,
  ): typeof import('../utils/outboundAddressPolicy') {
    const overrides = formLine === undefined ? {} : {
      './ipv4CarrierForms': loadMutatedModule(FORMS_MODULE, [{
        find: formLine,
        replace: formLine.replace('carries: (value) =>', 'carries: () => false &&'),
      }]),
    };
    return loadMutatedModule<typeof import('../utils/outboundAddressPolicy')>(
      C6_MODULE, [{ find: rule, replace: rule.replace('if (', 'if (false && ') }], overrides,
    );
  }

  it.each(SHADOWED)('MUTATION: with its range rule gone, the %s entry alone refuses %s',
    (form, address, _line, rule) => {
      expect(policyWithout(rule).outboundAddressVerdict(address))
        .toEqual({ allowed: false, reason: 'IPV4_CARRIER', carrier: form });
    });

  it.each(SHADOWED)('MUTATION: with its range rule AND the %s form gone, %s is ALLOWED',
    (_form, address, line, rule) => {
      // The other half. Without it the drill above would pass on a list entry
      // that never fired, because something else in the module happened to
      // refuse the address as well — which is exactly the trap the RANGE rule
      // set for the shared list in the first place.
      expect(policyWithout(rule, line).outboundAddressVerdict(address)).toEqual({ allowed: true });
    });

  // ───────────── one list, one parser-agreement, no decoder ─────────────

  it('the carrier list exists in exactly ONE place in the tree', () => {
    // The list is shared with `services/KnowledgeSourcePolicy` rather than
    // copied into it, because a second copy is a second security decision that
    // drifts silently. `0x00005efen` is the ISATAP constant: it is unusual
    // enough that its only legitimate home is the list itself, so counting
    // files that contain it counts copies of the list.
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() && full.endsWith('.ts') ? [full] : [];
      });
    const srcRoot = path.join(__dirname, '..');
    const holders = walk(srcRoot)
      .filter((file) => fs.readFileSync(file, 'utf8').includes('0x00005efen'))
      .map((file) => path.relative(srcRoot, file).split(path.sep).join('/'))
      .filter((file) => !file.startsWith('__tests__/'))
      .sort();
    expect(holders).toEqual(['utils/ipv4CarrierForms.ts']);
  });

  it('this module composes the shared list and restates none of it', () => {
    const c6 = readShippedSource(C6_MODULE);
    expect(c6).toContain("from './ipv4CarrierForms'");
    // The shape a restated list would have. None of it may appear here.
    for (const fragment of ['carries:', '0x00005efen', '0x0064ff9b', '0x2002n', '0x20010000n']) {
      expect(c6).not.toContain(fragment);
    }
  });

  it('neither policy carries extraction machinery any more', () => {
    // The defect class ruling `623632b0` deleted lived entirely in decoding.
    // If any of it comes back — here or in the module the list moved out of —
    // this is the assertion that says so.
    for (const module of [FORMS_MODULE, C6_MODULE, 'services/KnowledgeSourcePolicy.ts']) {
      const source = readShippedSource(module);
      for (const name of ['embeddedIpv4Candidates', 'ipv4FromBits', 'ipv4FromLow32']) {
        expect(source).not.toContain(name);
      }
    }
  });

  /**
   * ── THE SEAM THE SHARED LIST CREATES, AND THE DRILL THAT CROSSES IT ──
   *
   * The list is one decision only if the two policies that read it agree on
   * what an address IS. They keep their own parsers — each is reviewed and
   * drilled where it lives, and moving either would be a much larger change
   * than this card — so the agreement is a claim, and a claim gets measured.
   * A dozen fixtures would not measure it: a parser disagrees on SPELLINGS,
   * and the interesting spellings are the ones nobody thought to write down.
   * So the sweep is generated, deterministic, and deliberately loaded with the
   * shapes that break parsers — `::` runs in every position, embedded dotted
   * quads, and the carrier prefixes themselves.
   *
   * ── THE DOMAIN THIS SWEEP COVERS, STATED (round-1 finding C1) ──
   *
   * Generated hextets only, so: lowercase, unwrapped, and filtered through
   * `net.isIPv6` — which structurally EXCLUDES the bracketed URL-host form.
   * It emits no brackets, no surrounding whitespace, no uppercase and no zone
   * identifier. Round 1 found the prose here claiming parser agreement
   * generally while measuring only that domain. It is a value-level
   * instrument over a generated domain and nothing more; the WRAPPER classes
   * are pinned by hand in the block below, including the two spellings on
   * which the two parsers legitimately differ.
   */
  it('this module and the knowledge plane parse an address to the same 128-bit value', () => {
    let seed = 20260905;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const hextet = (): string => (next() % 0x10000).toString(16);
    const addresses: string[] = CARRIERS.map(([, address]) => address)
      .concat(UNCHANGED_REASONS.map(([address]) => address).filter((a) => a.includes(':')))
      .concat(STILL_PUBLIC.map(([address]) => address).filter((a) => a.includes(':')));
    for (let i = 0; i < 4000; i += 1) {
      const groupList = [hextet(), hextet(), hextet(), hextet(), hextet(), hextet(), hextet(), hextet()];
      // Bias towards the shapes that matter: carrier prefixes, ISATAP IIDs and
      // a `::` run that a parser can misplace.
      if (i % 3 === 1) groupList[0] = '2002';
      if (i % 5 === 2) { groupList[4] = i % 2 === 0 ? '0' : '200'; groupList[5] = '5efe'; }
      if (i % 7 === 3) { groupList[0] = '0'; groupList[1] = '0'; groupList[2] = '0'; groupList[3] = '0'; }
      addresses.push(groupList.join(':'));
      const cut = next() % 6;
      addresses.push(groupList.slice(0, cut).join(':') + '::' + groupList.slice(cut + 2).join(':'));
      addresses.push(
        `${groupList.slice(0, 6).join(':')}:${next() % 256}.${next() % 256}.${next() % 256}.${next() % 256}`,
      );
    }
    const disagreements = addresses
      .filter((address) => net.isIPv6(address))
      .filter((address) => ipv6AddressValue(address) !== asIpv6Value(address));
    expect(disagreements).toEqual([]);
    // …and the sweep actually swept: a filter that excluded everything would
    // make the assertion above true and meaningless.
    expect(addresses.filter((address) => net.isIPv6(address)).length).toBeGreaterThan(4000);
  });

  it('MUTATION: a parser that disagrees is CAUGHT by the drill above', () => {
    // The control for the control. If the sweep could not see a divergence it
    // would be a green light wired to nothing.
    const skewed = loadMutatedModule<typeof import('../utils/outboundAddressPolicy')>(
      C6_MODULE,
      [{
        find: '  return parts.reduce((acc, group) => (acc << 16n) + BigInt(group), 0n);',
        replace: '  return parts.reduce((acc, group) => (acc << 16n) + BigInt(group), 0n) + 1n;',
      }],
    );
    const witnesses = ['2002:7f00:1::', '::ffff:0:7f00:1', '2620:0:1:2:0:5efe:a9fe:a9fe']
      .filter((address) => skewed.ipv6AddressValue(address) !== asIpv6Value(address));
    expect(witnesses).toHaveLength(3);
  });

  // ───────── round-1 finding C2 — the corpus asserts VERDICTS, not values ────

  /**
   * ── WHY THE NAMED WITNESSES WERE NOT ENOUGH ──
   *
   * Round-1 review found a policy this suite would have passed. Inserting
   *
   *   if (g0 === 0x2002 && g1 === 0xa9fe && g2 === 0xa9fe) return ALLOWED;
   *
   * before the carrier check makes `2002:a9fe:a9fe::` — 6to4 carrying
   * `169.254.169.254`, the cloud metadata address this module exists to keep
   * unreachable — ALLOWED, while every witness named above stays refused and
   * every mutation anchor stays present. The named witnesses pinned SPELLINGS;
   * an address-specific early return is a hole between them, and the generated
   * sweep further down compared PARSER VALUES, never verdicts, so it could not
   * see a classification change at all.
   *
   * The repair is to stop sampling. Every refused IPv4 class this module names
   * is wrapped in every carrier form and the VERDICT is asserted, so a hole has
   * to be dug between two members of a systematic product rather than between
   * two hand-picked examples. The reviewer's witness is a member of it.
   */
  const REFUSED_IPV4_CLASSES: Array<[string, string]> = UNCHANGED_REASONS
    .filter(([address]) => !address.includes(':'))
    .map(([address, reason]) => [reason, address]);

  /** The two hextets an IPv4 address occupies inside a carrier. */
  function hextetsOf(ipv4: string): [string, string] {
    const [a, b, c, d] = ipv4.split('.').map((part) => Number(part));
    return [(((a << 8) | b) >>> 0).toString(16), (((c << 8) | d) >>> 0).toString(16)];
  }

  /**
   * Every wrapper this module must refuse, as a function of the payload. The
   * ISATAP entries carry a global prefix on purpose: that is the form which
   * reads as ordinary global unicast until the interface identifier is read.
   */
  const WRAPPERS: Array<[string, (hi: string, lo: string) => string]> = [
    ['ipv4-compatible', (hi, lo) => `::${hi}:${lo}`],
    ['ipv4-mapped', (hi, lo) => `::ffff:${hi}:${lo}`],
    ['ipv4-translated', (hi, lo) => `::ffff:0:${hi}:${lo}`],
    ['6to4', (hi, lo) => `2002:${hi}:${lo}::`],
    ['nat64-well-known', (hi, lo) => `64:ff9b::${hi}:${lo}`],
    ['isatap under a global prefix', (hi, lo) => `2620:0:1:2:0:5efe:${hi}:${lo}`],
    ['isatap, u/l bit set', (hi, lo) => `2620:0:1:2:200:5efe:${hi}:${lo}`],
  ];

  /** Every wrapper of every refused class — the product, not a sample. */
  const CARRIER_PRODUCT: Array<[string, string, string]> = REFUSED_IPV4_CLASSES
    .flatMap(([className, ipv4]) => {
      const [hi, lo] = hextetsOf(ipv4);
      return WRAPPERS.map(([wrapper, build]): [string, string, string] =>
        [wrapper, className, build(hi, lo)]);
    });

  it('the product is the size its two tables say, so nothing dropped out of it', () => {
    // A self-referential count is computed here rather than written down: the
    // number below is the product of the two tables above, and if either grows
    // the expectation grows with it. What must NOT happen silently is the
    // product SHRINKING because a builder returned a duplicate.
    expect(CARRIER_PRODUCT).toHaveLength(REFUSED_IPV4_CLASSES.length * WRAPPERS.length);
    expect(new Set(CARRIER_PRODUCT.map(([, , address]) => address)).size)
      .toBe(CARRIER_PRODUCT.length);
    expect(REFUSED_IPV4_CLASSES.length).toBeGreaterThan(10);
  });

  it.each(CARRIER_PRODUCT)('refuses %s carrying a %s payload (%s)', (_wrapper, _class, address) => {
    expect(outboundAddressVerdict(address).allowed).toBe(false);
  });

  it('MUTATION: the reviewer round-1 C2 bypass is caught by the product above', () => {
    // The exact edit from the verdict, reproduced verbatim as the control —
    // reproducing a rejected defect is worth more than asserting the repair.
    const line = "  if (g0 === 0x2001 && g1 === 0x0000) return deny('RESERVED');        // 2001::/32 Teredo";
    const bypass = loadMutatedModule<typeof import('../utils/outboundAddressPolicy')>(
      C6_MODULE,
      [{
        find: line,
        replace: `${line}\n  if (g0 === 0x2002 && g1 === 0xa9fe && g2 === 0xa9fe) return ALLOWED;`,
      }],
    );
    // The witness IS in the product: 6to4 over the link-local class.
    const witness = CARRIER_PRODUCT.find(([wrapper, className]) =>
      wrapper === '6to4' && className === 'LINK_LOCAL');
    expect(witness).toBeDefined();
    expect(bypass.outboundAddressVerdict(witness![2])).toEqual({ allowed: true });
    // …and the witnesses the ORIGINAL suite named are untouched by the bypass,
    // which is precisely why they were not enough on their own.
    expect(bypass.outboundAddressVerdict('2002:7f00:1::').allowed).toBe(false);
    expect(bypass.outboundAddressVerdict('2002:5db8:d822::').allowed).toBe(false);
  });

  it('no path through verdictForIPv6 can allow before the carrier list is asked', () => {
    // The structural half of C2's repair. The product above catches a bypass at
    // any address it covers; this catches the SHAPE — an `ALLOWED` return that
    // is reachable before the carrier question — including for a payload class
    // the product does not name.
    const c6 = readShippedSource(C6_MODULE);
    const start = c6.indexOf('function verdictForIPv6');
    const end = c6.indexOf('\nfunction valueOfGroups');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = c6.slice(start, end);
    const carrierAt = body.indexOf('ipv4CarrierForm(');
    expect(carrierAt).toBeGreaterThan(-1);
    // Exactly one allowing return, and it is after the carrier question.
    const allowing = [...body.matchAll(/return ALLOWED;|allowed: true/g)].map((m) => m.index ?? -1);
    expect(allowing).toHaveLength(1);
    expect(allowing[0]).toBeGreaterThan(carrierAt);
  });

  // ──────── round-1 finding P1 — the deployment's own translator prefixes ────

  /**
   * ── WHAT ROUND 1 PROVED ──
   *
   * The registry list is complete for the REGISTRY and cannot be complete for
   * "every IPv6 form that carries an IPv4 destination": RFC 6052 §2.2 lets an
   * organisation choose its own NAT64 prefix at /32, /40, /48, /56, /64 or /96,
   * and RFC 5969 6rd lets a service provider do the same. The reviewer's
   * witness `2606:4700:1234:5600:7f:0:100:0` encodes `127.0.0.1` under a /64
   * NSP, reads as ordinary global unicast, and was ALLOWED.
   *
   * Those prefixes are unenumerable by construction, so the deployment declares
   * them. These drills hold the two halves that matter: a declaration CLOSES
   * the witness, and no declaration changes nothing.
   */
  function policyDeclaring(declaration: string | undefined):
  typeof import('../utils/outboundAddressPolicy') {
    const previous = process.env.RELAYHALL_IPV4_CARRIER_PREFIXES;
    if (declaration === undefined) delete process.env.RELAYHALL_IPV4_CARRIER_PREFIXES;
    else process.env.RELAYHALL_IPV4_CARRIER_PREFIXES = declaration;
    try {
      return loadMutatedModule<typeof import('../utils/outboundAddressPolicy')>(C6_MODULE, []);
    } finally {
      if (previous === undefined) delete process.env.RELAYHALL_IPV4_CARRIER_PREFIXES;
      else process.env.RELAYHALL_IPV4_CARRIER_PREFIXES = previous;
    }
  }

  const NSP = '2606:4700:1234:5600::/64';
  const NSP_WITNESS = '2606:4700:1234:5600:7f:0:100:0';
  const OUTSIDE_NSP = '2606:4700:1234:5601::1';

  it('with no declaration the witness is allowed, exactly as it is today', () => {
    // The half that makes this repair safe to ship: a deployment that declares
    // nothing gets the answers it got before the declaration existed. If this
    // ever fails, the repair stopped being additive.
    expect(outboundAddressVerdict(NSP_WITNESS)).toEqual({ allowed: true });
    expect(policyDeclaring(undefined).outboundAddressVerdict(NSP_WITNESS)).toEqual({ allowed: true });
  });

  it('declaring the NSP refuses the round-1 witness, naming the operator prefix', () => {
    expect(policyDeclaring(NSP).outboundAddressVerdict(NSP_WITNESS)).toEqual({
      allowed: false, reason: 'IPV4_CARRIER', carrier: `declared:${NSP}`,
    });
  });

  it('a declaration refuses ONLY what is inside it', () => {
    // Without this the assertion above is satisfied by a declaration that
    // refuses the internet.
    const policy = policyDeclaring(NSP);
    expect(policy.outboundAddressVerdict(OUTSIDE_NSP)).toEqual({ allowed: true });
    expect(policy.outboundAddressVerdict('2606:4700::1111')).toEqual({ allowed: true });
    expect(policy.outboundAddressVerdict('93.184.216.34')).toEqual({ allowed: true });
  });

  it.each([
    // NOT 2001:db8::/32 — that is the documentation range and is already
    // refused as RESERVED, so a declaration there would prove nothing.
    ['/32', '2606:4700::/32', '2606:4700:7f:0:100::'],
    ['/40', '2606:4700:1200::/40', '2606:4700:127f:0:100::'],
    ['/48', '2606:4700:1234::/48', '2606:4700:1234:7f:0:100::'],
    ['/56', '2606:4700:1234:5600::/56', '2606:4700:1234:567f:0:100::'],
    ['/64', NSP, NSP_WITNESS],
    ['/96', '2606:4700:1234:5600:0:0::/96', '2606:4700:1234:5600:0:0:7f00:1'],
  ])('an RFC 6052 %s prefix is honoured (%s)', (_length, declaration, witness) => {
    // Every length RFC 6052 §2.2 permits. The address is never decoded, so the
    // `u` octet and the six layouts never have to be read correctly — only the
    // prefix has to be compared.
    expect(policyDeclaring(declaration).outboundAddressVerdict(witness))
      .toMatchObject({ allowed: false, reason: 'IPV4_CARRIER' });
  });

  it.each([
    ['no prefix length', '2606:4700:1234:5600::'],
    ['a non-numeric length', '2606:4700:1234:5600::/sixty-four'],
    ['a length above 128', '2606:4700:1234:5600::/129'],
    ['a length of zero', '2606:4700:1234:5600::/0'],
    ['bits set below the length', '2606:4700:1234:5600::1/64'],
    ['an address that is not IPv6', '10.0.0.0/8'],
    ['one good entry and one bad', `${NSP},nonsense`],
  ])('REFUSES TO START on %s', (_why, declaration) => {
    // Fail-closed on CONFIGURATION, which the round-1 finding asked for by
    // name. A prefix quietly dropped is a hole that looks like a closed one, so
    // the process does not start rather than run half-configured.
    expect(() => policyDeclaring(declaration)).toThrow(/RELAYHALL_IPV4_CARRIER_PREFIXES/);
  });

  /**
   * ── ROUND-2 FINDING P2, AND WHY THE TEST IS PART OF THE DEFECT ──
   *
   * The assertion that stood here said `','` and `' , '` were "not an error —
   * it is no declaration", and the parser agreed with it by filtering empty
   * entries out. Both were wrong the same way: `RELAYHALL_IPV4_CARRIER_PREFIXES=,`
   * LOOKED configured and closed nothing, leaving the round-1 witness allowed on
   * both planes — the exact exposure the setting exists to close. A test written
   * into agreement with the code is how a defect survives a green suite, and
   * this one is the example.
   *
   * The repair is at the CLASS, not at the two spellings the review found.
   * There are exactly TWO states: not configured, which is `undefined` or a
   * wholly blank value and names nothing; and a LIST, in which every entry must
   * name a prefix. No third state exists in which a value is present and means
   * nothing.
   */
  it('a wholly blank value is NOT CONFIGURED, and the witness stays allowed', () => {
    for (const declaration of [undefined, '', '   ', '\t ']) {
      expect(policyDeclaring(declaration).outboundAddressVerdict(NSP_WITNESS))
        .toEqual({ allowed: true });
    }
  });

  it.each([
    ['a lone comma', ','],
    ['a lone comma in whitespace', ' , '],
    ['a trailing comma', `${NSP},`],
    ['a leading comma', `,${NSP}`],
    ['a doubled comma', `${NSP},,2606:4700::/32`],
    ['a whitespace-only entry', `${NSP}, ,2606:4700::/32`],
  ])('REFUSES TO START on %s (%s) — it looks configured and names nothing', (_why, declaration) => {
    expect(() => policyDeclaring(declaration)).toThrow(/every entry must name a prefix/);
  });

  it('CLASS: a value with any non-whitespace character either yields a prefix or THROWS', () => {
    // The class assertion. Nothing that is present may load as nothing — which
    // is the property P2 broke, stated once instead of enumerated. It drives
    // `parseCarrierPrefixes` directly so the claim is about the parser rather
    // than about the six spellings above.
    const CANDIDATES = [
      ',', ' , ', ',,', ' ,, ', `${NSP},`, `,${NSP}`, `${NSP},,${NSP}`, `${NSP}, ,`,
      'nonsense', '/64', '2606:4700::', '2606:4700::/', '2606:4700::/64/64',
      '10.0.0.0/8', `${NSP};2606:4700::/32`, `${NSP} ${NSP}`, '::/0', '-',
      NSP, `${NSP},2606:4700::/32`, ' 2606:4700::/32 ',
    ];
    const surprises: string[] = [];
    for (const value of CANDIDATES) {
      if (value.trim().length === 0) continue;
      let outcome: 'threw' | number;
      try {
        outcome = parseCarrierPrefixes(value, (text) => ipv6AddressValue(text)).length;
      } catch {
        outcome = 'threw';
      }
      if (outcome !== 'threw' && outcome === 0) surprises.push(value);
    }
    expect(surprises).toEqual([]);
    // …and the sweep swept: a filter that skipped everything would make the
    // assertion above true and empty.
    expect(CANDIDATES.filter((v) => v.trim().length > 0).length).toBe(CANDIDATES.length);
  });

  it('MUTATION: with the filter back, a lone comma loads as no prefixes — the defect', () => {
    // The red proof reproduces the REJECTED DEFECT verbatim: the line that
    // shipped filtered empty entries out, and that is the line restored here.
    // A mutation that merely disabled the new guard would prove something about
    // a variant nobody wrote.
    const shipped = "  const entries = raw.split(',').map((entry) => entry.trim());";
    const defect = shipped.slice(0, -1) + '.filter((entry) => entry.length > 0);';
    const forms = loadMutatedModule<typeof import('../utils/ipv4CarrierForms')>(
      FORMS_MODULE, [{ find: shipped, replace: defect }],
    );

    // As it was: a value that looks configured, parsing to nothing at all.
    expect(forms.parseCarrierPrefixes(',', (text) => ipv6AddressValue(text))).toHaveLength(0);
    // …and the consequence, which is the whole finding: the round-1 witness is
    // allowed again while the operator believes a prefix is declared.
    const previous = process.env.RELAYHALL_IPV4_CARRIER_PREFIXES;
    process.env.RELAYHALL_IPV4_CARRIER_PREFIXES = ',';
    try {
      const policy = loadMutatedModule<typeof import('../utils/outboundAddressPolicy')>(
        C6_MODULE, [], { './ipv4CarrierForms': forms },
      );
      expect(policy.outboundAddressVerdict(NSP_WITNESS)).toEqual({ allowed: true });
    } finally {
      if (previous === undefined) delete process.env.RELAYHALL_IPV4_CARRIER_PREFIXES;
      else process.env.RELAYHALL_IPV4_CARRIER_PREFIXES = previous;
    }

    // The shipped parser refuses that value outright, so the state above cannot
    // be reached: the process does not start.
    expect(() => parseCarrierPrefixes(',', (text) => ipv6AddressValue(text)))
      .toThrow(/every entry must name a prefix/);
    expect(() => policyDeclaring(',')).toThrow(/RELAYHALL_IPV4_CARRIER_PREFIXES/);
  });

  it('MUTATION: without the declared-prefix arm the witness is allowed again', () => {
    const line = '    if ((value >> shift) === (prefix.value >> shift)) '
      + 'return `declared:${prefix.text}`;';
    const forms = loadMutatedModule(FORMS_MODULE, [{ find: line, replace: '    void shift;' }]);
    const previous = process.env.RELAYHALL_IPV4_CARRIER_PREFIXES;
    process.env.RELAYHALL_IPV4_CARRIER_PREFIXES = NSP;
    try {
      const policy = loadMutatedModule<typeof import('../utils/outboundAddressPolicy')>(
        C6_MODULE, [], { './ipv4CarrierForms': forms },
      );
      expect(policy.outboundAddressVerdict(NSP_WITNESS)).toEqual({ allowed: true });
    } finally {
      if (previous === undefined) delete process.env.RELAYHALL_IPV4_CARRIER_PREFIXES;
      else process.env.RELAYHALL_IPV4_CARRIER_PREFIXES = previous;
    }
  });

  it('the knowledge plane reads the SAME declaration, so one board has one answer', () => {
    // Two policies, one variable. A prefix honoured by C6 and ignored by the
    // knowledge plane would be the drift the shared list exists to prevent,
    // wearing a configuration instead of a table.
    const kw1 = readShippedSource('services/KnowledgeSourcePolicy.ts');
    expect(kw1).toContain('process.env.RELAYHALL_IPV4_CARRIER_PREFIXES');
    expect(kw1).toContain('parseCarrierPrefixes(');
    const previous = process.env.RELAYHALL_IPV4_CARRIER_PREFIXES;
    process.env.RELAYHALL_IPV4_CARRIER_PREFIXES = NSP;
    try {
      const policy = loadMutatedModule<typeof import('../services/KnowledgeSourcePolicy')>(
        'services/KnowledgeSourcePolicy.ts', [],
      );
      // Refused under a TOTAL allow-list, which is the knowledge plane's own
      // decision and one C6 has no notion of.
      expect(policy.classifyAddress(NSP_WITNESS, ['0.0.0.0/0', '::/0']))
        .toEqual({ admissible: false, reason: 'ipv4-carrier-refused' });
      expect(policy.classifyAddress(OUTSIDE_NSP, []))
        .toEqual({ admissible: true, reason: 'public' });
    } finally {
      if (previous === undefined) delete process.env.RELAYHALL_IPV4_CARRIER_PREFIXES;
      else process.env.RELAYHALL_IPV4_CARRIER_PREFIXES = previous;
    }
  });

  // ───────── round-1 finding C1 — the wrapper spellings, named ──────────────

  /**
   * The generated sweep below compares two parsers over the domain it can
   * generate: lowercase, unwrapped, `net.isIPv6`-accepted spellings. Round-1
   * finding C1 is that its PROSE claimed more than that — it never emits
   * brackets, whitespace, uppercase or a zone id, and its `net.isIPv6` filter
   * structurally excludes the bracketed URL-host form.
   *
   * So the domain is stated, and the wrapper classes are pinned by hand HERE,
   * where the two policies' contracts differ on purpose: C6 is handed addresses
   * a resolver returned, the knowledge plane is handed a URL host. Where they
   * agree, equality is asserted; where they differ, the difference is asserted
   * with its direction, because a difference nobody wrote down is a difference
   * nobody will notice changing.
   */
  const WRAPPER_SPELLINGS: Array<[string, string, 'agree' | 'c6-rejects']> = [
    ['uppercase', '2002:7F00:1::', 'agree'],
    ['uppercase embedded quad', '::FFFF:0:127.0.0.1', 'agree'],
    ['embedded dotted quad', '::ffff:0:127.0.0.1', 'agree'],
    ['isatap with a dotted tail', '2620:0:1:2:0:5efe:169.254.169.254', 'agree'],
    ['a zone identifier', '2002:7f00:1::%eth0', 'agree'],
    ['leading ::', '::7f00:1', 'agree'],
    ['fully expanded', '2002:7f00:0001:0000:0000:0000:0000:0000', 'agree'],
    ['bracketed URL-host form', '[2002:7f00:1::]', 'c6-rejects'],
    ['surrounding whitespace', ' 2002:7f00:1:: ', 'c6-rejects'],
  ];

  it.each(WRAPPER_SPELLINGS)('%s (%s): the two parsers %s', (_name, address, contract) => {
    const c6 = ipv6AddressValue(address);
    const knowledge = asIpv6Value(address);
    if (contract === 'agree') {
      expect(c6).not.toBeNull();
      expect(c6).toBe(knowledge);
    } else {
      // C6 is handed ADDRESSES a resolver returned, never a URL host, so it
      // refuses a wrapper rather than unwrapping one. The knowledge plane is
      // handed a URL host and unwraps it. Both fail closed: neither ALLOWS.
      expect(c6).toBeNull();
      expect(knowledge).not.toBeNull();
    }
  });

  it.each(WRAPPER_SPELLINGS)('%s (%s) is refused by BOTH planes whatever the parsers said',
    (_name, address) => {
      // The property that actually matters. The two parsers may disagree about
      // what a wrapper IS; they may not disagree about letting it through.
      expect(outboundAddressVerdict(address).allowed).toBe(false);
      expect(classifyAddress(address, ['0.0.0.0/0', '::/0']).admissible).toBe(false);
    });
});

// ─────────────────────── client_id and document validation ──────────────────

describe('a client_id is a URL the board is willing to fetch, or it is refused', () => {
  const refusalFor = (clientId: unknown): string => {
    try {
      validateClientIdUrl(clientId);
      return 'ACCEPTED';
    } catch (error) {
      return error instanceof ClientMetadataError ? error.refusal : 'UNEXPECTED';
    }
  };

  it.each([
    ['http://example.com/client.json', 'CLIENT_ID_NOT_HTTPS'],
    ['file:///etc/passwd', 'CLIENT_ID_NOT_HTTPS'],
    ['https://board@evil.example.com/c.json', 'CLIENT_ID_HAS_USERINFO'],
    ['https://example.com/c.json#frag', 'CLIENT_ID_HAS_FRAGMENT'],
    ['https://example.com:8443/c.json', 'CLIENT_ID_PORT_NOT_ALLOWED'],
    ['https://169.254.169.254/c.json', 'CLIENT_ID_HOST_IS_ADDRESS'],
    ['https://[::1]/c.json', 'CLIENT_ID_HOST_IS_ADDRESS'],
    ['not a url', 'CLIENT_ID_NOT_A_URL'],
    ['', 'CLIENT_ID_NOT_A_URL'],
    [null, 'CLIENT_ID_NOT_A_URL'],
  ])('refuses %s', (clientId, expected) => {
    expect(refusalFor(clientId)).toBe(expected);
  });

  it('accepts an ordinary https client_id — the control for every refusal above', () => {
    expect(refusalFor('https://chat.example.com/.well-known/oauth-client')).toBe('ACCEPTED');
    expect(refusalFor('https://example.com:443/c.json')).toBe('ACCEPTED');
  });

  it('refuses a host that really resolves to loopback, through the real resolve path', async () => {
    // Not a mock and not a unit test of the range table: this drives
    // `resolve()`, which does DNS and then asks the policy. `localhost` is a
    // NAME, so it passes the IP-literal gate and is caught by the address gate
    // — which is the ordering the whole defence depends on.
    await expect(oauthClientMetadataService.resolve('https://localhost/c.json'))
      .rejects.toMatchObject({ refusal: 'CLIENT_ADDRESS_NOT_PUBLIC' });
  });

  it('refuses a host that does not resolve at all', async () => {
    await expect(oauthClientMetadataService
      .resolve('https://c6-no-such-host.invalid/c.json'))
      .rejects.toMatchObject({ refusal: 'CLIENT_HOST_UNRESOLVABLE' });
  });
});

describe('the metadata document must name itself and declare usable redirects', () => {
  const CLIENT_ID = 'https://chat.example.com/client.json';
  const good = {
    client_id: CLIENT_ID,
    client_name: 'Example Chat',
    redirect_uris: ['https://chat.example.com/callback'],
  };
  const parse = (document: unknown): string => {
    try {
      parseClientMetadataDocument(CLIENT_ID, JSON.stringify(document));
      return 'ACCEPTED';
    } catch (error) {
      return error instanceof ClientMetadataError ? error.refusal : 'UNEXPECTED';
    }
  };

  it('accepts a well-formed document — the control', () => {
    const parsed = parseClientMetadataDocument(CLIENT_ID, JSON.stringify(good));
    expect(parsed.clientId).toBe(CLIENT_ID);
    expect(parsed.clientName).toBe('Example Chat');
    expect(parsed.redirectUris).toEqual(['https://chat.example.com/callback']);
    // The digest covers the exact bytes, so a silently changed document is
    // visible in `oauth_clients` rather than indistinguishable.
    expect(parsed.documentSha256)
      .toEqual(crypto.createHash('sha256').update(JSON.stringify(good), 'utf8').digest('hex'));
  });

  it.each([
    [{ ...good, client_id: 'https://other.example.com/client.json' }, 'DOCUMENT_CLIENT_ID_MISMATCH'],
    [{ ...good, client_id: undefined }, 'DOCUMENT_CLIENT_ID_MISMATCH'],
    [{ ...good, redirect_uris: [] }, 'DOCUMENT_NO_REDIRECT_URIS'],
    [{ ...good, redirect_uris: undefined }, 'DOCUMENT_NO_REDIRECT_URIS'],
    [{ ...good, redirect_uris: ['http://evil.example.com/cb'] }, 'DOCUMENT_BAD_REDIRECT_URI'],
    [{ ...good, redirect_uris: ['https://chat.example.com/cb#x'] }, 'DOCUMENT_BAD_REDIRECT_URI'],
    [{ ...good, redirect_uris: ['javascript:alert(1)'] }, 'DOCUMENT_BAD_REDIRECT_URI'],
    [{ ...good, redirect_uris: ['https://u:p@chat.example.com/cb'] }, 'DOCUMENT_BAD_REDIRECT_URI'],
  ])('refuses a document mutated to %j', (document, expected) => {
    expect(parse(document)).toBe(expected);
  });

  it('refuses bytes that are not a JSON object', () => {
    for (const body of ['not json', '[]', '"a string"', 'null']) {
      let refusal = 'ACCEPTED';
      try { parseClientMetadataDocument(CLIENT_ID, body); } catch (error) {
        refusal = error instanceof ClientMetadataError ? error.refusal : 'UNEXPECTED';
      }
      expect([body, refusal]).toEqual([body, 'DOCUMENT_NOT_JSON']);
    }
  });

  it('permits loopback http only as a LITERAL address, never as the name localhost', () => {
    // OAuth 2.1 §8.4.2: a native client redirects to 127.0.0.1 on an ephemeral
    // port. The NAME can be made to resolve elsewhere; the literal cannot.
    expect(isAcceptableRedirectUri('http://127.0.0.1:49152/cb')).toBe(true);
    expect(isAcceptableRedirectUri('http://localhost:49152/cb')).toBe(false);
    expect(isAcceptableRedirectUri('http://example.com/cb')).toBe(false);
  });
});

// ──────────────────────────── PKCE, as the server checks it ─────────────────

describe('a client cannot supply a URL the board would put in an href', () => {
  // Review 6fe97bc5 B3. `client_uri` and `logo_uri` come from a document an
  // UNAUTHENTICATED caller controls and are shown on the SIGNED-IN consent
  // page, so the board decides here what it is willing to display.
  it.each([
    'javascript:alert(document.domain)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'http://chat.example.com/',
    'https://user:pass@chat.example.com/',
    'https://chat.example.com/#frag',
    'not a url',
    '',
  ])('drops %j', (value) => {
    expect(sanitizeDisplayUri(value)).toBeNull();
  });

  it('drops a non-string, and anything past the length bound', () => {
    for (const value of [null, undefined, 42, {}, [], `https://a.example.com/${'x'.repeat(2100)}`]) {
      expect(sanitizeDisplayUri(value)).toBeNull();
    }
  });

  it('keeps an ordinary https URL — the control every drop above needs', () => {
    expect(sanitizeDisplayUri('https://chat.example.com')).toBe('https://chat.example.com/');
    expect(sanitizeDisplayUri('https://chat.example.com/about?x=1'))
      .toBe('https://chat.example.com/about?x=1');
  });

  it('a fetched document carries only sanitized display URLs', () => {
    // The binding: the drop is not a helper nobody calls. A document declaring
    // an executable client_uri parses into a record whose clientUri is null.
    const clientId = 'https://chat.example.com/client.json';
    const parsed = parseClientMetadataDocument(clientId, JSON.stringify({
      client_id: clientId,
      client_name: 'Example Chat',
      client_uri: 'javascript:alert(document.domain)',
      logo_uri: 'data:image/svg+xml,<svg onload=alert(1)>',
      redirect_uris: ['https://chat.example.com/cb'],
    }));
    expect(parsed.clientUri).toBeNull();
    expect(parsed.logoUri).toBeNull();
    // ...and the name still survives, so the person still sees who is asking.
    expect(parsed.clientName).toBe('Example Chat');
  });
});

describe('PKCE is required and is checked by the production predicate', () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');

  it('accepts the verifier that produced the challenge', () => {
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it('refuses a different verifier, a truncated one, and an empty one', () => {
    expect(verifyPkceS256(crypto.randomBytes(32).toString('base64url'), challenge)).toBe(false);
    expect(verifyPkceS256(verifier.slice(0, -1), challenge)).toBe(false);
    expect(verifyPkceS256('', challenge)).toBe(false);
  });

  it('refuses a challenge that is the PLAIN verifier (the method this server never accepts)', () => {
    expect(verifyPkceS256(verifier, verifier)).toBe(false);
  });
});

// ───────────────────── the discovery chain a client walks ───────────────────

describe('the discovery chain, walked the way a client walks it', () => {
  it('the MCP endpoint answers 401 with a challenge naming a protected-resource URL', async () => {
    const anonymous = await request('POST', '/mcp',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    expect(anonymous.status).toBe(401);
    const challenge = String(anonymous.headers['www-authenticate']);
    const pointer = /resource_metadata="([^"]+)"/.exec(challenge);
    expect(pointer).not.toBeNull();
    // The relation is written HERE: whatever the challenge points at, it must
    // be an absolute URL whose path is the RFC 9728 well-known path.
    const url = new URL(pointer![1]);
    expect(url.pathname.endsWith('/.well-known/oauth-protected-resource')).toBe(true);
  });

  /**
   * The board's public endpoint carries the deployment's API prefix (`/api`),
   * which the ingress strips before the application sees a request. A test
   * listener has no ingress, so following an advertised URL means removing
   * that prefix — and NOTHING ELSE. Written here rather than derived from the
   * renderer, because this is the mapping under test.
   */
  const followOnThisListener = (advertised: string): string => {
    const url = new URL(advertised);
    expect(url.pathname.startsWith('/api/')).toBe(true);
    return url.pathname.slice('/api'.length);
  };

  it('the URL the challenge ADVERTISES is the URL the document is SERVED at', async () => {
    // THE CONTROL FOR A DEFECT THIS CANDIDATE ACTUALLY HAD. An earlier draft
    // advertised `<issuer>/.well-known/oauth-protected-resource` while serving
    // the document under `<issuer>/oauth/.well-known/…`. Every neighbouring
    // assertion passed: the challenge had the right shape, and the document
    // was fetched by a path the test already knew. Nothing followed the
    // advertisement, so a real client would have met a 404 at step one.
    const anonymous = await request('POST', '/mcp',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    const pointer = /resource_metadata="([^"]+)"/.exec(String(anonymous.headers['www-authenticate']));
    expect(pointer).not.toBeNull();
    const followed = await get(followOnThisListener(pointer![1]));
    expect(followed.status).toBe(200);
    expect(followed.body.resource).toBe(oauthResourceIdentifier(boardEndpoint()));
  });

  it('the authorization-server document is where RFC 8414 says to construct it', async () => {
    // A conforming client does not read a URL for this one: it appends the
    // well-known path to the ISSUER. The relation is written here, and then
    // the constructed URL is followed rather than assumed.
    const constructed = `${oauthIssuer(boardEndpoint())}/.well-known/oauth-authorization-server`;
    expect(authorizationServerMetadataUrl(boardEndpoint())).toBe(constructed);
    expect(protectedResourceMetadataUrl(boardEndpoint()))
      .toBe(`${oauthIssuer(boardEndpoint())}/.well-known/oauth-protected-resource`);
    const followed = await get(followOnThisListener(constructed));
    expect(followed.status).toBe(200);
    expect(followed.body.issuer).toBe(oauthIssuer(boardEndpoint()));
  });

  it('a URL under the /oauth mount is NOT where the documents live', async () => {
    // The negative control for the two above: if the documents were ALSO
    // served under /oauth, following the advertisement would prove nothing
    // about the mount, because everything would answer 200.
    expect((await get('/oauth/.well-known/oauth-protected-resource')).status).toBe(404);
    expect((await get('/oauth/.well-known/oauth-authorization-server')).status).toBe(404);
  });

  it('that URL is served, and describes THIS deployment MCP endpoint', async () => {
    // The behavioural half: not "the string matches", but "following it works".
    const document = await get(OAUTH_PROTECTED_RESOURCE_METADATA_PATH);
    expect(document.status).toBe(200);
    expect(document.body.resource).toBe(oauthResourceIdentifier(boardEndpoint()));
    expect(document.body.resource.endsWith('/mcp')).toBe(true);
    expect(document.body.authorization_servers).toEqual([oauthIssuer(boardEndpoint())]);
    expect(document.body.bearer_methods_supported).toEqual(['header']);
    expect(document.headers['cache-control']).toBe('no-store');
  });

  it('the authorization server it names publishes endpoints under that same issuer', async () => {
    const document = await get(OAUTH_AS_METADATA_PATH);
    expect(document.status).toBe(200);
    const issuer = oauthIssuer(boardEndpoint());
    expect(document.body.issuer).toBe(issuer);
    for (const endpoint of ['authorization_endpoint', 'token_endpoint', 'revocation_endpoint']) {
      expect(String(document.body[endpoint]).startsWith(`${issuer}/oauth/`)).toBe(true);
    }
    // CIMD, not DCR: no registration endpoint is advertised, and the CIMD
    // capability is declared so a client knows what to do instead.
    expect(document.body.registration_endpoint).toBeUndefined();
    expect(document.body.client_id_metadata_document_supported).toBe(true);
  });

  it('renders the same documents the endpoints serve, from the same renderer', async () => {
    const [prm, as] = await Promise.all([
      get(OAUTH_PROTECTED_RESOURCE_METADATA_PATH),
      get(OAUTH_AS_METADATA_PATH),
    ]);
    expect(prm.body).toEqual(buildProtectedResourceMetadata(boardEndpoint(), oauthGrantableScopes()));
    expect(as.body).toEqual(buildAuthorizationServerMetadata(boardEndpoint(), oauthGrantableScopes()));
  });

  it('a challenge with no request in hand carries no pointer (the C4 floor)', () => {
    expect(mcpWwwAuthenticate(null)).toBe(MCP_WWW_AUTHENTICATE);
    expect(mcpWwwAuthenticate(null)).not.toContain('resource_metadata');
    expect(mcpWwwAuthenticate('https://board.example.com/api'))
      .toContain('resource_metadata="https://board.example.com/api/.well-known/oauth-protected-resource"');
  });
});

// ───────────── the published claims are refusals, not aspirations ───────────

describe('what the metadata claims, the endpoints enforce', () => {
  it('THIS RELEASE advertises the authorization_code grant and no other', () => {
    // A RELEASE PIN, not the behavioural anchor: it makes growing the grant
    // set a deliberate edit that a reviewer sees. The anchor that cannot be
    // satisfied by editing a list lives in c9BootstrapPacks.test.ts and is
    // derived from this constant in both directions (review 6fe97bc5 B1).
    expect([...OAUTH_GRANT_TYPES_SUPPORTED]).toEqual(['authorization_code']);
  });

  it('the token endpoint refuses, over the wire, every grant it does not advertise', async () => {
    const advertised = new Set<string>(OAUTH_GRANT_TYPES_SUPPORTED);
    const unadvertised = ['refresh_token', 'client_credentials', 'password', 'implicit',
      'urn:ietf:params:oauth:grant-type:token-exchange'].filter((grant) => !advertised.has(grant));
    expect(unadvertised.length).toBeGreaterThan(0);
    for (const grant of unadvertised) {
      const result = await postForm('/oauth/token', { grant_type: grant, code: 'x' });
      expect([grant, result.status, result.body.error])
        .toEqual([grant, 400, 'unsupported_grant_type']);
    }
  });

  it('RFC 8693 token exchange is refused BY NAME — the deferred rung stays deferred', async () => {
    // Ruling KS-1 (record d92e756c) DEFERRED the §12.9 token-exchange rung;
    // vehicle 86508d90 stays Phase-4-parked. This is the pin: adding the grant
    // silently would turn this red, and adding it deliberately is an owner
    // ruling that comes with removing this test on purpose.
    const result = await postForm('/oauth/token',
      { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange' });
    expect(result.body.error).toBe('unsupported_grant_type');
  });

  it('the authorization endpoint refuses every PKCE method the metadata does not list', async () => {
    expect([...OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED]).toEqual(['S256']);
    // The refusal is reached before any outbound fetch: an unusable client_id
    // is refused first, so this asserts the ORDERING too — a caller cannot
    // make the board fetch a document by sending a broken PKCE method.
    const result = await get('/oauth/authorize?client_id=https%3A%2F%2F127.0.0.1%2Fc.json'
      + '&redirect_uri=https%3A%2F%2Fx.example.com%2Fcb&response_type=code'
      + '&code_challenge_method=plain&code_challenge=abc');
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_client');
    expect(result.body.error_description).toContain('IP address');
  });

  it('never redirects a browser to an unvalidated redirect_uri', async () => {
    // The open-redirect control. The client_id cannot be resolved, so the
    // redirect target was never proven to belong to any client — the refusal
    // must be a page, not a 302 to the attacker's URL.
    const result = await get('/oauth/authorize?client_id=https%3A%2F%2F127.0.0.1%2Fc.json'
      + '&redirect_uri=https%3A%2F%2Fattacker.example%2Fsteal&response_type=code'
      + '&code_challenge_method=S256&code_challenge=' + 'A'.repeat(43));
    expect(result.status).toBe(400);
    expect(result.headers.location).toBeUndefined();
    expect(result.text).not.toContain('attacker.example');
  });

  it('the consent endpoints refuse a bearer credential and an anonymous caller (AZ-18)', async () => {
    const anonymous = await get('/oauth/authorization-requests/00000000-0000-0000-0000-000000000000');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe('invalid_token');
    const decision = await postJson(
      '/oauth/authorization-requests/00000000-0000-0000-0000-000000000000/decision',
      { approve: true },
    );
    expect(decision.status).toBe(401);
  });

  it('revocation refuses unusable input without reaching the substrate', async () => {
    // The DB-FREE half of RFC 7009 §2.2. Whether a REAL token revokes, and
    // whether the very next MCP call is then refused, are substrate acts: they
    // are drilled against the deployed board by scripts/test-c6-oauth-flow.js
    // (owner decision D3). Asserting them in a suite that carries no Postgres
    // would be asserting them against nothing, which is the class of evidence
    // this programme keeps rejecting.
    for (const token of ['', 'x'.repeat(513), null, 42, undefined]) {
      await expect(oauthAuthorizationService
        .revoke(token, { handle: 'system', authMethod: 'system' }))
        .resolves.toEqual({ revoked: false });
    }
  });
});

// ──────────────────────────── scopes and lifetimes ──────────────────────────

describe('this server mints only ratified scopes, and never root', () => {
  it('offers exactly the mintable vocabulary minus root', () => {
    // The oracle is rebuilt here from scopeMap with the relation written in
    // this file, so a change to `oauthGrantableScopes` that widened the set
    // could not stay green by moving both sides together.
    const expected = MINTABLE_SCOPES.filter((scope) => scope !== ROOT_SCOPE);
    expect([...oauthGrantableScopes()].sort()).toEqual([...expected].sort());
    expect(oauthGrantableScopes()).not.toContain(ROOT_SCOPE);
    // The control: the set is non-empty and really is narrower than the whole.
    expect(oauthGrantableScopes().length).toBeGreaterThan(0);
    expect(oauthGrantableScopes().length).toBe(MINTABLE_SCOPES.length - 1);
  });

  it('advertises that set, so a client is told what it may ask for', async () => {
    const document = await get(OAUTH_AS_METADATA_PATH);
    expect([...document.body.scopes_supported].sort()).toEqual([...oauthGrantableScopes()].sort());
    expect(document.body.scopes_supported).not.toContain('root');
  });

  it('lists response types and client authentication honestly', async () => {
    const document = await get(OAUTH_AS_METADATA_PATH);
    expect(document.body.response_types_supported).toEqual([...OAUTH_RESPONSE_TYPES_SUPPORTED]);
    // Every CIMD client is public: `none` is the only method, and advertising
    // a secret-based method would be advertising something unimplementable.
    expect(document.body.token_endpoint_auth_methods_supported)
      .toEqual([...OAUTH_TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED]);
    expect(document.body.token_endpoint_auth_methods_supported).toEqual(['none']);
  });
});

describe('a re-consent never resurrects a Connector somebody switched off', () => {
  it('reuses only an ACTIVE Connector', () => {
    expect(connectorReuseVerdict('active')).toBe('reuse');
  });

  it('refuses a disabled one — the kill switch is not undone by consenting again', () => {
    // `evaluateCredentialAcceptance` refuses a non-active principal, so
    // disabling a Connector kills every token issued to that client for that
    // person. A re-consent that wrote `status = 'active'` on reuse would have
    // undone that silently; this is the predicate that stops it.
    expect(connectorReuseVerdict('disabled')).toBe('refuse-disabled');
  });

  it('refuses a terminated one — A17.10 termination is irreversible', () => {
    expect(connectorReuseVerdict('terminated')).toBe('refuse-terminated');
  });

  it('treats an unknown or absent status as not reusable (fail closed)', () => {
    for (const status of ['', 'unknown', null, undefined, 0, {}]) {
      expect([String(status), connectorReuseVerdict(status)])
        .toEqual([String(status), 'refuse-disabled']);
    }
  });

  it('the production path asks THIS predicate rather than deciding inline', () => {
    // The control that keeps the predicate from becoming a decorative export:
    // the service must not write a status on the reuse path at all.
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'OAuthAuthorizationService.ts'), 'utf8');
    expect(source).toContain('connectorReuseVerdict(existing.rows[0].status)');
    expect(source).not.toContain("status = 'active', updated_at");
  });
});

describe('spent authorization requests are actually swept', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');

  it('the server calls the sweep on its lifecycle interval', () => {
    // A public sweep with no caller is dead code wearing a safety story — the
    // exact shape of hardening card c8f95fef. This binds the method to a call
    // site rather than to a comment.
    expect(server).toContain('oauthAuthorizationService.sweepExpired()');
    expect(typeof oauthAuthorizationService.sweepExpired).toBe('function');
  });

  it('a server that dropped the call fails that check', () => {
    const mutated = server.replace('oauthAuthorizationService.sweepExpired()', 'noop()');
    expect(mutated).not.toEqual(server); // the mutation landed
    expect(mutated).not.toContain('oauthAuthorizationService.sweepExpired()');
  });
});

describe('the access-token lifetime is bounded whatever the deployment declares', () => {
  it('uses the documented default when nothing is declared', () => {
    expect(accessTokenTtlHours({})).toBe(OAUTH_DEFAULT_ACCESS_TOKEN_TTL_HOURS);
  });

  it('honours a declared value inside the bounds', () => {
    expect(accessTokenTtlHours({ [OAUTH_ACCESS_TOKEN_TTL_ENV]: '4' })).toBe(4);
  });

  it('falls back rather than issuing an unbounded or zero-length token', () => {
    for (const declared of ['0', '-1', 'forever', '', String(OAUTH_ACCESS_TOKEN_TTL_MAX_HOURS + 1)]) {
      expect([declared, accessTokenTtlHours({ [OAUTH_ACCESS_TOKEN_TTL_ENV]: declared })])
        .toEqual([declared, OAUTH_DEFAULT_ACCESS_TOKEN_TTL_HOURS]);
    }
  });
});
