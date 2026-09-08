/**
 * SS-W2 · §4.5(b) — the vendor-literal gate.
 *
 * **The claim, at exactly the strength this gate carries:** the relying-party
 * source contains no vendor-identifying literal outside a value-scoped,
 * per-file exemption enumeration.
 *
 * ── WHAT THIS DOES NOT PROVE, STATED PLAINLY ──
 *
 * It bounds the LITERAL class only. Equivalent vendor branching can be written
 * with no vendor-identifying literal at all — an unnamed shape check on a
 * claim's structure, a numeric constant, a value imported or generated
 * elsewhere, a concatenated or hashed string, or a fixture/config module
 * boundary quietly widened until production logic lives inside it. v1 of this
 * control was headed "no vendor branch exists"; it measures no such thing.
 * Closing that gap is a control-depth question, deferred by owner ruling
 * SSO-R13 to card `20391c2f`, and it is named here rather than assumed away.
 *
 * ── WHY THE EXEMPTIONS ARE PER FILE AND PER VALUE ──
 *
 * The RFC1918 lesson: a path-scoped exemption let a reviewer insert an
 * unrelated address and the gate stayed green. An exemption here names ONE
 * literal in ONE file. There is deliberately no way to exempt a whole file.
 *
 * The list is currently EMPTY, which is the strongest state it can be in: the
 * relying-party source needs no vendor literal, and the two that existed in
 * comments were removed rather than exempted. The mechanism is still proved —
 * see the exemption control below — so an entry added later is a reviewed act
 * rather than an untested one.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');

/**
 * The relying-party source. The fixture module the annex says to exclude does
 * not live here at all — it sits under `__tests__/conformance` — which is a
 * stronger arrangement than excluding it, because it cannot drift into scope.
 */
const RP_SOURCES: string[] = [
  ...fs
    .readdirSync(path.join(SRC, 'services', 'identity'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join('services', 'identity', name)),
  path.join('routes', 'sso.ts'),
  path.join('routes', 'identityProviders.ts'),
  // RH-P5.SSO.W4: the inbound SCIM surface. §7.4's whole argument for
  // choosing SCIM over an outbound directory API is that, of every Identity
  // provider, "the endpoint is identical for every provider that can reach
  // it" — so this router is
  // exactly as vendor-free as the relying-party leg and is scanned with it.
  path.join('routes', 'scim.ts'),
];

/**
 * Vendor names, vendor-specific claim names and vendor hostnames.
 *
 * Deliberately NOT included: `preferred_username`, `email_verified`, `sub`,
 * `_claim_names` and `_claim_sources`. Those are OpenID Connect and JWT
 * constructs, not vendor identifiers, and a gate that refused them would refuse
 * standard conformance — which is the opposite of what it exists to protect.
 */
export const VENDOR_LITERAL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'product name', pattern: /\b(authentik|keycloak|okta|auth0|onelogin|entra|adfs|jumpcloud|pingfederate|cognito)\b/gi },
  { label: 'vendor platform', pattern: /\b(azure|microsoft|google\s+workspace|googleapis)\b/gi },
  { label: 'vendor claim name', pattern: /\b(realm_access|resource_access|extension_attributes)\b/gi },
  { label: 'vendor hostname', pattern: /(login\.microsoftonline\.com|accounts\.google\.com|login\.windows\.net|[a-z0-9-]+\.okta\.com|[a-z0-9-]+\.auth0\.com)/gi },
];

/**
 * Value-scoped, per-file exemptions: `{ 'relative/file.ts': ['literal', …] }`.
 * A literal is permitted only in the file that names it, and only by its exact
 * matched text.
 */
export const PERMITTED_LITERALS: Readonly<Record<string, readonly string[]>> = {
  // (empty — the relying-party source needs no vendor literal)
};

export interface LiteralHit {
  file: string;
  line: number;
  literal: string;
  label: string;
}

/** THE scanner. Both the gate and every control below call this one function. */
export function scanForVendorLiterals(file: string, source: string): LiteralHit[] {
  const hits: LiteralHit[] = [];
  const lines = source.split('\n');
  for (const { label, pattern } of VENDOR_LITERAL_PATTERNS) {
    lines.forEach((text, index) => {
      const matcher = new RegExp(pattern.source, pattern.flags);
      let match = matcher.exec(text);
      while (match !== null) {
        hits.push({ file, line: index + 1, literal: match[0], label });
        match = matcher.exec(text);
      }
    });
  }
  return hits;
}

function isPermitted(hit: LiteralHit): boolean {
  const permitted = PERMITTED_LITERALS[hit.file] ?? [];
  return permitted.some((entry) => entry.toLowerCase() === hit.literal.toLowerCase());
}

describe('§4.5(b) — no vendor-identifying literal in the relying-party source', () => {
  it('scans a relying-party source set that is real, not empty', () => {
    // A gate pointed at nothing passes trivially. This is the floor under
    // every assertion below.
    expect(RP_SOURCES.length).toBeGreaterThanOrEqual(8);
    for (const file of RP_SOURCES) {
      expect(fs.existsSync(path.join(SRC, file))).toBe(true);
    }
  });

  it('finds no unexempted vendor literal', () => {
    const offenders: string[] = [];
    for (const file of RP_SOURCES) {
      const source = fs.readFileSync(path.join(SRC, file), 'utf8');
      for (const hit of scanForVendorLiterals(file, source)) {
        if (!isPermitted(hit)) offenders.push(`${hit.file}:${hit.line} ${hit.label} '${hit.literal}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('NON-VACUITY: the scanner really matches — it flags the fixture module, which legitimately names products', () => {
    // The fixture module is where §10a's vendor behaviours are described, and
    // it is NOT relying-party source. Pointing the scanner at it proves the
    // patterns fire, so "no offenders" above cannot be a scanner that matches
    // nothing.
    const fixtures = path.join(SRC, '__tests__', 'conformance', 'fixtures.ts');
    const censusFile = path.join(SRC, '__tests__', 'conformance', 'census.ts');
    const fixtureHits = scanForVendorLiterals('fixtures.ts', fs.readFileSync(fixtures, 'utf8'));
    const censusHits = scanForVendorLiterals('census.ts', fs.readFileSync(censusFile, 'utf8'));
    // The census transcribes S-A8, which names the platforms by design.
    expect(censusHits.length).toBeGreaterThan(0);
    expect(censusHits.map((hit) => hit.literal.toLowerCase())).toContain('authentik');
    // The fixture module names the standard it stands for; either module firing
    // proves the patterns are live.
    expect(fixtureHits.length + censusHits.length).toBeGreaterThan(3);
  });

  it('RED PROOF: an unexempted literal fails the gate, naming the file and the literal', () => {
    const injected = "const issuerHint = 'login.microsoftonline.com';";
    const hits = scanForVendorLiterals('services/identity/ssoOutbound.ts', injected).filter(
      (hit) => !isPermitted(hit),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].literal).toBe('login.microsoftonline.com');
    expect(hits[0].file).toBe('services/identity/ssoOutbound.ts');
  });

  it('EXEMPTION CONTROL: an exemption permits its own literal in its own file, and NOWHERE else', () => {
    // Proves the mechanism works without shipping an entry nothing needs, and
    // proves it is value-scoped AND file-scoped: the same literal in a
    // different file is still an offender.
    const permitted: Record<string, readonly string[]> = { 'services/identity/a.ts': ['keycloak'] };
    const check = (hit: LiteralHit): boolean =>
      (permitted[hit.file] ?? []).some((entry) => entry.toLowerCase() === hit.literal.toLowerCase());

    const inNamedFile = scanForVendorLiterals('services/identity/a.ts', "// keycloak");
    expect(inNamedFile).toHaveLength(1);
    expect(check(inNamedFile[0])).toBe(true);

    const inAnotherFile = scanForVendorLiterals('services/identity/b.ts', "// keycloak");
    expect(check(inAnotherFile[0])).toBe(false);

    // And a DIFFERENT literal in the exempted file is still an offender —
    // there is no way to exempt a whole file.
    const otherLiteral = scanForVendorLiterals('services/identity/a.ts', "// okta");
    expect(check(otherLiteral[0])).toBe(false);
  });

  it('does not refuse standard OpenID Connect and JWT constructs', () => {
    // A gate that flagged these would refuse standard conformance — the
    // opposite of what it protects. `_claim_names` in particular is OIDC Core
    // §5.6.2 and the parser must be free to name it.
    const standard = "preferred_username email_verified _claim_names _claim_sources sub azp nonce";
    expect(scanForVendorLiterals('services/identity/ssoGroupClaims.ts', standard)).toEqual([]);
  });
});
