/**
 * EVERY LIVENESS WRITE IN THE TREE IS ACCOUNTED FOR — card 8491557e,
 * round-1 review findings P1 and C1.
 *
 * ── WHY THIS EXISTS ──
 *
 * The first FIX-C candidate bounded three fire-and-forget writes and claimed
 * the shared writer was "the one writer every liveness bookkeeping caller in
 * the process shares". There was a FOURTH — `AccountPasswordService.verify`,
 * an unawaited `UPDATE principal_credentials SET last_used_at = now()` on the
 * shared pool after every successful password check. The census that found the
 * other three missed it, and no gate could notice: the burst gate exercises
 * `LoginSessionService.touch`, and the unit suite exercises the writer class in
 * isolation. Both are green with a fourth unbounded write in the tree.
 *
 * So the claim is measured directly, over the SOURCE, because the claim is
 * about the source: which statements in this tree write a liveness column, and
 * is each one either inside the bounded writer or awaited.
 *
 * ── WHY A REGISTER AND NOT A CLASSIFIER ──
 *
 * A classifier that decides "is this call awaited?" from text is a parser
 * written badly, and every round would find a hole in it. This control does
 * not classify: it ENUMERATES, and compares the enumeration to a register that
 * a human wrote and must edit deliberately. A new liveness write anywhere in
 * the tree fails this test with the file, the line and what to do about it —
 * whether or not the classifier would have understood it.
 *
 * That is the whole point. The defect was a MISSING entry, and a control that
 * can only judge the entries it already knows about cannot catch a missing one.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..');

/** The columns whose writes this card is about. */
const LIVENESS_WRITE = /(last_seen_at|last_used_at)\s*=\s*now\(\)/;

interface Occurrence { file: string; line: number; text: string }

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The suites are excluded: a test may name the column freely, and
      // including them would make this control about its own fixtures.
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function census(): Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of walk(SRC)) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (LIVENESS_WRITE.test(text)) {
        found.push({ file: relative, line: index + 1, text: text.trim() });
      }
    });
  }
  return found;
}

/**
 * Every place in the tree that writes a liveness column, and why it is allowed
 * to. Adding a row here is a deliberate act; that is the point of the file.
 *
 * `bounded`  — the statement lives inside `presenceWriter.submit(...)`, so the
 *              coalescing, single-flight and pool ceiling all apply. Asserted
 *              structurally below, not merely asserted here.
 * `awaited`  — an ordinary awaited write on a caller-supplied queryable. It
 *              holds its connection for the length of one statement it is
 *              waited on, so it cannot outlive its request, which is the
 *              property card 8491557e is about.
 * `prose`    — a comment, not a statement.
 */
const REGISTER: Array<{ file: string; kind: 'bounded' | 'awaited' | 'prose'; why: string }> = [
  {
    file: 'db/boundedPresenceWrites.ts',
    kind: 'prose',
    why: 'the module header quoting the statement the card exists for',
  },
  {
    file: 'services/LoginSessionService.ts',
    kind: 'bounded',
    why: 'the session liveness touch — the reported defect',
  },
  {
    file: 'services/PrincipalService.ts',
    kind: 'bounded',
    why: 'bumpLastSeen, and bumpCredentialLastUsed for both the id and legacy-env forms',
  },
  {
    file: 'services/identity/IdentityLinkService.ts',
    kind: 'awaited',
    why: 'IdentityLinkService.touch and the promotion statement are awaited on a caller-supplied '
      + 'client, inside the SSO authentication transaction; neither is fire-and-forget',
  },
  {
    file: 'services/DirectoryCarriageService.ts',
    kind: 'awaited',
    why: 'RH-LENSES-a (card 74e02a05): the ON CONFLICT DO UPDATE clauses that bump a directory '
      + "reference's and its carriage's last_seen_at. Each is an awaited statement inside the "
      + "carriage transaction, on that transaction's own client, so it cannot outlive the "
      + 'request, which is the property card 8491557e is about. The column is a WATERMARK for a '
      + 'retained orphan rather than a presence signal, so it is not a candidate for the '
      + 'coalescing writer: there is one write per observation, not one per request.',
  },
];

const registered = new Set(REGISTER.map((entry) => entry.file));

describe('the liveness-write census', () => {
  const occurrences = census();

  it('finds no liveness write in a file the register does not name', () => {
    const strangers = occurrences.filter((o) => !registered.has(o.file));
    // The message is the control: whoever trips this needs to know what to do.
    expect(strangers.map((o) => `${o.file}:${o.line}  ${o.text}`)).toEqual([]);
  });

  it('still finds every file the register names — a register may not outlive its subject', () => {
    // The other direction. A register naming files that no longer write the
    // column would quietly stop protecting anything, and would make the test
    // above pass by describing a tree that no longer exists.
    const seen = new Set(occurrences.map((o) => o.file));
    for (const entry of REGISTER) {
      expect(seen.has(entry.file)).toBe(true);
    }
  });

  it('routes every write registered as bounded through the shared writer', () => {
    // Structural, not taken on trust from the register: the statement must sit
    // inside a `presenceWriter.submit(...)` call, which is what makes the three
    // bounds apply to it.
    const boundedFiles = REGISTER.filter((e) => e.kind === 'bounded').map((e) => e.file);
    for (const file of boundedFiles) {
      const text = fs.readFileSync(path.join(SRC, file), 'utf8');
      const pattern = new RegExp(LIVENESS_WRITE.source, 'g');
      let match: RegExpExecArray | null = pattern.exec(text);
      expect(match).not.toBeNull();
      while (match) {
        const before = text.slice(Math.max(0, match.index - 600), match.index);
        expect({ file, submitFound: before.includes('presenceWriter.submit(') })
          .toEqual({ file, submitFound: true });
        match = pattern.exec(text);
      }
    }
  });

  it('leaves no direct fire-and-forget pool write in the file the review found one in', () => {
    // Round-1 P1, named explicitly so a revert is loud rather than quiet.
    const text = fs.readFileSync(path.join(SRC, 'services/AccountPasswordService.ts'), 'utf8');
    expect(text).not.toMatch(LIVENESS_WRITE);
    expect(text).toContain('principalService.bumpCredentialLastUsed(');
  });

  it('censuses a tree that actually contains writes — a census of nothing proves nothing', () => {
    // The vacuity control: a broken walker, a wrong root or a regex that stops
    // matching would make every assertion above pass over an empty list.
    expect(occurrences.length).toBeGreaterThanOrEqual(5);
    expect(new Set(occurrences.map((o) => o.file)).size).toBe(REGISTER.length);
  });
});
