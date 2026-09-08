/**
 * T-SS13 source census: no relying-party module consults `Host` or
 * `X-Forwarded-Host` (design `d95136d7` §5.1, annex `e6dcadb9` §10 T-SS13).
 *
 * WHAT THIS IS AND IS NOT. The behavioural proof of T-SS13 is the acceptance
 * vector `T-SS13-redirect-uri-header-independence`, which drives the real route
 * over a real socket under hostile headers. It is the primary evidence, because
 * a static census cannot prove a runtime property: a module could reach a header
 * through a helper, a framework accessor or a dynamic key and this scan would
 * not see it.
 *
 * What a census CAN do, and what this one is for, is act as a RATCHET. The
 * vector proves the property holds today; this test makes a NEW header read on
 * the relying-party surface fail at review time rather than at the next audit,
 * including on a path no vector happens to drive. The two are complements, and
 * neither is offered as the other.
 *
 * The scan is value-scoped, not file-scoped: `user-agent` is permitted because
 * it is recorded as audit metadata and reaches no destination, and it is named
 * here so that ANY OTHER header read in the same file still fails.
 */
import fs from 'fs';
import path from 'path';

const BACKEND = path.resolve(__dirname, '..', '..');

/** The relying-party surface, by directory rather than by a list that drifts. */
function relyingPartyModules(): string[] {
  const identityDir = path.join(BACKEND, 'src', 'services', 'identity');
  const modules = fs
    .readdirSync(identityDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join('src', 'services', 'identity', name));
  return [...modules, path.join('src', 'routes', 'sso.ts'), path.join('src', 'routes', 'identityProviders.ts')];
}

/** Comments are where this property is DISCUSSED, so they are not evidence. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/**
 * Any read of the request's headers. Deliberately broader than the two headers
 * T-SS13 names: the census reports every header the surface reads, so a
 * reviewer rules on the whole set rather than on the two we thought to forbid.
 */
const HEADER_READ = /req\.headers\s*\[\s*['"`]([^'"`]+)['"`]\s*\]|req\.get\(\s*['"`]([^'"`]+)['"`]\s*\)|req\.hostname|req\.subdomains/g;

/** Value-scoped permission: recorded as audit metadata, reaches no destination. */
const PERMITTED_HEADER_READS = new Set(['user-agent']);

/** Named for the failure message, and forbidden regardless of how they are read. */
const FORBIDDEN_HEADERS = ['host', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'];

describe('T-SS13 — the relying-party surface reads no host header', () => {
  const modules = relyingPartyModules();

  it('enumerates a relying-party surface that is actually there', () => {
    // Non-vacuity for the enumeration: an empty or tiny module set would make
    // every assertion below pass by scanning nothing.
    expect(modules.length).toBeGreaterThanOrEqual(10);
    expect(modules).toContain(path.join('src', 'routes', 'sso.ts'));
    for (const rel of modules) {
      expect(fs.existsSync(path.join(BACKEND, rel))).toBe(true);
    }
  });

  it('reads no header outside the value-scoped permission', () => {
    const offenders: string[] = [];
    for (const rel of modules) {
      const source = withoutComments(fs.readFileSync(path.join(BACKEND, rel), 'utf8'));
      for (const match of source.matchAll(HEADER_READ)) {
        const header = (match[1] ?? match[2] ?? match[0]).toLowerCase();
        if (PERMITTED_HEADER_READS.has(header)) continue;
        const line = source.slice(0, match.index ?? 0).split('\n').length;
        offenders.push(`${rel}:${line}: reads '${header}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('can see a header read at all — the permitted one is really there', () => {
    // The control. Without it, a regex that matched nothing would report a
    // clean surface, and "no module reads a host header" would be a statement
    // about a scanner that cannot see reads rather than about the code.
    const seen = new Set<string>();
    for (const rel of modules) {
      const source = withoutComments(fs.readFileSync(path.join(BACKEND, rel), 'utf8'));
      for (const match of source.matchAll(HEADER_READ)) {
        seen.add((match[1] ?? match[2] ?? match[0]).toLowerCase());
      }
    }
    expect([...seen]).toContain('user-agent');
  });

  it('names the forbidden headers so a reviewer sees what is being claimed', () => {
    // The claim is about these specific headers; the assertion above is wider.
    // Stating them keeps the census readable as evidence rather than as a regex.
    for (const header of FORBIDDEN_HEADERS) {
      expect(PERMITTED_HEADER_READS.has(header)).toBe(false);
    }
  });
});
