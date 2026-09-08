/*
 * CENSUS CONTROL — no surface may tell a person to regenerate or rotate a
 * credential except through `lostCredentialRecovery`.
 *
 * WHY A CENSUS AND NOT MORE ASSERTIONS. This defect was repaired three times
 * and came back three times, each repair correct about the coordinate it was
 * handed: round 1's fix produced P3-R2, round 2's fix left P3-R3, and a
 * follow-up census then found two more sites nobody had named. Every one was
 * the same mistake — a component composing advice about an authority it does
 * not know the caller holds. Pinning the four known sites would leave the
 * fifth free.
 *
 * So this does not check the four sites. It checks that NO user-facing string
 * anywhere under `frontend/src` mentions regeneration or rotation unless it is
 * an explicitly declared value, each with the reason it is allowed. A new
 * hard-coded sentence fails this suite the moment it is written, which is what
 * makes the class unrepresentable rather than merely absent today.
 *
 * EXEMPTIONS ARE BY VALUE, NEVER BY FILE. Exempting a file would re-open the
 * hole inside it — which is exactly how `BootstrapPane` came to hold two of
 * these sentences while the page next to it disabled the action.
 */
import { describe, expect, it } from 'vitest';
import { RECOVERY_INTENT_PATTERN } from './types/connections';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(process.cwd(), 'src');

/**
 * The words that name the act a Member cannot perform — the SHARED pattern,
 * so this control and the parity control cannot drift apart the way the
 * sentences they guard once did. Round 4 defeated the previous local copy with
 * "issue a new credential"; the forms it now covers each have a red control
 * below.
 */
const PATTERN = RECOVERY_INTENT_PATTERN;

/**
 * Every value permitted to contain those words, and why. A value that is not
 * here fails the census — including a reworded version of one that is.
 */
const ALLOWED: Array<{ value: string; why: string }> = [
  {
    value: 'Regeneration is an administrator act in this release',
    why: 'REGENERATE_ADMIN_ONLY in types/connections.ts — the refusal reason the predicate module owns.',
  },
  {
    value: 'regenerate its credential from My connections',
    why: 'the ROOT branch of lostCredentialRecovery in types/connections.ts — the one place the advice is composed.',
  },
  {
    value: 'Regenerate credential',
    why: 'the button label on My connections. It names the control; the control itself is disabled from the predicate.',
  },
  {
    value: 'The board refused the regeneration.',
    why: 'a failure toast on the rotate call, which only a session that passed mayRegenerateCredential can reach.',
  },
  {
    value: "A credential&rsquo;s authority is fixed when it is issued: regeneration copies the scope set and the transport pin verbatim, and the board refuses a regeneration that tries to change either. To narrow this connection, make a narrower one and disable this.",
    why: 'states what rotation DOES (AUTHZ §7.3). It makes no claim that the reader may perform it, and it sits directly above the control with its reason.',
  },
  {
    value: '${API_BASE}/credentials/${credential.id}/rotate',
    why: 'the REST path of the rotate endpoint. Not prose; never rendered.',
  },
];

const allowedSet = new Set(ALLOWED.map((entry) => normalise(entry.value)));

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Pull the values a reader could see out of one source file: string literal
 * contents and JSX text runs, with comments removed.
 *
 * Comments are removed by a character scan rather than a regex, because a
 * regex that strips `//` also eats the `//` inside every URL literal in the
 * tree and would quietly change what the census sees.
 */
export function userFacingChunks(source: string): string[] {
  const chunks: string[] = [];
  let skeleton = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      skeleton += ' ';
      continue;
    }
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < source.length) {
        if (source[j] === '\\') { value += source[j + 1] ?? ''; j += 2; continue; }
        if (source[j] === quote) break;
        value += source[j];
        j += 1;
      }
      chunks.push(value);
      skeleton += ' STRING ';
      i = j + 1;
      continue;
    }
    skeleton += ch;
    i += 1;
  }
  // JSX text: a run between tags carrying no braces or angle brackets.
  const jsx = /> *([^<>{}]+?) *</g;
  let match = jsx.exec(skeleton);
  while (match !== null) {
    chunks.push(match[1]);
    match = jsx.exec(skeleton);
  }
  return chunks;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

interface Finding { file: string; value: string; }

function census(files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const chunk of userFacingChunks(source)) {
      const value = normalise(chunk);
      if (!value || !PATTERN.test(value)) continue;
      if (allowedSet.has(value)) continue;
      findings.push({ file: relative(SRC, file), value });
    }
  }
  return findings;
}

describe('regeneration advice is composed in exactly one place', () => {
  it('no user-facing string mentions regeneration or rotation outside the declared set', () => {
    const findings = census(sourceFiles(SRC));
    const report = findings.map((f) => `${f.file}: ${JSON.stringify(f.value)}`).join('\n');
    expect(report).toBe('');
  });

  it('CONTROL: the census FIRES on a newly hard-coded sentence', () => {
    // Without this the test above is satisfied by a scanner that finds nothing
    // — which is precisely how the earlier leak controls passed for free.
    const planted = "const msg = 'Open it from My connections and regenerate its credential.';";
    const chunks = userFacingChunks(planted).map(normalise).filter((v) => PATTERN.test(v));
    expect(chunks).toHaveLength(1);
    expect(allowedSet.has(chunks[0])).toBe(false);
  });

  it('CONTROL: it fires on JSX text too, not only string literals', () => {
    const planted = '<p>If you lose it, regenerate the credential.</p>';
    const chunks = userFacingChunks(planted).map(normalise).filter((v) => PATTERN.test(v));
    expect(chunks).toHaveLength(1);
  });

  it('CONTROL: it does NOT fire on comments, so the exemption list stays honest', () => {
    const commented = [
      '// only a root session can rotate a credential',
      '/* regeneration is an administrator act */',
      "const url = 'https://example.test/a//b';",
    ].join('\n');
    const chunks = userFacingChunks(commented).map(normalise).filter((v) => PATTERN.test(v));
    expect(chunks).toEqual([]);
  });

  it.each([
    'Open My connections and re-generate its credential.',
    'You can regen the credential from My connections.',
    'Try rolling the credential from My connections.',
    'Ask an administrator to issue a new credential.',
  ])('CONTROL: the census fires on the round-4 synonym %#', (planted) => {
    // Each of these left the census green before round 5, and each is here
    // because a review got past the previous matcher rather than because
    // somebody imagined it.
    const chunks = userFacingChunks(`const m = '${planted}';`).map(normalise).filter((v) => PATTERN.test(v));
    expect(chunks).toHaveLength(1);
    expect(allowedSet.has(chunks[0])).toBe(false);
  });

  it('CONTROL: it does not fire on ordinary prose that merely contains the words', () => {
    // The matcher must not be so wide that every exemption becomes mandatory.
    for (const innocent of [
      'connect a replacement agent from My connections and disable this one',
      'The board registered the connection but could not issue its credential.',
      'A new credential is shown once.',
    ]) {
      expect(PATTERN.test(innocent)).toBe(false);
    }
  });

  it('CONTROL: a REWORDING of an allowed value is not allowed', () => {
    // Exemptions are exact values. Softening one must fail rather than pass by
    // resemblance — that is the difference between a list and a licence.
    const reworded = normalise('Regeneration is an administrator action in this release');
    expect(allowedSet.has(reworded)).toBe(false);
  });

  it('every exemption carries a reason', () => {
    for (const entry of ALLOWED) {
      expect(entry.why.length).toBeGreaterThan(30);
      expect(PATTERN.test(entry.value)).toBe(true);
    }
  });
});
