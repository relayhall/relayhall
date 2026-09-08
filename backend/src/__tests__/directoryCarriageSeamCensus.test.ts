/**
 * R-3, B-L2, B-L15 and B-L12 — THE SEAM CANNOT GROW SILENTLY.
 *
 * RH-LENSES-a, card `74e02a05`; design v7.1 ANNEX `d6637a92` §A8.1.
 *
 * ── WHY THIS IS AN ENUMERATION AND NOT A COUNT ────────────────────────────
 *
 * Design v5's `R-3` asserted a literal number: *"five authorization/disclosure
 * lines in three services … does not grow to six"*. That number was ALREADY
 * FALSE before the record shipped — the KW1 knowledge plane had landed a
 * sixth, correct, narrowed disclosure read at `routes/knowledge.ts` — and it
 * would have said **nothing at all** about a hostile reader arriving with the
 * same arity. A literal count is falsified by every correct addition and blind
 * to the one thing it exists to catch.
 *
 * So this control does not count and does not classify. It **ENUMERATES**, and
 * compares the enumeration to a **register a human must edit deliberately** —
 * the shape `livenessWriteCensus.test.ts` establishes in-tree, written for the
 * same reason: *"the defect was a MISSING entry, and a control that can only
 * judge the entries it already knows about cannot catch a missing one."*
 *
 * ── THE FOUR PROPERTIES ───────────────────────────────────────────────────
 *
 *  1  Every `group_members` occurrence in the tree is REGISTERED, with its
 *     class and one sentence saying why it is admissible; and every register
 *     entry still has an occurrence. Both directions, so a register cannot
 *     outlive its subject.
 *  2  `B-L2`, first half: exactly the entries classed `write` are in
 *     `GroupService`. `DirectoryCarriageService` — the seam — contains NO
 *     `group_members` DML of its own, which is what makes *"recomputed from
 *     carriage, never patched incrementally"* true rather than asserted: there
 *     is no incremental path to take.
 *  3  `B-L2`, second half: **no authorization, disclosure or authentication
 *     reader of `group_members` reads either carriage table.** The two stores
 *     meet in exactly one file. That is prohibition 1 — *"no second membership
 *     store may become a second authority store"* — measured over the source,
 *     with migration 127's refusal of a foreign key to `groups` as the
 *     structural half.
 *  4  `B-L15`: every carriage and binding WRITER takes the §3.2(c) locks in
 *     order, and takes them BEFORE the discovery each one ranges over.
 *
 * And `B-L12`: no MCP tool names this family. The MCP registry is a
 * hand-written list, not derived from the mounts, so the absence is measured
 * against the list.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { directoryWriteSinks, DIRECTORY_WRITE_REGISTER } from './support/directoryWriteSinks';

const SRC = path.resolve(__dirname, '..');

interface Occurrence { file: string; line: number; text: string }

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The suites are excluded: a test names these tables freely, and
      // including them would make this control about its own fixtures.
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.sql')) {
      out.push(full);
    }
  }
  return out;
}

function census(pattern: RegExp): Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of walk(SRC)) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    fs.readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
      if (pattern.test(text)) found.push({ file: relative, line: index + 1, text: text.trim() });
    });
  }
  return found;
}

/**
 * The classes, and what each one means.
 *
 * `write`          — DML on `group_members`.
 * `derivation`     — a read taken by the carriage seam to decide WHOSE derived
 *                    membership to recompute. It reaches no decision about a
 *                    caller and appears in no predicate.
 * `authorization`  — the row feeds an authorization predicate.
 * `disclosure`     — the row decides what a caller is shown.
 * `authentication` — the row decides whether a login is admitted. It confers
 *                    nothing: an admitted Account holds exactly the access it
 *                    already had.
 * `schema`         — a migration's DDL or DML.
 * `comment`        — prose.
 */
type MemberClass =
  | 'write' | 'derivation' | 'authorization' | 'disclosure' | 'authentication' | 'schema' | 'comment';

interface RegisterEntry { file: string; classes: MemberClass[]; why: string }

/**
 * EVERY place in the tree that reads or writes `group_members`, and why it is
 * allowed to. Adding a row here is a deliberate act; that is the point of it.
 *
 * A new reader is not automatically wrong — `routes/knowledge.ts` is a
 * correctly narrowed disclosure read, and it is registered as one. What is
 * wrong is a reader arriving without anybody deciding it should.
 */
const MEMBER_REGISTER: RegisterEntry[] = [
  {
    file: 'services/GroupService.ts',
    classes: ['write', 'authorization', 'disclosure', 'comment'],
    why: 'local membership add/remove and the permitted account snapshot sink. '
      + 'Individual SQL writes are separately value-scoped by the sink census. Its listings read memberships back.',
  },
  {
    file: 'services/DirectoryCarriageService.ts',
    classes: ['derivation'],
    why: 'RH-LENSES-a: the provider-removal path reads which Accounts still hold source=directory '
      + "membership in the provider's bound Groups, so a deployment that ran directory sync BEFORE "
      + 'migration 127 -- and therefore has membership whose carriage was never recorded -- is '
      + 'recomputed too, instead of leaving authority residue no directory can correct. It reaches '
      + 'no decision about a caller and appears in no predicate. It writes NOTHING here: every '
      + 'derived-membership write goes through GroupService.applyAccountDirectorySnapshot.',
  },
  {
    file: 'services/HomeGroupService.ts',
    classes: ['authorization', 'disclosure', 'comment'],
    why: 'RH-LENSES-b derivation D-L2: the home-group resolution re-reads whether the Account is '
      + 'still a member of the Group its pointer names, under a lock -- once for '
      + 'GET /principals/me/home-group, which is what the caller is SHOWN, and once inside '
      + 'POST /projects, where it decides whether the creation default writes two grants. It '
      + 'decides about a caller, so it is registered as a DECIDING reader and R-3(ii) below holds '
      + 'it to naming no carriage table. It WRITES nothing: both occurrences are SELECTs, and '
      + 'every group_members write is still GroupService.',
  },
  {
    file: 'migrations/128_lenses_featured_home_group_grant_origin.sql',
    classes: ['comment'],
    why: 'RH-LENSES-b: one ORDERING comment naming 094 as the migration that owns groups and '
      + 'group_members. This migration reads neither and writes neither.',
  },
  {
    file: 'services/GrantService.ts',
    classes: ['authorization'],
    why: 'the ACTIVE-member group arm of activeGrantCondition -- the 078 seam, joined at query time',
  },
  {
    file: 'services/AccessProfileService.ts',
    classes: ['authorization'],
    why: 'the group arms of activeProfileCondition and of both halves of effectiveAccess',
  },
  {
    file: 'services/FeedEventService.ts',
    classes: ['disclosure'],
    why: "live grants joined through membership for verb='read', deciding whether a protected "
      + 'transition event is shown',
  },
  {
    file: 'routes/knowledge.ts',
    classes: ['disclosure'],
    why: "RH-KW1: callerGroupIds, intersected by the signer with knowledge_relevant_groups under the "
      + "§5.3 minimization rule, so a source never learns a group its owner did not declare relevant",
  },
  {
    file: 'services/identity/ssoLoginWhitelist.ts',
    classes: ['authentication'],
    why: 'SSO-R4 login admission. It confers NOTHING: an admitted Account holds exactly the access it '
      + 'already had, resolved by the same join a password login resolves',
  },
  {
    file: 'services/identity/ScimProvisioningService.ts',
    classes: ['comment'],
    why: 'a comment stating that nothing in that file touches group_members',
  },
  {
    file: 'migrations/094_groups.sql',
    classes: ['schema', 'comment'],
    why: 'the table, its indexes and the A17.6 member-kind trigger',
  },
  {
    file: 'migrations/105_sso_login_group_whitelist.sql',
    classes: ['comment'],
    why: "a COMMENT ON stating that SSO-R4 reads membership with no source filter and confers nothing",
  },
  {
    file: 'migrations/127_directory_group_references.sql',
    classes: ['comment'],
    why: 'RH-LENSES-a: comments naming the ONE path from a directory to authority that this migration '
      + 'adds a reference store BESIDE, and the source-key split it copies from 094',
  },
  {
    file: 'services/identity/IdentityProviderService.ts',
    classes: ['comment'],
    why: 'RH-LENSES-a: a comment saying that neither the unbind trigger nor the CASCADE touches '
      + 'group_members, which is why provider removal releases carriage explicitly',
  },
  {
    file: 'services/identity/ScimGroupProvisioning.ts',
    classes: ['comment'],
    why: 'RH-LENSES-a: a comment stating that the SCIM DELETE writes no group_members row directly',
  },
];

const MEMBER_PATTERN = /group_members/;

/** The files whose group_members occurrences are a read that decides something
 *  about a CALLER. None of them may know the carriage tables exist. */
const DECIDING_CLASSES: MemberClass[] = ['authorization', 'disclosure', 'authentication'];

describe('the group_members seam is ENUMERATED, not counted', () => {
  const occurrences = census(MEMBER_PATTERN);
  const registered = new Map(MEMBER_REGISTER.map((entry) => [entry.file, entry]));

  it('registers every occurrence in the tree', () => {
    const strangers = occurrences.filter((o) => !registered.has(o.file));
    // The message is the control: whoever trips this needs to know what to do.
    expect(strangers.map((o) => `${o.file}:${o.line}  ${o.text}\n`
      + '    -> add a row to MEMBER_REGISTER naming its class and why it is admissible, '
      + 'or route the access through DirectoryCarriageService'))
      .toEqual([]);
  });

  it('finds an occurrence for every register entry — a register may not outlive its subject', () => {
    const seen = new Set(occurrences.map((o) => o.file));
    const dead = MEMBER_REGISTER.filter((entry) => !seen.has(entry.file)).map((entry) => entry.file);
    expect(dead).toEqual([]);
  });

  it('censuses a tree that actually contains occurrences — a census of nothing proves nothing', () => {
    // Without this, a pattern that stopped matching would make every assertion
    // above pass over an empty list. The floor is the register's own size,
    // computed from the register rather than typed beside it.
    expect(new Set(occurrences.map((o) => o.file)).size).toBe(MEMBER_REGISTER.length);
  });

  it('B-L2: the only WRITER is GroupService, and the seam itself writes none', () => {
    const writers = MEMBER_REGISTER.filter((e) => e.classes.includes('write')).map((e) => e.file);
    expect(writers).toEqual(['services/GroupService.ts']);
    // Structural, not taken from the register: no DML statement on the table
    // exists anywhere but that file.
    const dml = census(/(INSERT INTO|DELETE FROM|UPDATE)\s+group_members/)
      .filter((o) => o.file !== 'services/GroupService.ts' && !o.file.endsWith('.sql'));
    expect(dml.map((o) => `${o.file}:${o.line}`)).toEqual([]);
    // And the seam contains none, which is what makes "recomputed from
    // carriage, never patched incrementally" true rather than asserted.
    const seam = fs.readFileSync(path.join(SRC, 'services/DirectoryCarriageService.ts'), 'utf8');
    expect(/(INSERT INTO|DELETE FROM|UPDATE)\s+group_members/.test(seam)).toBe(false);
  });
});

// ── The carriage tables, and who may know them ────────────────────────────

const CARRIAGE_PATTERN = /(account_)?directory_group_references/;

const CARRIAGE_REGISTER: Array<{ file: string; why: string }> = [
  {
    file: 'services/DirectoryCarriageService.ts',
    why: 'THE SEAM. Every carriage write and every catalog read is here, and this is the ONE file in '
      + 'which the reference store and group_members meet.',
  },
  {
    file: 'migrations/127_directory_group_references.sql',
    why: 'the two tables, their indexes, the provider ref-attribute column, and the DO blocks that '
      + 'assert this migration\'s own postcondition',
  },
];

describe('prohibition 1: the reference store is not a second authority store', () => {
  const occurrences = census(CARRIAGE_PATTERN);
  const admitted = new Set(CARRIAGE_REGISTER.map((entry) => entry.file));

  it('names the carriage tables in exactly the registered files', () => {
    const strangers = occurrences.filter((o) => !admitted.has(o.file));
    expect(strangers.map((o) => `${o.file}:${o.line}  ${o.text}\n`
      + '    -> a reference and its carriage hold NO authority and are read by NO authorization '
      + 'predicate. Reach them through DirectoryCarriageService, or say here why this file is the '
      + 'exception.'))
      .toEqual([]);
  });

  it('finds an occurrence for every registered file', () => {
    const seen = new Set(occurrences.map((o) => o.file));
    expect(CARRIAGE_REGISTER.filter((entry) => !seen.has(entry.file)).map((e) => e.file)).toEqual([]);
  });

  it('R-3(ii): no DECIDING reader of group_members reads either carriage table', () => {
    // The assertion the whole design turns on, and it is not a number. A file
    // that decides something about a caller from membership must not also be
    // able to see carriage — because the day it can, carriage has become
    // authority without anybody writing that sentence down.
    const deciders = MEMBER_REGISTER
      .filter((entry) => entry.classes.some((c) => DECIDING_CLASSES.includes(c)))
      .map((entry) => entry.file);
    expect(deciders.length).toBeGreaterThan(0);
    const leaked = occurrences.filter((o) => deciders.includes(o.file));
    expect(leaked.map((o) => `${o.file}:${o.line}  ${o.text}`)).toEqual([]);
  });

  it('migration 127 refuses a foreign key to groups — the structural half', () => {
    const migration = fs.readFileSync(
      path.join(SRC, 'migrations/127_directory_group_references.sql'), 'utf8',
    );
    // The DO block is the enforcement; this asserts it is still there and
    // still names both tables, because a migration that silently stopped
    // checking would leave only this suite's opinion behind.
    expect(migration).toContain("confrelid = 'groups'::regclass");
    expect(migration).toContain("conrelid IN ('directory_group_references'::regclass,");
    expect(migration).toContain('a second binding representation');
  });
});

// ── B-L15: every carriage and binding writer takes its locks, in order ────

describe('B-L15: the lock order is a mechanism, not a convention', () => {
  const seam = fs.readFileSync(path.join(SRC, 'services/DirectoryCarriageService.ts'), 'utf8');

  /**
   * One method's text, from its signature to the next method's.
   *
   * Deliberately NOT brace matching from the first `{` after the signature:
   * these signatures carry object TYPE annotations (`meta: { displayName?… }`)
   * and a naive depth counter closes on the type instead of the body, which
   * silently hands every assertion below an empty string to be satisfied by.
   * Slicing between declarations cannot do that.
   */
  const DECLARATION = /\n {2}(?:private )?async ([A-Za-z]+)[<(]/g;
  const declarations = [...seam.matchAll(DECLARATION)]
    .map((match) => ({ name: match[1], at: match.index ?? 0 }));

  function bodyOf(name: string): string {
    const index = declarations.findIndex((declaration) => declaration.name === name);
    if (index < 0) throw new Error(`DirectoryCarriageService no longer declares ${name}`);
    const start = declarations[index].at;
    const end = index + 1 < declarations.length ? declarations[index + 1].at : seam.length;
    const body = seam.slice(start, end);
    // A slice that found nothing to say would make every ordering assertion
    // vacuous, so the slice itself is checked before it is used.
    expect(body.length).toBeGreaterThan(200);
    return body;
  }

  /**
   * Every public method that changes carriage or a binding.
   *
   * `needsReferenceLock` is false only for `withProviderRemoval`, which holds
   * the provider lock EXCLUSIVELY — a stronger claim than any set of reference
   * locks, and the reason it can enumerate the whole provider's carriage.
   */
  const WRITERS = [
    { name: 'applyAccountCarriage', needsReferenceLock: true },
    { name: 'applyReferenceCarriage', needsReferenceLock: true },
    { name: 'bindReferenceToGroup', needsReferenceLock: true },
    { name: 'deleteReference', needsReferenceLock: true },
    { name: 'deleteReferenceFromDirectory', needsReferenceLock: true },
    { name: 'withProviderRemoval', needsReferenceLock: false },
  ];

  it.each(WRITERS)('$name takes the provider lock before anything else', ({ name }) => {
    const body = bodyOf(name);
    const provider = body.indexOf('takeProviderLock(');
    expect(provider).toBeGreaterThanOrEqual(0);
    for (const later of ['takeReferenceLocks(', 'takeAccountLocks(']) {
      const at = body.indexOf(later);
      if (at >= 0) expect(at).toBeGreaterThan(provider);
    }
  });

  it.each(WRITERS.filter((w) => w.needsReferenceLock))(
    '$name takes its reference locks before it discovers any carrier',
    ({ name }) => {
      const body = bodyOf(name);
      const reference = body.indexOf('takeReferenceLocks(');
      expect(reference).toBeGreaterThanOrEqual(0);
      const accounts = body.indexOf('takeAccountLocks(');
      if (accounts >= 0) expect(accounts).toBeGreaterThan(reference);
      // The discovery this order exists for: any statement that asks WHO
      // carries something. It must not appear before the reference lock.
      const discovery = /account_principal_id\s+FROM\s+account_directory_group_references/.exec(body);
      if (discovery) expect(discovery.index).toBeGreaterThan(reference);
    },
  );

  it('withProviderRemoval takes the provider lock EXCLUSIVELY', () => {
    // The one act that enumerates a whole provider's carriage. Every other act
    // holds the same key SHARED, so this one cannot interleave with any of
    // them — which is the second phantom design round 2 constructed.
    expect(bodyOf('withProviderRemoval')).toContain("takeProviderLock(client, ledger, 'exclusive')");
    for (const writer of WRITERS.filter((w) => w.name !== 'withProviderRemoval')) {
      expect(bodyOf(writer.name)).toContain("takeProviderLock(client, ledger, 'shared')");
    }
  });

  it('every recomputation is guarded by the account lock it needs', () => {
    // `recomputeDerivedMembership` is the only path to a derived-membership
    // write, and its first statement asserts the lock. A caller that forgot
    // one gets an exception on the first run rather than a phantom under
    // contention six months later.
    const body = bodyOf('recomputeDerivedMembership');
    expect(body.indexOf('requireAccountLock(ledger, accountPrincipalId)')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('requireAccountLock')).toBeLessThan(body.indexOf('client.query'));
  });

  it('uses the single-bigint advisory-lock overload, which is the one that exists', () => {
    // `hashtextextended(text, bigint)` returns bigint, and PostgreSQL exposes
    // pg_advisory_xact_lock(bigint) and (integer, integer) — NOT (bigint,
    // bigint). A design revision wrote the two-argument form and could not
    // have executed at all.
    expect(seam).toContain('hashtextextended($1, 0)');
    expect(seam).not.toMatch(/pg_advisory_xact_lock(_shared)?\(hashtextextended\([^)]*\)\s*,/);
  });
});

// ── B-L12: no MCP surface, for any act or read ────────────────────────────

describe('B-L12: this design has no MCP surface', () => {
  it('no MCP tool names the catalog, the carriage, or the reference store', () => {
    // The registry is a hand-written list and is NOT derived from the route
    // mounts, so the transport class this family declares says nothing about
    // this and the absence has to be measured against the list itself.
    const registry = fs.readFileSync(path.join(SRC, 'mcp/registry.ts'), 'utf8');
    const names = [...registry.matchAll(/name: '(relayhall_[a-z0-9_]+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name) => /directory|carriage|group_reference/.test(name))).toEqual([]);
    expect(registry).not.toContain('directory-group-references');
  });
});

describe('R-3 sink-anchored directory write census', () => {
  it('R-3: every discovered write has an exact value-scoped exemption', () => {
    const actual = directoryWriteSinks(SRC).map(({ file, owner, sql }) => [file, owner, sql]);
    expect(actual.sort()).toEqual([...DIRECTORY_WRITE_REGISTER].sort());
    // This is the sole dynamic protected-table statement. Enumerate its
    // expression producers too, so the sink cannot hide a new binding SET.
    const source = ts.createSourceFile('GroupService.ts',
      fs.readFileSync(path.join(SRC, 'services/GroupService.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const fragments: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText() === 'sets.push') {
        fragments.push(...node.arguments.map(argument => argument.getText()));
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    // `featured` is RH-LENSES-b's flag on the Group itself, value-scoped here
    // for the same reason the other two are: what this assertion exists to
    // catch is a new BINDING column reaching the dynamic SET, and
    // `identity_provider_id` / `external_group_ref` are precisely what
    // LENSES-a's 409 closure removed from this statement.
    expect(fragments).toEqual([
      '`name = $${params.length}`',
      '`description = $${params.length}`',
      '`featured = $${params.length}`',
    ]);
  });

  it('the one dynamic table token is drawn from a closed literal list', () => {
    // `DIRECTORY_WRITE_REGISTER` admits `UPDATE ${table} SET ...` on the
    // strength of where `table` comes from, so that is MEASURED here rather
    // than taken on the register's word: the loop's subject is an inline array
    // of string literals, and neither protected table is among them. A build
    // that made the token a parameter, a document field, or a wider list
    // reddens here while the register row still matches.
    const source = ts.createSourceFile('BlueprintProvenanceService.ts',
      fs.readFileSync(path.join(SRC, 'services/BlueprintProvenanceService.ts'), 'utf8'),
      ts.ScriptTarget.Latest, true);
    const tokens: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isForOfStatement(node)) {
        const subject = ts.isAsExpression(node.expression) ? node.expression.expression : node.expression;
        if (!ts.isArrayLiteralExpression(subject)) {
          tokens.push(`<not an inline literal list: ${subject.getText()}>`);
        } else {
          for (const element of subject.elements) {
            const first = ts.isArrayLiteralExpression(element) ? element.elements[0] : undefined;
            tokens.push(first && ts.isStringLiteral(first) ? first.text : `<not a literal: ${element.getText()}>`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(tokens).toEqual(['phases', 'tasks', 'reports']);
  });
});
