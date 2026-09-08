/**
 * RH-P3.C4 — THE REVISION GATE (Amendment S-A6; MCP design `de73f9f8` §1.2 as
 * amended; owner Rulings 1 and 2 of 2026-08-27, rulings `2b2f663d`; re-pointed
 * at SDK v2 by card `bec87735`, KS-7).
 *
 * ── What §1.2 requires, verbatim ──
 *
 *   "A gate MUST assert all three facts independently: (a) the installed
 *    direct SDK version and integrity equal the committed lock, (b) the SDK's
 *    exported `LATEST_PROTOCOL_VERSION` equals the explicitly expected
 *    released revision, and (c) the server advertises that expected revision.
 *    A test that only compares the server to the SDK constant is a
 *    self-consistency check, not a revision gate."
 *
 * The expected values live in `mcp/contract/protocolRevision` — a fixture the
 * SDK cannot move — and every leg is measured against IT, never against
 * another leg.
 *
 * ── What round 2 taught this file (REJECT `7c2d4dbb`, B4) ──
 *
 * The first version of leg (a) read version/resolved/integrity out of
 * `node_modules/.package-lock.json` and compared them to the same three fields
 * in `package-lock.json`. That compares **two metadata records to each other**
 * and never looks at a single installed byte — while the suite called it "byte
 * for byte". The reviewer changed the installed SDK's `initialize`
 * implementation, left the metadata untouched, and this gate stayed green
 * 15/15. It also stayed green through an `overrides` entry, which can
 * substitute the package wholesale.
 *
 * npm's `integrity` is a hash of the registry TARBALL, and an extracted tree
 * cannot be hashed back into it. So leg (a) pins what it can actually verify:
 * a deterministic **content digest of the installed package tree** (sorted
 * relative paths, each with its own sha256, folded into one), recorded in the
 * contract fixture as a reviewed value. Changing the SDK changes the digest,
 * and updating it is exactly the reviewed contract change §1.2 requires. The
 * metadata comparison stays as well — it catches a lock that drifted from the
 * manifest — but it is no longer described as more than it is.
 *
 * ── SDK v2: the SDK is two packages, and the digest fails closed ──
 *
 * `@modelcontextprotocol/server` is the direct dependency; it pins
 * `@modelcontextprotocol/core` — where the protocol code lives — at an exact
 * version of its own. Leg (a) therefore measures BOTH trees: the direct pin,
 * the committed and installed lock entries, the on-disk manifests and the two
 * content digests, plus the server package's own declared pin on core, so a
 * server patch could not float the protocol code past the fixture. Leg (b)
 * reads `LATEST_PROTOCOL_VERSION` from `@modelcontextprotocol/server`: the
 * `/core` main entry exports the same name as `undefined`, and a leg that read
 * it from there would pass by comparing `undefined` to nothing.
 *
 * Card `dd6be92c` (deferred from the round-1 functional review of `9b2476f1`):
 * the first digest silently skipped every directory entry that was neither a
 * directory nor a regular file, so a symlink planted under the package left
 * the gate green. The digest now REFUSES such a tree, every non-regular entry
 * is censused by path, and an on-disk mutation in `qa/c4-gates-redproof`
 * plants a real symlink and watches the suite go red on that assertion.
 *
 * The date-style check missed three forms too: a template substitution, a
 * concatenation, and a second file under `contract/`. It scans the surface
 * RECURSIVELY, exempts only the one named fixture, and folds constants via
 * `support/astStrings` — the same resolution the posture gate uses, from one
 * source so the two cannot drift.
 *
 * (c) is asserted twice on purpose: here at the module the server exports, and
 * over the wire in `c4McpProtocol.test.ts`, where a real client reads a real
 * `initialize` result. The reviewer confirmed that leg goes red when the
 * installed SDK answers a different revision, which is what it is for.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { MCP_PROTOCOL_REVISION } from '../mcp/server';
import { authoredDateLiterals, readSurface } from './support/astStrings';
import {
  EXPECTED_MCP_CORE_CONTENT_DIGEST,
  EXPECTED_MCP_PROTOCOL_REVISION,
  EXPECTED_MCP_SDK_CONTENT_DIGEST,
  EXPECTED_MCP_SDK_VERSION,
  MCP_CORE_LOCK_KEY,
  MCP_CORE_PACKAGE,
  MCP_SDK_LOCK_KEY,
  MCP_SDK_PACKAGE,
} from '../mcp/contract/protocolRevision';

const backend = path.join(__dirname, '..', '..');
const mcpDir = path.join(__dirname, '..', 'mcp');
/** The ONE file allowed to name the expected revision. */
const FIXTURE_FILE = 'contract/protocolRevision.ts';

// ───────────────────────────── the three legs ─────────────────────────────

export interface LockEntry { version?: string; resolved?: string; integrity?: string }

/** Leg (a), for ONE of the two packages the SDK is made of. */
export interface PackageFacts {
  name: string;
  lockKey: string;
  /** The tarball basename the lock must resolve to (`server-2.0.0.tgz`). */
  artifact: string;
  expectedContentDigest: string;
  /** `package-lock.json` — the COMMITTED resolution. */
  committed: LockEntry | undefined;
  /** `node_modules/.package-lock.json` — what npm recorded as INSTALLED. */
  installed: LockEntry | undefined;
  /** The version in the installed package's own manifest, on disk. */
  installedManifestVersion: string | undefined;
  /** A digest over the installed package's actual FILES. */
  installedContentDigest: string | undefined;
  /** Every entry under the installed tree that is neither a directory nor a regular file. */
  nonRegularEntries: string[];
}

export interface RevisionFacts {
  expectedRevision: string;
  expectedSdkVersion: string;
  /** `package.json` dependencies entry for the DIRECT package — must be exact, not a range. */
  declaredDependency: string | undefined;
  /** What the INSTALLED direct package declares for the protocol package. */
  serverDeclaresCore: string | undefined;
  /** Any `overrides`/`resolutions` key that could substitute a package. */
  substitutions: string[];
  server: PackageFacts;
  core: PackageFacts;
  sdkConstant: string;
  serverAdvertised: string;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function packageViolations(facts: PackageFacts, expectedVersion: string): string[] {
  const violations: string[] = [];
  const {
    name, lockKey, artifact, expectedContentDigest, committed, installed,
    installedManifestVersion, installedContentDigest, nonRegularEntries,
  } = facts;

  if (committed === undefined) {
    violations.push(`(a) package-lock.json has no committed entry for ${lockKey}`);
  } else {
    if (committed.version !== expectedVersion) {
      violations.push(`(a) the committed lock resolves ${name} to '${committed.version}', the contract fixture expects '${expectedVersion}'`);
    }
    if (!committed.integrity || !committed.integrity.startsWith('sha512-')) {
      violations.push(`(a) the committed lock entry for ${name} carries no sha512 integrity ('${committed.integrity ?? ''}') — §1.2 requires a lock entry containing the resolved artifact AND integrity`);
    }
    if (!committed.resolved || !committed.resolved.includes(artifact)) {
      violations.push(`(a) the committed lock resolves ${name} to '${committed.resolved ?? ''}', which is not the ${artifact} artifact`);
    }
  }

  if (installed === undefined) {
    // Not a skip. A gate that cannot read the installed tree has not checked
    // the fact it exists to check, and must say so in red.
    violations.push(`(a) node_modules/.package-lock.json has no installed entry for ${lockKey} — the installed tree could not be compared to the committed lock`);
  } else if (committed !== undefined) {
    for (const field of ['version', 'resolved', 'integrity'] as const) {
      if (installed[field] !== committed[field]) {
        violations.push(`(a) ${name}: installed ${field} '${installed[field] ?? ''}' != committed ${field} '${committed[field] ?? ''}'`);
      }
    }
  }

  if (installedManifestVersion === undefined) {
    violations.push(`(a) ${name} is not present in node_modules — nothing was installed to compare`);
  } else if (installedManifestVersion !== expectedVersion) {
    violations.push(`(a) ${name} on disk is version '${installedManifestVersion}', the contract fixture expects '${expectedVersion}'`);
  }

  // Card dd6be92c: a tree with a symlink (or any other non-regular entry) is
  // refused outright — a link can point the digest at bytes that are not the
  // package's own, and skipping it is how the first digest stayed green.
  if (nonRegularEntries.length > 0) {
    violations.push(`(a) the installed ${name} tree contains entries that are neither directories nor regular files [${nonRegularEntries.join(', ')}] — a symlink or special file under the package is refused, not skipped`);
  }

  // THE leg round 2 broke: the CONTENT, not another metadata record.
  if (installedContentDigest === undefined) {
    violations.push(`(a) the installed ${name} tree could not be digested — its content was not verified`);
  } else if (installedContentDigest !== expectedContentDigest) {
    violations.push(`(a) the installed ${name} CONTENT digests to '${installedContentDigest}', the contract fixture expects '${expectedContentDigest}' — the files on disk are not the reviewed ones, whatever the lock metadata says`);
  }

  return violations;
}

export function revisionViolations(facts: RevisionFacts): string[] {
  const violations: string[] = [];
  const {
    expectedRevision, expectedSdkVersion, declaredDependency, serverDeclaresCore,
    substitutions, server, core, sdkConstant, serverAdvertised,
  } = facts;

  // ── (a) the INSTALLED packages are the committed ones ──
  if (declaredDependency === undefined) {
    violations.push(`(a) ${MCP_SDK_PACKAGE} is not a direct dependency of backend/package.json`);
  } else if (!EXACT_VERSION.test(declaredDependency)) {
    violations.push(`(a) ${MCP_SDK_PACKAGE} is declared as '${declaredDependency}', which is a RANGE — §1.2 requires an exactly versioned direct dependency`);
  } else if (declaredDependency !== expectedSdkVersion) {
    violations.push(`(a) ${MCP_SDK_PACKAGE} is declared '${declaredDependency}', the contract fixture expects '${expectedSdkVersion}'`);
  }

  for (const key of substitutions) {
    violations.push(`(a) package.json declares '${key}', which can substitute the resolved package behind the lock — an exact pin that an override can replace is not a pin`);
  }

  // The protocol package is pinned by the direct package, not by the board:
  // that pin has to be exact too, or a server patch could float the code
  // that actually speaks the wire.
  if (serverDeclaresCore === undefined) {
    violations.push(`(a) the installed ${MCP_SDK_PACKAGE} declares no dependency on ${MCP_CORE_PACKAGE} — the protocol package is unpinned`);
  } else if (serverDeclaresCore !== expectedSdkVersion) {
    violations.push(`(a) the installed ${MCP_SDK_PACKAGE} declares ${MCP_CORE_PACKAGE} as '${serverDeclaresCore}' — the contract fixture expects the protocol package pinned at exactly '${expectedSdkVersion}'`);
  }

  violations.push(...packageViolations(server, expectedSdkVersion));
  violations.push(...packageViolations(core, expectedSdkVersion));

  // ── (b) the SDK's exported constant equals the EXPECTED released revision ──
  if (sdkConstant !== expectedRevision) {
    violations.push(`(b) the SDK exports LATEST_PROTOCOL_VERSION '${sdkConstant}', the contract fixture expects '${expectedRevision}' — an SDK that moved the wire revision is a reviewed contract change, not a silent one`);
  }

  // ── (c) the server advertises that expected revision ──
  if (serverAdvertised !== expectedRevision) {
    violations.push(`(c) the server advertises '${serverAdvertised}', the contract fixture expects '${expectedRevision}'`);
  }

  return violations;
}

// ───────────────────────── reading the real facts ─────────────────────────

function readJson(file: string): Record<string, any> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function lockEntry(lockfile: Record<string, any> | undefined, key: string): LockEntry | undefined {
  const entry = lockfile?.packages?.[key];
  if (!entry) return undefined;
  return { version: entry.version, resolved: entry.resolved, integrity: entry.integrity };
}

/**
 * Every entry under `root` that is neither a directory nor a regular file,
 * as relative paths. Symlinks are reported as such and NOT followed — a link
 * to a directory is still a link. Empty for the trees npm extracts from a
 * registry tarball.
 */
export function nonRegularEntries(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) found.push(`${rel} (symlink)`);
      else if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (!entry.isFile()) found.push(`${rel} (special)`);
    }
  };
  try {
    walk(root, '');
  } catch {
    return found;
  }
  return found.sort();
}

/**
 * A deterministic digest of a package's installed FILES: sorted relative
 * paths, each folded in with its own sha256. Two independent `npm ci` runs of
 * the same tarball produce the same value; any changed byte in any file
 * changes it.
 *
 * FAIL-CLOSED (card dd6be92c): a tree containing anything other than
 * directories and regular files has no digest at all. The first version
 * returned `[]` for such an entry and carried on, so a symlink planted under
 * the package was invisible to the gate.
 */
export function contentDigest(root: string): string | undefined {
  const collect = (dir: string, prefix: string): Array<[string, string]> =>
    fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const full = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || !(entry.isDirectory() || entry.isFile())) {
          throw new Error(`non-regular entry under the package: ${rel}`);
        }
        if (entry.isDirectory()) return collect(full, rel);
        return [[rel, full] as [string, string]];
      });
  try {
    const digest = crypto.createHash('sha256');
    for (const [rel, full] of collect(root, '')) {
      digest.update(rel, 'utf8');
      digest.update('\0');
      digest.update(crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'), 'utf8');
      digest.update('\n');
    }
    return `sha256-${digest.digest('hex')}`;
  } catch {
    return undefined;
  }
}

/** `overrides` / `resolutions` keys that could substitute the pinned package. */
function substitutionKeys(manifest: Record<string, any> | undefined): string[] {
  const found: string[] = [];
  for (const field of ['overrides', 'resolutions', 'pnpm']) {
    const value = manifest?.[field];
    if (value && typeof value === 'object' && Object.keys(value).length > 0) found.push(field);
  }
  return found;
}

function readPackageFacts(name: string, lockKey: string, expectedContentDigest: string): PackageFacts {
  const installedRoot = path.join(backend, 'node_modules', name);
  const installedManifest = readJson(path.join(installedRoot, 'package.json'));
  return {
    name,
    lockKey,
    artifact: `${name.split('/').pop()}-${EXPECTED_MCP_SDK_VERSION}.tgz`,
    expectedContentDigest,
    committed: lockEntry(readJson(path.join(backend, 'package-lock.json')), lockKey),
    installed: lockEntry(readJson(path.join(backend, 'node_modules', '.package-lock.json')), lockKey),
    installedManifestVersion: installedManifest?.version,
    installedContentDigest: contentDigest(installedRoot),
    nonRegularEntries: nonRegularEntries(installedRoot),
  };
}

export function readRevisionFacts(): RevisionFacts {
  const manifest = readJson(path.join(backend, 'package.json'));
  const serverManifest = readJson(path.join(backend, 'node_modules', MCP_SDK_PACKAGE, 'package.json'));
  return {
    expectedRevision: EXPECTED_MCP_PROTOCOL_REVISION,
    expectedSdkVersion: EXPECTED_MCP_SDK_VERSION,
    declaredDependency: manifest?.dependencies?.[MCP_SDK_PACKAGE],
    serverDeclaresCore: serverManifest?.dependencies?.[MCP_CORE_PACKAGE],
    substitutions: substitutionKeys(manifest),
    server: readPackageFacts(MCP_SDK_PACKAGE, MCP_SDK_LOCK_KEY, EXPECTED_MCP_SDK_CONTENT_DIGEST),
    core: readPackageFacts(MCP_CORE_PACKAGE, MCP_CORE_LOCK_KEY, EXPECTED_MCP_CORE_CONTENT_DIGEST),
    sdkConstant: LATEST_PROTOCOL_VERSION,
    serverAdvertised: MCP_PROTOCOL_REVISION,
  };
}

// ──────────────────────────── the style check ────────────────────────────

/** Every surface module EXCEPT the one fixture allowed to name the revision. */
export function surfaceModules(): Array<{ file: string; source: string }> {
  return readSurface(mcpDir).filter((entry) => entry.file !== FIXTURE_FILE);
}

// ────────────────────────────────── gate ──────────────────────────────────

describe('the MCP revision gate (S-A6 / de73f9f8 §1.2)', () => {
  it('asserts all three facts against the contract fixture, independently', () => {
    expect(revisionViolations(readRevisionFacts())).toEqual([]);
  });

  it('(b) the pinned SDK exports the expected released revision', () => {
    expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(EXPECTED_MCP_PROTOCOL_REVISION).toBe('2025-11-25');
  });

  it('(b) reads the constant from the SERVER package, where it is a string', () => {
    // The `/core` main entry exports `LATEST_PROTOCOL_VERSION` too — as
    // `undefined`. A leg (b) that imported from there would compare nothing to
    // the fixture and could never object. This pins where the value is read
    // and that a real string arrived.
    expect(typeof LATEST_PROTOCOL_VERSION).toBe('string');
    const source = fs.readFileSync(__filename, 'utf8');
    expect(source).toContain("import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';");
    const imports = source.split('\n').filter((line) => line.startsWith('import '));
    expect(imports.filter((line) => line.includes('@modelcontextprotocol/')))
      .toEqual(["import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';"]);
  });

  it('(c) the server advertises the expected released revision', () => {
    expect(MCP_PROTOCOL_REVISION).toBe('2025-11-25');
  });

  it('(a) the installed SDK is the committed one — metadata AND content, both packages', () => {
    const facts = readRevisionFacts();
    // Read back explicitly, so a reader sees WHAT was compared rather than
    // trusting the classifier to have compared anything.
    expect(facts.declaredDependency).toBe(EXPECTED_MCP_SDK_VERSION);
    expect(facts.serverDeclaresCore).toBe(EXPECTED_MCP_SDK_VERSION);
    expect(facts.substitutions).toEqual([]);
    for (const pkg of [facts.server, facts.core]) {
      expect([pkg.name, pkg.committed?.version]).toEqual([pkg.name, EXPECTED_MCP_SDK_VERSION]);
      expect([pkg.name, pkg.installedManifestVersion]).toEqual([pkg.name, EXPECTED_MCP_SDK_VERSION]);
      expect([pkg.name, pkg.installed?.integrity]).toEqual([pkg.name, pkg.committed?.integrity]);
      expect(String(pkg.committed?.integrity)).toMatch(/^sha512-/);
      expect(String(pkg.committed?.resolved)).toContain(pkg.artifact);
    }
    // The metadata above is two records agreeing with each other. THIS is the
    // installed content (REJECT 7c2d4dbb B4) — for each package separately,
    // so the assertion names the tree that moved.
    expect(facts.server.installedContentDigest).toBe(EXPECTED_MCP_SDK_CONTENT_DIGEST);
    expect(facts.core.installedContentDigest).toBe(EXPECTED_MCP_CORE_CONTENT_DIGEST);
    // Two different packages, two different trees: a fixture that carried the
    // same value twice would have digested one of them and labelled it both.
    expect(EXPECTED_MCP_SDK_CONTENT_DIGEST).not.toBe(EXPECTED_MCP_CORE_CONTENT_DIGEST);
  });

  it('(a) the installed SDK trees contain only directories and regular files (dd6be92c)', () => {
    const facts = readRevisionFacts();
    expect(facts.server.nonRegularEntries).toEqual([]);
    expect(facts.core.nonRegularEntries).toEqual([]);
  });

  it('(a) the SDK is exactly the two packages KS-6 ratified, and no client', () => {
    // The budget sentence ("SDK + zod + undici only", read at KS-6) is
    // satisfied by server + core + zod. `@modelcontextprotocol/client` would
    // need a fresh owner ruling; the lock is where it would first appear.
    const lock = readJson(path.join(backend, 'package-lock.json'));
    const sdkKeys = Object.keys(lock?.packages ?? {})
      .filter((key) => key.includes('node_modules/@modelcontextprotocol/'))
      .sort();
    expect(sdkKeys).toEqual([MCP_CORE_LOCK_KEY, MCP_SDK_LOCK_KEY].sort());
    const manifest = readJson(path.join(backend, 'package.json'));
    expect(Object.keys(manifest?.dependencies ?? {}).filter((name) => name.startsWith('@modelcontextprotocol/')))
      .toEqual([MCP_SDK_PACKAGE]);
  });

  /**
   * ── What this check is, and what it is NOT ──
   *
   * §1.2 calls it an "implementation-style check", and that is exactly the
   * weight it carries. Round-3 verdict `5cb6ff8a` B3 was right to object to
   * the name it used to have — "the fixture and nowhere else" — and right
   * about the remedy: "either implement a sound enough constant/value analysis
   * for the claimed property, or narrow the governing assertion honestly; do
   * not keep an 'and nowhere else' claim the suite cannot enforce."
   *
   * The second. A static scan cannot prove a value is absent from a module in
   * a language where it can be assembled at runtime from anything; each round
   * of "add the spelling the reviewer used" made the scan longer without
   * making it sound. `.concat()`, `[…].join()`, `String.fromCharCode()` and
   * tagged templates are now folded because they are cheap and were named, but
   * that is a better lint, not a proof.
   *
   * What actually guarantees the revision is legs (b) and (c): the SDK
   * constant and the server's advertised value are both measured against the
   * fixture, and the wire is read in `c4McpProtocol.test.ts`. A module that
   * assembled `2025-11-25` in some form this scan cannot see would still not
   * change what the server advertises — that is read from one place and gated.
   */
  it('finds no authored revision literal in a surface module (style check, §1.2)', () => {
    const authored = surfaceModules().flatMap(({ file, source }) => authoredDateLiterals(file, source));
    expect(authored).toEqual([]);
    // And the fixture really does carry it — otherwise the check above passes
    // because the value was deleted rather than because it is well placed.
    const fixture = fs.readFileSync(path.join(mcpDir, 'contract', 'protocolRevision.ts'), 'utf8');
    expect(authoredDateLiterals(FIXTURE_FILE, fixture))
      .toEqual([`${FIXTURE_FILE}: '2025-11-25'`]);
  });

  it('states its own limit: the style check is a lint, the wire is the proof', () => {
    // A value this scan cannot resolve is still not the advertised revision.
    // Recorded as an assertion so the limit is read where the check is read,
    // rather than living only in a comment someone may not reach.
    const assembledAtRuntime = 'const parts = readParts(); export const REV = parts.join("-");';
    expect(authoredDateLiterals('server.ts', assembledAtRuntime)).toEqual([]);
    // …and legs (b)/(c) are unmoved by it, which is the point.
    expect(revisionViolations({ ...readRevisionFacts() })).toEqual([]);
    expect(MCP_PROTOCOL_REVISION).toBe(EXPECTED_MCP_PROTOCOL_REVISION);
  });

  it('the style check covers the surface RECURSIVELY, not just its top level', () => {
    // Round 2 hid a date in a second file under contract/. The scan reaches
    // every module; only the ONE named fixture is exempt.
    const scanned = surfaceModules().map((module) => module.file);
    expect(scanned).toContain('httpRoute.ts');
    expect(scanned).toContain('webBridge.ts');
    expect(scanned).not.toContain(FIXTURE_FILE);
    expect(readSurface(mcpDir).map((module) => module.file)).toContain(FIXTURE_FILE);
  });

  // ─────────── the gate goes RED when any one fact drifts ───────────

  describe('red-mutation proof', () => {
    const facts = (): RevisionFacts => readRevisionFacts();

    it('catches a flipped contract fixture', () => {
      const violations = revisionViolations({ ...facts(), expectedRevision: '2026-07-28' }).join('\n');
      expect(violations).toContain('(b) the SDK exports LATEST_PROTOCOL_VERSION');
      expect(violations).toContain('(c) the server advertises');
    });

    it('catches SDK constant drift: a bumped SDK moves the wire and the gate objects', () => {
      // THE case a self-consistency check could not see. Server and SDK still
      // agree with EACH OTHER — both moved — and the gate is red anyway.
      const drifted = { ...facts(), sdkConstant: '2026-07-28', serverAdvertised: '2026-07-28' };
      expect(revisionViolations(drifted).join('\n'))
        .toContain("the SDK exports LATEST_PROTOCOL_VERSION '2026-07-28'");
    });

    it('catches a server that advertises something the SDK does not', () => {
      expect(revisionViolations({ ...facts(), serverAdvertised: '2026-07-28' }).join('\n'))
        .toContain("(c) the server advertises '2026-07-28'");
    });

    it('catches a dependency loosened from an exact pin to a range', () => {
      expect(revisionViolations({ ...facts(), declaredDependency: '^2.0.0' }).join('\n'))
        .toContain('which is a RANGE');
    });

    it('catches the server package loosening its own pin on the protocol package', () => {
      // A `^2.0.0` inside the installed server manifest is a float the board
      // never declared and the lock would follow on the next resolve.
      const violations = revisionViolations({ ...facts(), serverDeclaresCore: '^2.0.0' });
      expect(violations.join('\n')).toContain('the protocol package pinned at exactly');
      expect(violations).toHaveLength(1);
      expect(revisionViolations({ ...facts(), serverDeclaresCore: undefined }).join('\n'))
        .toContain('the protocol package is unpinned');
    });

    it('catches an override that could substitute the pinned package', () => {
      expect(revisionViolations({ ...facts(), substitutions: ['overrides'] }).join('\n'))
        .toContain('an exact pin that an override can replace is not a pin');
    });

    it('catches an installed tree that does not match the committed lock', () => {
      const real = facts();
      expect(revisionViolations({
        ...real, server: { ...real.server, installed: { ...real.server.installed, integrity: 'sha512-somethingElseEntirely' } },
      }).join('\n')).toContain(`${MCP_SDK_PACKAGE}: installed integrity`);
    });

    it('catches CHANGED INSTALLED BYTES while every metadata record still agrees', () => {
      // Round 2's B4, exactly: the reviewer edited the installed SDK's
      // initialize implementation and left version/resolved/integrity alone.
      // Every metadata comparison above passes on these facts; only the
      // content digest objects.
      const real = facts();
      const tampered = { ...real, server: { ...real.server, installedContentDigest: 'sha256-adifferenttreeentirely' } };
      const violations = revisionViolations(tampered);
      expect(violations.join('\n')).toContain(`the installed ${MCP_SDK_PACKAGE} CONTENT digests to`);
      expect(violations).toHaveLength(1);
    });

    it('catches changed bytes in the PROTOCOL package while the server package is intact', () => {
      // The v2 split moved the protocol implementation into core. A digest
      // over the server package alone would stay green through this.
      const real = facts();
      const tampered = { ...real, core: { ...real.core, installedContentDigest: 'sha256-thecorewasedited' } };
      const violations = revisionViolations(tampered);
      expect(violations.join('\n')).toContain(`the installed ${MCP_CORE_PACKAGE} CONTENT digests to`);
      expect(violations).toHaveLength(1);
    });

    it('catches a lock entry stripped of its integrity', () => {
      const real = facts();
      expect(revisionViolations({
        ...real, core: { ...real.core, committed: { ...real.core.committed, integrity: undefined } },
      }).join('\n')).toContain(`entry for ${MCP_CORE_PACKAGE} carries no sha512 integrity`);
    });

    it('catches a lock that resolves the right version from the wrong artifact', () => {
      const real = facts();
      expect(revisionViolations({
        ...real,
        core: { ...real.core, committed: { ...real.core.committed, resolved: 'https://registry.npmjs.org/@modelcontextprotocol/core/-/core-2.0.0-rc.1.tgz' } },
      }).join('\n')).toContain('which is not the core-2.0.0.tgz artifact');
    });

    it('FAILS rather than skips when the installed tree cannot be read', () => {
      const real = facts();
      expect(revisionViolations({ ...real, server: { ...real.server, installed: undefined } }).join('\n'))
        .toContain('the installed tree could not be compared');
      expect(revisionViolations({ ...real, core: { ...real.core, installedManifestVersion: undefined } }).join('\n'))
        .toContain(`${MCP_CORE_PACKAGE} is not present in node_modules`);
      expect(revisionViolations({ ...real, server: { ...real.server, installedContentDigest: undefined } }).join('\n'))
        .toContain(`the installed ${MCP_SDK_PACKAGE} tree could not be digested`);
    });

    it('catches a non-regular entry under a package as its own violation (dd6be92c)', () => {
      const real = facts();
      const linked = { ...real, core: { ...real.core, nonRegularEntries: ['dist/index.cjs (symlink)'] } };
      const violations = revisionViolations(linked);
      expect(violations.join('\n')).toContain('neither directories nor regular files [dist/index.cjs (symlink)]');
      expect(violations.join('\n')).toContain('is refused, not skipped');
      expect(violations).toHaveLength(1);
    });

    it('catches an SDK bump where every metadata record was updated and the CONTENT was not re-reviewed', () => {
      // Round 2 noted the old gate only went red on a coordinated bump because
      // a mutation test hard-coded an expectation — the production assertion
      // itself accepted the new metadata. This models the real thing: someone
      // bumps the SDK, updates the version everywhere including the fixture,
      // and the trees on disk are genuinely different. Every field the old
      // gate compared now agrees with every other. Only the content digests,
      // which no metadata edit can produce, still object.
      const real = facts();
      const bump = (pkg: PackageFacts, digest: string): PackageFacts => ({
        ...pkg,
        artifact: `${pkg.name.split('/').pop()}-2.1.0.tgz`,
        committed: { version: '2.1.0', resolved: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').pop()}-2.1.0.tgz`, integrity: 'sha512-newtarball' },
        installed: { version: '2.1.0', resolved: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').pop()}-2.1.0.tgz`, integrity: 'sha512-newtarball' },
        installedManifestVersion: '2.1.0',
        // A different release is different FILES.
        installedContentDigest: digest,
      });
      const bumped = {
        ...real,
        expectedSdkVersion: '2.1.0',
        declaredDependency: '2.1.0',
        serverDeclaresCore: '2.1.0',
        server: bump(real.server, 'sha256-whatever-server-2-1-0-actually-hashes-to'),
        core: bump(real.core, 'sha256-whatever-core-2-1-0-actually-hashes-to'),
      };
      const violations = revisionViolations(bumped);
      expect(violations.join('\n')).toContain(`the installed ${MCP_SDK_PACKAGE} CONTENT digests to`);
      expect(violations.join('\n')).toContain(`the installed ${MCP_CORE_PACKAGE} CONTENT digests to`);
      // And ONLY those — every other leg was satisfiable by editing metadata.
      expect(violations).toHaveLength(2);
      // Updating the digests as well makes it pass, and that is correct: doing
      // so IS the reviewed contract change §1.2 requires, and it is two lines
      // in the fixture for a reviewer to see.
      expect(revisionViolations({
        ...bumped,
        server: { ...bumped.server, expectedContentDigest: 'sha256-whatever-server-2-1-0-actually-hashes-to' },
        core: { ...bumped.core, expectedContentDigest: 'sha256-whatever-core-2-1-0-actually-hashes-to' },
      })).toEqual([]);
    });

    // ── the digest itself, on a REAL tree (dd6be92c) ──

    describe('contentDigest on disk', () => {
      let root = '';
      beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-digest-'));
        fs.mkdirSync(path.join(root, 'dist'));
        fs.writeFileSync(path.join(root, 'package.json'), '{"name":"probe","version":"1.0.0"}\n');
        fs.writeFileSync(path.join(root, 'dist', 'index.cjs'), 'module.exports = 1;\n');
      });
      afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

      it('is deterministic over a tree of directories and regular files', () => {
        const first = contentDigest(root);
        expect(first).toMatch(/^sha256-[0-9a-f]{64}$/);
        expect(contentDigest(root)).toBe(first);
        expect(nonRegularEntries(root)).toEqual([]);
      });

      it('changes when one byte changes', () => {
        const before = contentDigest(root);
        fs.appendFileSync(path.join(root, 'dist', 'index.cjs'), ' ');
        expect(contentDigest(root)).not.toBe(before);
      });

      it('REFUSES a tree with a symlink in it, and names the link', () => {
        // The dd6be92c reproduction: a link under the package, every regular
        // file untouched. The first digest ignored it and stayed green.
        fs.symlinkSync(path.join(root, 'package.json'), path.join(root, 'dist', 'planted'));
        expect(nonRegularEntries(root)).toEqual(['dist/planted (symlink)']);
        expect(contentDigest(root)).toBeUndefined();
      });

      it('REFUSES a symlink even when it points at a directory', () => {
        fs.symlinkSync(path.join(root, 'dist'), path.join(root, 'linked-dir'));
        expect(nonRegularEntries(root)).toEqual(['linked-dir (symlink)']);
        expect(contentDigest(root)).toBeUndefined();
      });

      it('is not vacuous: the two refusals above each fail the gate through the classifier', () => {
        const real = facts();
        const planted = { ...real, server: { ...real.server, installedContentDigest: undefined, nonRegularEntries: ['dist/planted (symlink)'] } };
        const violations = revisionViolations(planted);
        expect(violations.join('\n')).toContain('[dist/planted (symlink)]');
        expect(violations.join('\n')).toContain('could not be digested');
        expect(violations).toHaveLength(2);
      });
    });

    it('catches a date literal authored into a surface module', () => {
      expect(authoredDateLiterals('server.ts', "const rev = '2025-11-25';\nexport default rev;\n"))
        .toEqual(["server.ts: '2025-11-25'"]);
    });

    it('catches a date hidden in a template substitution', () => {
      // Round 2's exact form, including the conditional that discards it.
      const mutated = "const rev = LATEST ? `2025-${'11'}-25` : LATEST;\nexport default rev;\n";
      expect(authoredDateLiterals('server.ts', mutated)).toEqual(["server.ts: '2025-11-25'"]);
    });

    it('catches a date assembled by concatenation', () => {
      const mutated = "const rev = LATEST ? ('2025-' + '11-25') : LATEST;\nexport default rev;\n";
      expect(authoredDateLiterals('server.ts', mutated)).toEqual(["server.ts: '2025-11-25'"]);
    });

    // Round-3 verdict `5cb6ff8a` B3 named four more constant constructions.
    // They are folded now — a better lint, not a soundness claim.
    it('catches a date built with .concat()', () => {
      expect(authoredDateLiterals('shape.ts', "export const R = '2025-'.concat('11-25');"))
        .toEqual(["shape.ts: '2025-11-25'"]);
    });

    it('catches a date built with Array.join()', () => {
      expect(authoredDateLiterals('shape.ts', "export const R = ['2025-', '11-25'].join('');"))
        .toEqual(["shape.ts: '2025-11-25'"]);
    });

    it('catches a date built with String.fromCharCode()', () => {
      expect(authoredDateLiterals('shape.ts', 'export const R = String.fromCharCode(50,48,50,53,45,49,49,45,50,53);'))
        .toEqual(["shape.ts: '2025-11-25'"]);
    });

    it('catches a date inside a frozen constant object', () => {
      expect(authoredDateLiterals('shape.ts', "export const T = Object.freeze({ value: '2025-'.concat('11-25') });"))
        .toEqual(["shape.ts: '2025-11-25'"]);
    });

    it('catches a date behind String.raw', () => {
      expect(authoredDateLiterals('shape.ts', 'export const R = String.raw`2025-11-25`;'))
        .toEqual(["shape.ts: '2025-11-25'"]);
    });

    it('leaves a date in a COMMENT alone — §1.2 keeps 2026-07-28 as direction', () => {
      expect(authoredDateLiterals('server.ts', '// the 2026-07-28 rev deletes the header\n')).toEqual([]);
    });

    it('is not vacuous: the surface it scans is actually there', () => {
      const modules = surfaceModules();
      expect(modules.length).toBeGreaterThanOrEqual(9);
      expect(modules.map((module) => module.file)).toContain('server.ts');
    });
  });
});
