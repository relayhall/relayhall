/**
 * Migration 067 contract (task 47ef04a2; contract 21a04c23 §7–8; review
 * 6fd3b9e0 finding 3 applied).
 *
 * Migration files cannot run in jest (no live PostgreSQL), so this suite
 * pins the CONTRACT of 067_project_resource_contract.sql statically: it owns
 * exactly slot 067, is forward and non-destructive, runs PLAN → DRIFT GATE →
 * APPLY → CUTOVER inside one implicit transaction, keys its ledger by
 * installation and source-locator digest, fails closed on source-byte drift,
 * and never invents names. The author additionally executed it against a
 * live PostgreSQL 16 with a full legacy fixture (documented in the candidate
 * report); this static pin keeps the executable contract reviewable.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const FILE = '067_project_resource_contract.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, FILE), 'utf8');
// Strip SQL comments so destructive-keyword checks can't be confused by prose.
const code = sql
  .split('\n')
  .map((line) => {
    const commentStart = line.indexOf('--');
    return commentStart === -1 ? line : line.slice(0, commentStart);
  })
  .join('\n');

/**
 * The migration-ledger rule (owner ruling PARALLEL-WRITERS `0464ad54` §2),
 * as repaired against review `bfac1dd5` finding F4.
 *
 * The first version of this rule checked only ABSENT numbers, and the reviewer
 * showed two ways past it: an UNRESERVED PRESENT migration (a lane simply
 * taking 124) passed, and DELETING a reserved-and-present migration passed
 * because its stale reservation excused the new hole. Both are now closed, and
 * the deletion check is anchored OUTSIDE this file — in git, which the ledger
 * cannot forge.
 */

/** One parsed reservation line. */
export interface MigrationReservation { number: number; owner: string; line: string; }

/**
 * Parse `RESERVED` with a COMPLETE grammar. The first version took the first
 * whitespace token and ignored the rest of the line, so a malformed entry
 * parsed silently — and a `NaN` reservation would have excused any gap.
 */
export function parseReservedLedger(text: string): MigrationReservation[] {
  const out: MigrationReservation[] = [];
  const seen = new Map<number, string>();
  text.split('\n').forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) return;
    const match = /^(\d{3})\s+([A-Za-z0-9._\-]+)(?:\s+([0-9a-f]{8}))?$/.exec(line);
    if (!match) {
      throw new Error(`RESERVED line ${i + 1} does not match '<number> <owner> [<card>]': ${JSON.stringify(line)}`);
    }
    const number = Number(match[1]);
    if (seen.has(number)) {
      throw new Error(`RESERVED reserves ${number} twice (line ${i + 1}, first for '${seen.get(number)}')`);
    }
    seen.set(number, match[2]);
    out.push({ number, owner: match[2], line });
  });
  if (out.length === 0) throw new Error('RESERVED parsed to no entries — the gate would pass vacuously');
  return out;
}

/** Numbers ABSENT in the range that no reservation accounts for. */
export function unreservedMigrationGaps(
  numbers: readonly number[], reserved: ReadonlySet<number>, from: number,
): number[] {
  const present = new Set(numbers);
  const missing: number[] = [];
  for (let n = from; n < Math.max(...numbers); n += 1) {
    if (!present.has(n)) missing.push(n);
  }
  return missing.filter((n) => !reserved.has(n));
}

/**
 * Numbers PRESENT past `from` that no reservation accounts for (F4a). The
 * ruling says "a lane uses ONLY its reserved numbers; an unreserved number is
 * a packet violation" — so presence needs a reservation exactly as absence does.
 */
export function unreservedMigrationsPresent(
  numbers: readonly number[], reserved: ReadonlySet<number>, from: number,
): number[] {
  return numbers.filter((n) => n >= from && !reserved.has(n));
}

/**
 * Migration files that existed at `baseFiles` and are GONE from `headFiles`
 * (F4b). The anchor is the merge base as git reports it — a fact this
 * repository's own ledger cannot rewrite.
 */
export function deletedMigrations(
  baseFiles: readonly string[], headFiles: readonly string[],
): string[] {
  const head = new Set(headFiles);
  return baseFiles.filter((f) => !head.has(f));
}

export function readReservedMigrationNumbers(dir: string): number[] {
  return parseReservedLedger(fs.readFileSync(path.join(dir, 'RESERVED'), 'utf8'))
    .map((entry) => entry.number);
}

/** The migration filenames at a given commit, via git — the outside anchor. */
export function migrationFilesAt(repoRoot: string, commit: string): string[] {
  const out = execFileSync('git', ['--no-replace-objects', 'ls-tree', '--name-only', `${commit}:backend/src/migrations`], {
    cwd: repoRoot, encoding: 'utf8',
  });
  return out.split('\n').map((f) => f.trim()).filter((f) => f.endsWith('.sql'));
}

/** The `RESERVED` ledger as it stood at a given commit. */
export function reservedLedgerAt(repoRoot: string, commit: string): MigrationReservation[] {
  const out = execFileSync('git', ['--no-replace-objects', 'show', `${commit}:backend/src/migrations/RESERVED`], {
    cwd: repoRoot, encoding: 'utf8',
  });
  return parseReservedLedger(out);
}

/**
 * Resolve the baseline commit this candidate is measured against — and FAIL
 * rather than degrade (round-2 review `696bff8c` finding R2-F5).
 *
 * The first version caught a failed `git merge-base` and RETURNED, so jest
 * reported green. A console warning is not a safety control: on a shallow
 * clone or with `origin/main` absent — both explicitly anticipated — the
 * blocker-level deletion gate silently disappeared. It also compared HEAD to
 * itself whenever `HEAD == origin/main`, which is exactly the first
 * post-integration CI run, and self-comparison can detect nothing.
 *
 * Resolution order:
 *   1. `RELAYHALL_MIGRATION_BASE_REF` — an explicit, CI-supplied base.
 *   2. `merge-base HEAD origin/main`, when it is DISTINCT from HEAD.
 *   3. `HEAD^` (first parent) when HEAD is the base — the post-merge case.
 *   4. A proven non-shallow, parentless raw root commit uses its committed
 *      migration inventory. All file-count, ledger and working-tree deletion
 *      checks still execute; there is no prior history to compare.
 * A baseline with no inventory may use HEAD only when every reachable earlier
 * commit is proven LICENSE-only, with complete non-shallow history.
 * Otherwise the caller THROWS. CI supplies full history for this reason (`fetch-depth: 0` on the backend job).
 */
export function resolveMigrationBase(repoRoot: string): { base: string; how: string; initialRoot?: true; initialProduct?: true } {
  const git = (args: string[]): string =>
    execFileSync('git', ['--no-replace-objects', ...args], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const head = git(['rev-parse', 'HEAD']);

  // GitHub may already contain a LICENSE-only reservation before the first
  // product import. An absent baseline inventory is admissible ONLY when the
  // complete pre-HEAD ancestry proves no product ever existed. Looking just at
  // the parent would let deletion followed by reintroduction erase history.
  const resolveInventory = (base: string, how: string): { base: string; how: string; initialProduct?: true } => {
    const entries = git(['ls-tree', base, '--', 'backend/src/migrations']);
    if (entries) return { base, how }; // Partial/corrupt inventories fail in the normal readers.
    if (git(['rev-parse', '--is-shallow-repository']) !== 'false') {
      throw new Error('cannot resolve a migration baseline: reservation history is shallow');
    }
    git(['merge-base', '--is-ancestor', base, head]);
    // rev-list fails if any reachable parent object is missing, including
    // missing history behind a merge's non-first parent.
    const ancestors = git(['rev-list', head]).split('\n').filter((commit) => commit !== head);
    const licenseOnly = (commit: string): boolean =>
      git(['ls-tree', '-r', '--name-only', commit]) === 'LICENSE'
      && git(['cat-file', '-t', commit + ':LICENSE']) === 'blob';
    if (!ancestors.length || !ancestors.every(licenseOnly)) {
      // GitHub PR checkout is a synthetic merge: reservation target first,
      // first product import second. Anchor the actual product parent so a
      // deletion introduced by the merge or working tree is still caught.
      const parents = git(['rev-list', '--parents', '-n', '1', head]).split(' ').slice(1);
      const products = ancestors.filter((commit) => !licenseOnly(commit));
      if (parents.length === 2 && products.length === 1 && products[0] === parents[1]
        && git(['rev-list', parents[0]]).split('\n').every(licenseOnly)) {
        const product = products[0];
        if (migrationFilesAt(repoRoot, product).length <= 50) {
          throw new Error('cannot resolve a migration baseline: incomplete first product merge inventory');
        }
        reservedLedgerAt(repoRoot, product);
        return { base: product, how: 'first product parent of LICENSE-only reservation merge' };
      }
      throw new Error('cannot resolve a migration baseline: absent inventory is not pristine LICENSE-only reservation history');
    }
    // Use the immutable imported inventory, never an empty baseline. Existing
    // count, gap, reservation and working-tree deletion checks still apply.
    if (migrationFilesAt(repoRoot, head).length <= 50) {
      throw new Error('cannot resolve a migration baseline: incomplete first product inventory');
    }
    reservedLedgerAt(repoRoot, head);
    return { base: head, how: 'initial committed product inventory after LICENSE-only reservation history', initialProduct: true };
  };

  const explicit = process.env.RELAYHALL_MIGRATION_BASE_REF;
  if (explicit) {
    const base = git(['rev-parse', `${explicit}^{commit}`]);
    if (base !== head) return resolveInventory(base, `RELAYHALL_MIGRATION_BASE_REF=${explicit}`);
  }
  let mergeBase: string | undefined;
  try {
    mergeBase = git(['merge-base', 'HEAD', 'origin/main']);
  } catch {
    // fall through to the first-parent case
  }
  if (mergeBase && mergeBase !== head) return resolveInventory(mergeBase, 'merge-base with origin/main');
  let parent: string;
  try {
    parent = git(['rev-parse', 'HEAD^{commit}^']);
    git(['cat-file', '-e', parent + '^{commit}']);
  } catch {
    // A public release may intentionally start with one complete root commit.
    // Shallow boundaries and missing-parent corruption are NOT initial roots:
    // inspect the raw object rather than trusting rev-list's apparent history.
    const header = git(['cat-file', '-p', head]).split('\n\n', 1)[0];
    if (git(['rev-parse', '--is-shallow-repository']) === 'false'
      && !header.split('\n').some((line) => line.startsWith('parent '))) {
      return { base: head, how: 'initial committed root inventory', initialRoot: true };
    }
    throw new Error(
      'cannot resolve a migration baseline: no RELAYHALL_MIGRATION_BASE_REF, no distinct merge-base with origin/main, '
      + 'and no first parent. The deletion control CANNOT run — supply full history (fetch-depth: 0) or set '
      + 'RELAYHALL_MIGRATION_BASE_REF. This gate fails closed on purpose (review 696bff8c R2-F5).',
    );
  }
  return resolveInventory(parent, 'first parent (HEAD is at or past the base)');
}

/**
 * Reservations REMOVED or MUTATED between two ledgers. `RESERVED` is
 * append-only history; deleting a line is how a destroyed migration used to
 * hide (R2-F5 second half — nothing compared the ledger to its base).
 */
export function reservationHistoryViolations(
  base: readonly MigrationReservation[], head: readonly MigrationReservation[],
): string[] {
  const headByNumber = new Map(head.map((r) => [r.number, r]));
  const problems: string[] = [];
  for (const entry of base) {
    const now = headByNumber.get(entry.number);
    if (!now) { problems.push(`reservation ${entry.number} was REMOVED`); continue; }
    if (now.owner !== entry.owner) {
      problems.push(`reservation ${entry.number} was REASSIGNED from '${entry.owner}' to '${now.owner}'`);
    }
  }
  return problems;
}

/** Real Git fixtures protect the distinction between an imported root and
 * unavailable history. No database or production repository is involved. */
function historyFixture(check: (repo: string, root: string, git: (args: string[], cwd?: string) => string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relayhall-migration-history-'));
  const repo = path.join(root, 'source');
  fs.mkdirSync(repo);
  const git = (args: string[], cwd = repo): string => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const explicit = process.env.RELAYHALL_MIGRATION_BASE_REF;
  delete process.env.RELAYHALL_MIGRATION_BASE_REF;
  try {
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Migration fixture']);
    git(['config', 'user.email', 'migration@example.test']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['config', 'core.hooksPath', '/dev/null']);
    const dir = path.join(repo, 'backend/src/migrations');
    fs.mkdirSync(dir, { recursive: true });
    for (let n = 1; n <= 60; n += 1) {
      fs.writeFileSync(path.join(dir, String(n).padStart(3, '0') + '_fixture.sql'), '-- fixture\n');
    }
    fs.writeFileSync(path.join(dir, 'RESERVED'), '060 fixture\n');
    git(['add', '.']);
    git(['commit', '-m', 'initial complete inventory']);
    check(repo, root, git);
  } finally {
    if (explicit === undefined) delete process.env.RELAYHALL_MIGRATION_BASE_REF;
    else process.env.RELAYHALL_MIGRATION_BASE_REF = explicit;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Replace fixture history with a real LICENSE reservation followed by the
 * original complete product tree. Extra reservation commits exercise ancestry,
 * not just the immediate parent. */
function licenseImport(repo: string, git: (args: string[], cwd?: string) => string): { root: string; reservation: string; product: string } {
  const productTree = git(['rev-parse', 'HEAD^{tree}']);
  git(['checkout', '--orphan', 'reservation']);
  git(['rm', '-rf', '.']);
  fs.writeFileSync(path.join(repo, 'LICENSE'), 'fixture license\n');
  git(['add', 'LICENSE']);
  git(['commit', '-m', 'reserve project name']);
  const root = git(['rev-parse', 'HEAD']);
  fs.appendFileSync(path.join(repo, 'LICENSE'), 'license correction\n');
  git(['commit', '-am', 'correct license']);
  const reservation = git(['rev-parse', 'HEAD']);
  const product = git(['commit-tree', productTree, '-p', reservation, '-m', 'first product import']);
  git(['reset', '--hard', product]);
  return { root, reservation, product };
}

describe('migration baseline history admission', () => {
  it('admits first complete product import only after full LICENSE-only ancestry and preserves its immutable inventory', () => {
    historyFixture((repo, _root, git) => {
      const imported = licenseImport(repo, git);
      git(['update-ref', 'refs/remotes/origin/main', imported.reservation]);
      const resolved = resolveMigrationBase(repo);
      expect(resolved.base).toBe(imported.product);
      expect(resolved.how).toContain('LICENSE-only');
      expect(resolved.initialProduct).toBe(true);
      expect(migrationFilesAt(repo, resolved.base)).toHaveLength(60);
      fs.unlinkSync(path.join(repo, 'backend/src/migrations/060_fixture.sql'));
      expect(deletedMigrations(migrationFilesAt(repo, resolved.base),
        fs.readdirSync(path.join(repo, 'backend/src/migrations')))).toEqual(['060_fixture.sql']);
      expect(reservationHistoryViolations(reservedLedgerAt(repo, resolved.base), [])).toEqual(['reservation 60 was REMOVED']);
      // The same proof applies when CI has advanced origin/main to HEAD.
      git(['update-ref', 'refs/remotes/origin/main', imported.product]);
      expect(resolveMigrationBase(repo).base).toBe(imported.product);
    });
  });

  it('anchors a GitHub synthetic reservation merge to its single product parent and catches merge deletion', () => {
    historyFixture((repo, _root, git) => {
      const imported = licenseImport(repo, git);
      const tree = git(['rev-parse', imported.product + '^{tree}']);
      const merge = git(['commit-tree', tree, '-p', imported.reservation, '-p', imported.product, '-m', 'GitHub synthetic merge']);
      git(['reset', '--hard', merge]);
      git(['update-ref', 'refs/remotes/origin/main', imported.reservation]);
      expect(resolveMigrationBase(repo).base).toBe(imported.product);
      git(['rm', 'backend/src/migrations/060_fixture.sql']);
      fs.writeFileSync(path.join(repo, 'backend/src/migrations/RESERVED'), '060 reassigned\n');
      git(['add', 'backend/src/migrations/RESERVED']);
      const deletedTree = git(['write-tree']);
      const badMerge = git(['commit-tree', deletedTree, '-p', imported.reservation, '-p', imported.product, '-m', 'merge deletes migration']);
      git(['reset', '--hard', badMerge]);
      const resolved = resolveMigrationBase(repo);
      expect(resolved.base).toBe(imported.product);
      expect(deletedMigrations(migrationFilesAt(repo, resolved.base), migrationFilesAt(repo, 'HEAD')))
        .toEqual(['060_fixture.sql']);
      expect(reservationHistoryViolations(reservedLedgerAt(repo, resolved.base), reservedLedgerAt(repo, 'HEAD')))
        .toEqual(["reservation 60 was REASSIGNED from 'fixture' to 'reassigned'"]);
    });
  });

  it('rejects a LICENSE parent with shallow or missing earlier reservation history', () => {
    historyFixture((repo, root, git) => {
      licenseImport(repo, git);
      const shallow = path.join(root, 'shallow-reservation');
      git(['clone', '--depth=2', 'file://' + repo, shallow]);
      expect(() => resolveMigrationBase(shallow)).toThrow(/cannot resolve a migration baseline/);
      fs.unlinkSync(path.join(shallow, '.git/shallow'));
      expect(() => resolveMigrationBase(shallow)).toThrow();
    });
  });

  it('rejects prior product deletion followed by reintroduction behind a LICENSE-only parent', () => {
    historyFixture((repo, _root, git) => {
      const original = git(['rev-parse', 'HEAD']);
      const productTree = git(['rev-parse', 'HEAD^{tree}']);
      const imported = licenseImport(repo, git);
      const licenseTree = git(['rev-parse', imported.reservation + '^{tree}']);
      const deletion = git(['commit-tree', licenseTree, '-p', original, '-m', 'delete product']);
      const reintroduced = git(['commit-tree', productTree, '-p', deletion, '-m', 'reintroduce product']);
      git(['reset', '--hard', reintroduced]);
      expect(() => resolveMigrationBase(repo)).toThrow(/not pristine LICENSE-only/);
      git(['update-ref', 'refs/remotes/origin/main', deletion]);
      expect(() => resolveMigrationBase(repo)).toThrow(/not pristine LICENSE-only/);
      const merged = git(['commit-tree', productTree, '-p', imported.reservation, '-p', reintroduced, '-m', 'hide product in merge ancestry']);
      git(['reset', '--hard', merged]);
      git(['update-ref', 'refs/remotes/origin/main', imported.reservation]);
      expect(() => resolveMigrationBase(repo)).toThrow(/not pristine LICENSE-only/);

    });
  });

  it('rejects incomplete committed import even when its working tree contains a complete inventory', () => {
    historyFixture((repo, _root, git) => {
      licenseImport(repo, git);
      git(['rm', 'backend/src/migrations/RESERVED']);
      git(['commit', '--amend', '--no-edit']);
      fs.writeFileSync(path.join(repo, 'backend/src/migrations/RESERVED'), '060 fixture\n');
      expect(() => resolveMigrationBase(repo)).toThrow();
    });
  });


  it('admits a complete genuine root and still detects working-tree migration deletion', () => {
    historyFixture((repo, _root, git) => {
      const resolved = resolveMigrationBase(repo);
      expect(resolved).toMatchObject({ base: git(['rev-parse', 'HEAD']), initialRoot: true });
      const before = migrationFilesAt(repo, resolved.base);
      expect(before).toHaveLength(60);
      expect(reservedLedgerAt(repo, resolved.base)).toHaveLength(1);
      fs.unlinkSync(path.join(repo, 'backend/src/migrations/060_fixture.sql'));
      const after = fs.readdirSync(path.join(repo, 'backend/src/migrations')).filter((name) => name.endsWith('.sql'));
      expect(deletedMigrations(before, after)).toEqual(['060_fixture.sql']);
    });
  });

  it('rejects a depth-one non-root clone instead of treating its shallow boundary as a root', () => {
    historyFixture((repo, root, git) => {
      fs.writeFileSync(path.join(repo, 'second'), 'second commit');
      git(['add', '.']);
      git(['commit', '-m', 'second']);
      const shallow = path.join(root, 'shallow');
      git(['clone', '--depth=1', 'file://' + repo, shallow]);
      expect(git(['rev-parse', '--is-shallow-repository'], shallow)).toBe('true');
      expect(() => resolveMigrationBase(shallow)).toThrow(/cannot resolve a migration baseline/);
      // Removing the shallow marker does not repair missing parent objects.
      fs.unlinkSync(path.join(shallow, '.git/shallow'));
      expect(git(['rev-parse', '--is-shallow-repository'], shallow)).toBe('false');
      expect(() => resolveMigrationBase(shallow)).toThrow(/cannot resolve a migration baseline/);
    });
  });

  it('keeps first-parent comparison and deletion detection after the initial commit', () => {
    historyFixture((repo, _root, git) => {
      const first = git(['rev-parse', 'HEAD']);
      git(['rm', 'backend/src/migrations/060_fixture.sql']);
      git(['commit', '-m', 'forbidden deletion']);
      const resolved = resolveMigrationBase(repo);
      expect(resolved.base).toBe(first);
      expect(resolved.initialRoot).toBeUndefined();
      expect(deletedMigrations(migrationFilesAt(repo, resolved.base), migrationFilesAt(repo, 'HEAD')))
        .toEqual(['060_fixture.sql']);
    });
  });
});

describe('ledger position', () => {
  it('067 exists exactly once and is the direct successor of the 066 tip', () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    const sixtySeven = files.filter((f) => f.startsWith('067'));
    expect(sixtySeven).toEqual([FILE]);
    expect(files.some((f) => f.startsWith('066_'))).toBe(true);
    // 067 was the reserved slot while RH-P1.5f was in flight; that in-flight
    // guard retired when it merged. Wave-2 renames follow at 068+.
    //
    // The sweep below USED to demand strict contiguity from 068. Owner ruling
    // PARALLEL-WRITERS `0464ad54` §2 (2026-09-03) made that impossible to
    // satisfy honestly: lanes now run in parallel on reserved numbers and
    // integrate SERIALLY in a preference order that is not the numeric order,
    // so `main` legitimately holds a gap wherever a lower reserved number
    // belongs to a lane that has not integrated yet. The same ruling forbids a
    // lane from taking an unreserved number to close such a gap ("an
    // unreserved number is a packet violation"), so the old assertion and the
    // ruling could not both be obeyed.
    //
    // What replaces it is STRICTER than contiguity in every respect the old
    // form actually protected: numbers are unique and increasing, and every
    // ABSENT number in the range must appear in the `RESERVED` ledger. A
    // renumbering, a deleted migration, a duplicated slot or a typo'd filename
    // all still fail — only a gap the ruling itself authorized passes.
    const post067 = files
      .map((f) => Number(f.slice(0, 3)))
      .filter((n) => Number.isInteger(n) && n > 67)
      .sort((a, b) => a - b);
    expect(new Set(post067).size).toBe(post067.length);
    const reserved = new Set(readReservedMigrationNumbers(MIGRATIONS_DIR));
    // (1) every gap is a live reservation, and nothing else — a renumbering fails.
    expect(unreservedMigrationGaps(post067, reserved, 68)).toEqual([]);
    // (2) every migration PRESENT past the reservation floor is reserved — a
    //     lane cannot simply take an unreserved number (ruling §2, F4a).
    const floor = Math.min(...reserved);
    expect(unreservedMigrationsPresent(post067, reserved, floor)).toEqual([]);
  });

  /**
   * (3) DELETION, anchored in git rather than in the ledger (F4b). A migration
   * that existed at the merge base and is gone at HEAD is a destroyed
   * migration, whatever the ledger says about its number. Missing history
   * fails closed; a proven initial root checks its committed inventory against
   * the working tree instead of inventing a nonexistent ancestor.
   */
  it('destroys no migration that existed at the baseline, and never skips the check', () => {
    const repoRoot = path.resolve(MIGRATIONS_DIR, '..', '..', '..');
    // Throws rather than warns when no baseline resolves (R2-F5).
    const { base, initialRoot, initialProduct } = resolveMigrationBase(repoRoot);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    if (initialRoot || initialProduct) expect(base).toBe(head);
    else expect(base).not.toBe(head);
    const baseFiles = migrationFilesAt(repoRoot, base);
    const headFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    expect(baseFiles.length).toBeGreaterThan(50);
    expect(deletedMigrations(baseFiles, headFiles)).toEqual([]);
  });

  it('never removes or reassigns a reservation — RESERVED is append-only history', () => {
    const repoRoot = path.resolve(MIGRATIONS_DIR, '..', '..', '..');
    const { base } = resolveMigrationBase(repoRoot);
    let baseLedger: MigrationReservation[];
    try {
      baseLedger = reservedLedgerAt(repoRoot, base);
    } catch {
      // The ledger is NEW in this candidate; there is no base version to
      // compare against, and that is the one legitimate absence.
      expect(fs.existsSync(path.join(MIGRATIONS_DIR, 'RESERVED'))).toBe(true);
      return;
    }
    const headLedger = parseReservedLedger(fs.readFileSync(path.join(MIGRATIONS_DIR, 'RESERVED'), 'utf8'));
    expect(reservationHistoryViolations(baseLedger, headLedger)).toEqual([]);
  });

  /**
   * The control for the control. The assertion above was WEAKENED from strict
   * contiguity to "every gap is a live reservation" under owner ruling
   * PARALLEL-WRITERS `0464ad54` §2, so it owes a proof that it can still fail:
   * a rule that passes on every input is not a gate. The same gap computation
   * is applied here to synthetic inputs — one legitimate, one not — and only
   * the legitimate one is allowed through.
   */
  /**
   * The control for the control. The strict-contiguity assertion was replaced
   * under owner ruling PARALLEL-WRITERS `0464ad54` §2, so it owes a proof that
   * it can still fail — and, after review `bfac1dd5` F4, a proof that it fails
   * on the two classes the FIRST replacement let through. Every case below runs
   * the exact exported functions the assertions above run, not a copy.
   */
  it('the ledger rule REDDENS on every class it must catch', () => {
    const reserved = new Set([109, 110, 111]);

    // (a) a gap the ruling authorized — the only legitimate green.
    expect(unreservedMigrationGaps([108, 111], reserved, 108)).toEqual([]);
    // (b) a renumbering / unreserved hole.
    expect(unreservedMigrationGaps([108, 111], new Set([109]), 108)).toEqual([110]);
    // (c) F4a — an UNRESERVED PRESENT migration. The first rule passed this.
    expect(unreservedMigrationsPresent([108, 111, 124], reserved, 109)).toEqual([124]);
    expect(unreservedMigrationsPresent([108, 111], reserved, 109)).toEqual([]);
    // (d) F4b — DELETING a reserved-and-present migration. The first rule
    //     passed this too, because the stale reservation excused the hole.
    //     Git, not the ledger, is what catches it.
    expect(deletedMigrations(['110_a.sql', '111_b.sql'], ['110_a.sql'])).toEqual(['111_b.sql']);
    expect(deletedMigrations(['110_a.sql'], ['110_a.sql', '111_b.sql'])).toEqual([]);
    // (e) grammar: a malformed or duplicated reservation must THROW, not parse
    //     to NaN and silently excuse every gap.
    expect(() => parseReservedLedger('# c\n109 lane-a\n109 lane-b\n')).toThrow(/twice/);
    expect(() => parseReservedLedger('# c\nnot-a-number lane\n')).toThrow(/does not match/);
    expect(() => parseReservedLedger('# only comments\n')).toThrow(/vacuously/);
    expect(parseReservedLedger('109 lane-a abcdef01\n110 lane-b\n').map((r) => r.number)).toEqual([109, 110]);

    // (f) R2-F5 — a removed or reassigned reservation is caught, and an
    //     ADDITION is allowed. Nothing compared the ledger to its base before.
    const baseLedger = [
      { number: 109, owner: 'lane-a', line: '109 lane-a' },
      { number: 110, owner: 'lane-b', line: '110 lane-b' },
    ];
    expect(reservationHistoryViolations(baseLedger, baseLedger)).toEqual([]);
    expect(reservationHistoryViolations(baseLedger, [{ number: 109, owner: 'lane-a', line: '' },
      { number: 110, owner: 'lane-b', line: '' }, { number: 111, owner: 'lane-c', line: '' }])).toEqual([]);
    expect(reservationHistoryViolations(baseLedger, [{ number: 109, owner: 'lane-a', line: '' }]))
      .toEqual(['reservation 110 was REMOVED']);
    expect(reservationHistoryViolations(baseLedger, [{ number: 109, owner: 'lane-a', line: '' },
      { number: 110, owner: 'someone-else', line: '' }]))
      .toEqual(["reservation 110 was REASSIGNED from 'lane-b' to 'someone-else'"]);

    // (g) R2-F5 — the baseline resolver FAILS rather than degrading. A
    //     directory that is not a git repository stands in for the shallow /
    //     absent-ref cases the reviewer named; the old code returned green.
    expect(() => resolveMigrationBase('/nonexistent-not-a-git-repo')).toThrow();

    // The real ledger parses, is non-empty, and names this lane's number.
    const real = readReservedMigrationNumbers(MIGRATIONS_DIR);
    expect(real.length).toBeGreaterThan(0);
    expect(real).toContain(111);
  });

  it('is not listed in BASELINE or RETIRED (it must execute, not be stamped)', () => {
    const baseline = fs.readFileSync(path.join(MIGRATIONS_DIR, 'BASELINE'), 'utf8');
    const retired = fs.readFileSync(path.join(MIGRATIONS_DIR, 'RETIRED'), 'utf8');
    expect(baseline).not.toContain(FILE);
    expect(retired).not.toContain(FILE);
  });

  it('contains no explicit COMMIT — the runner executes it as one implicit transaction', () => {
    expect(code).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});

describe('canonical storage invariants', () => {
  it('creates the contract tables and the project revision column', () => {
    expect(code).toContain('CREATE TABLE IF NOT EXISTS project_resources');
    expect(code).toContain('CREATE TABLE IF NOT EXISTS project_resource_migration_items');
    expect(code).toContain('CREATE TABLE IF NOT EXISTS project_resource_migration_runs');
    expect(code).toContain('CREATE TABLE IF NOT EXISTS project_resource_replacements');
    expect(code).toContain('CREATE TABLE IF NOT EXISTS relayhall_installation');
    expect(code).toMatch(/ALTER TABLE projects ADD COLUMN IF NOT EXISTS revision UUID NOT NULL DEFAULT gen_random_uuid\(\)/);
  });

  it('pins the four kinds, the two states and the archived_at coupling in the database', () => {
    expect(code).toMatch(/kind IN \('repository', 'environment', 'workspace', 'reference'\)/);
    expect(code).toMatch(/state IN \('active', 'archived'\)/);
    expect(code).toMatch(/state = 'active' AND archived_at IS NULL/);
    expect(code).toMatch(/state = 'archived' AND archived_at IS NOT NULL/);
  });

  it('enforces active-only uniqueness and the single active primary repository as partial unique indexes', () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS project_resources_active_name_uq[\s\S]*?WHERE state = 'active'/);
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS project_resources_active_primary_repository_uq[\s\S]*?details->>'role' = 'primary'/);
  });

  it('locks workspace to installation-only at the database level', () => {
    expect(code).toMatch(/NOT \(kind = 'workspace' AND export_policy = 'portable'\)/);
  });

  it('bounds the idempotency key and scopes it to caller + project', () => {
    expect(code).toMatch(/char_length\(idempotency_key\) BETWEEN 16 AND 128/);
    expect(code).toMatch(/PRIMARY KEY \(caller, project_id, idempotency_key\)/);
  });
});

describe('installation-keyed, digest-keyed ledger (contract §7.2)', () => {
  it('the ledger is keyed by installation, project, surface, locator digest and version', () => {
    expect(code).toMatch(/UNIQUE \(installation_id, project_id, source_surface, source_locator_digest, migration_version\)/);
    expect(code).toContain('source_locator_digest TEXT NOT NULL');
    expect(code).toContain('source_sha256 TEXT NOT NULL');
  });

  it('the cutover record binds the locked project revision and source hash per project', () => {
    expect(code).toMatch(/project_resource_migration_runs[\s\S]*?project_revision UUID NOT NULL/);
    expect(code).toMatch(/PRIMARY KEY \(installation_id, project_id, migration_version\)/);
    expect(code).toMatch(/INSERT INTO project_resource_migration_runs/);
  });
});

describe('two-phase plan/apply with a drift gate (contract §7.3–7.4, §8)', () => {
  it('builds the complete plan before any canonical row is written', () => {
    const planIndex = code.indexOf('CREATE TEMP TABLE migration_plan');
    const applyIndex = code.indexOf('INSERT INTO project_resources (project_id');
    expect(planIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeGreaterThan(planIndex);
  });

  it('fails closed with MIGRATION_SOURCE_DRIFT when ledgered source bytes changed', () => {
    const gates = code.match(/RAISE EXCEPTION 'MIGRATION_SOURCE_DRIFT/g) ?? [];
    expect(gates.length).toBe(2); // per-item ledger drift + per-project cutover drift
    // The drift comparison precedes the apply phase.
    expect(code.indexOf("RAISE EXCEPTION 'MIGRATION_SOURCE_DRIFT")).toBeLessThan(
      code.indexOf('INSERT INTO project_resources (project_id'),
    );
  });

  it('reruns skip projects that already carry a cutover record (idempotent no-op)', () => {
    expect(code).toMatch(/WHERE NOT EXISTS \(\s*SELECT 1 FROM project_resource_migration_runs/);
  });

  it('the ledger never uses ON CONFLICT DO NOTHING (drift must surface, not be suppressed)', () => {
    // The only DO NOTHING is the installation singleton seed.
    const occurrences = code.match(/ON CONFLICT[\s\S]{0,40}?DO NOTHING/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(code).toMatch(/INSERT INTO relayhall_installation[\s\S]{0,80}?ON CONFLICT \(singleton\) DO NOTHING/);
  });
});

describe('link source-byte binding (review 73df8efe finding 2)', () => {
  it('link item hashes bind every consumed field, not just the url', () => {
    expect(code).toContain(
      "COALESCE(link.title, '') || '|' || COALESCE(link.type, '') || '|' || COALESCE(link.category, '') || '|' || COALESCE(link.url, '')",
    );
    // No link plan row hashes the bare url.
    expect(code).not.toMatch(/digest\(link\.url, 'sha256'\)/);
  });

  it('the per-project cutover hash covers the ordered project_links set (adds/deletes/field changes are drift)', () => {
    const aggregates = code.match(/string_agg\(l\.id::TEXT \|\| '\|' \|\| l\.title \|\| '\|' \|\| l\.type \|\| '\|' \|\| COALESCE\(l\.category, ''\) \|\| '\|' \|\| COALESCE\(l\.url, ''\), ';' ORDER BY l\.id\)/g) ?? [];
    expect(aggregates.length).toBe(2); // drift check + cutover insert use the identical formula
  });

  it('holds an atomic source snapshot: legacy source tables are SHARE-locked for the whole run', () => {
    expect(code).toContain('LOCK TABLE projects IN SHARE MODE');
    expect(code).toContain('LOCK TABLE project_links IN SHARE MODE');
    // Locks are taken before the PLAN is built.
    expect(code.indexOf('LOCK TABLE project_links')).toBeLessThan(code.indexOf('CREATE TEMP TABLE migration_plan'));
  });

  it('the cutover digest binds link identity, so delete+reinsert with identical fields is drift', () => {
    expect(code).toContain("l.id::TEXT || '|' || l.title");
  });
});

describe('forward, non-destructive migration', () => {
  it('never drops objects, truncates, or deletes rows', () => {
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|SCHEMA)\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('never updates legacy tables; the only projects DDL is the additive revision column', () => {
    expect(code).not.toMatch(/UPDATE\s+projects\b/i);
    expect(code).not.toMatch(/UPDATE\s+project_links\b/i);
    const projectAlters = code.match(/ALTER\s+TABLE\s+(ONLY\s+)?projects\b[^;]*/gi) ?? [];
    expect(projectAlters).toHaveLength(1);
    expect(projectAlters[0]).toContain('ADD COLUMN IF NOT EXISTS revision');
    expect(code).not.toMatch(/ALTER\s+TABLE\s+(ONLY\s+)?project_links\b/i);
  });

  it('permanent-table INSERTs target only the new contract tables', () => {
    const targets = [...code.matchAll(/INSERT INTO\s+([a-z_]+)/gi)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect([
        'project_resources',
        'project_resource_migration_items',
        'project_resource_migration_runs',
        'relayhall_installation',
        'migration_plan', // transaction-scoped temp plan table, dropped on commit
      ]).toContain(target);
    }
    expect(code).toContain('ON COMMIT DROP');
  });
});

describe('deterministic mapping discipline', () => {
  it('holds carry reasons; the notebook configuration body is always separately held', () => {
    expect(sql).toContain(`'no natural name in legacy structure'`);
    // Present JSON nulls are ledgered per named locator, never skipped
    // (reviews a4ff69b7/5d229bf1): main + environments + localPaths +
    // additional[] members each carry their own held 'null value' path,
    // and a present non-object resources container is held whole.
    const nullHolds = sql.match(/'held', 'null value'/g) ?? [];
    expect(nullHolds.length).toBeGreaterThanOrEqual(3);
    expect(sql).toContain(`CASE WHEN v_url IS NULL THEN 'null value'`);
    expect(code).toMatch(/jsonb_typeof\(proj\.resources\) != 'object'/);
    expect(code).toMatch(/->'repositories'->'main' IS NOT NULL/);
    // The four known parent containers are guarded present-vs-object
    // (review 09c90755): a JSON-null/scalar container is held whole.
    expect(code).toMatch(/VALUES \('repositories'\), \('environments'\), \('localPaths'\), \('notebooks'\)/);
    expect(code).toMatch(/jsonb_typeof\(proj\.resources->v_key\) != 'object'/);
    // A present JSON-null notebook URL is its own held source item.
    expect(code).toMatch(/->'notebooks'->v_key->'url' IS NOT NULL AND proj\.resources->'notebooks'->v_key->>'url' IS NULL/);
    expect(code).toMatch(/->'environments'->v_key IS NOT NULL/);
    expect(code).toMatch(/->'localPaths'->v_key IS NOT NULL/);
    expect(sql).toContain(`'held', 'active-uniqueness collision'`);
    expect(sql).toContain(`'held', 'instructions never become resources'`);
    expect(sql).toContain(`'held', 'url failed validation'`);
    expect(sql).toContain(`'notebook configuration is compatibility-held'`);
    // The config body is ledgered under its own locator even when the URL maps.
    expect(sql).toContain(`'.config'`);
  });

  it('uniqueness collisions fail closed to held — no auto-renaming', () => {
    const inserts = code.split('INSERT INTO project_resources (project_id').length - 1;
    const handlers = code.split('WHEN unique_violation').length - 1;
    expect(inserts).toBe(1);
    expect(handlers).toBe(1);
    expect(code).not.toMatch(/\|\|\s*'-'\s*\|\|/); // no name suffix invention
  });

  it('tool instructions never become resources', () => {
    expect(sql).toContain(`'projects.tool_instructions'`);
    const applyChunk = code.slice(code.indexOf('INSERT INTO project_resources (project_id'));
    expect(applyChunk.slice(0, 600)).not.toContain('tool_instructions');
  });

  it('mapped resources default hidden and installation-only (no visibility or export columns set)', () => {
    const inserts = code.match(/INSERT INTO project_resources\s*\(([^)]+)\)/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    for (const insert of inserts) {
      expect(insert).not.toContain('agent_visibility');
      expect(insert).not.toContain('export_policy');
    }
  });
});

describe('fresh-install parity', () => {
  it('067 is a post-baseline migration, so init.sql needs no parallel DDL (043+ run on fresh installs too)', () => {
    const readme = fs.readFileSync(path.join(MIGRATIONS_DIR, 'README.md'), 'utf8');
    expect(readme).toContain('init.sql');
    const initSql = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'database', 'init.sql'), 'utf8');
    // The baseline must NOT contain a competing definition that would make
    // the executed 067 diverge between fresh and upgraded installations.
    expect(initSql).not.toContain('project_resources');
    expect(initSql).not.toContain('project_resource_migration_items');
    expect(initSql).not.toContain('relayhall_installation');
  });
});
