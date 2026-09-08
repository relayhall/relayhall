/*
 * DRIFT CONTROL — the frontend's reserved-slug mirror must equal the board's.
 *
 * `RESERVED_CONNECTION_SLUGS` is a declared mirror of `RESERVED_SERVICE_SLUGS`
 * in `backend/src/services/KnowledgeSourcePolicy.ts`, because that module
 * imports Node's `net` and the frontend image is built from `frontend/` alone,
 * so it cannot be imported. A mirror with nothing watching it is how round 4
 * happened: main added a reserved slug, the wizard never learned, and the form
 * told a person the name "Board" was usable while the board refused it 422.
 *
 * This test reads the backend module and fails when the two sets disagree in
 * EITHER direction — a slug the board reserves that the form would accept, or
 * one the form refuses that the board does not. It follows the estate's
 * existing cross-package pattern (`acceptanceContracts.test.ts` reads
 * `../../docker-compose.yml` and `../../scripts/class-rename-map.json`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED_CONNECTION_SLUGS } from './types/connections';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = join(HERE, '../../backend/src/services/KnowledgeSourcePolicy.ts');

/**
 * The reserved slugs a source file declares.
 *
 * The board builds its set from named constants
 * (`new Set([KNOWLEDGE_BOARD_SOURCE_SLUG])`), so members are resolved against
 * `export const NAME = '...'` in the same file; inline string members are taken
 * as they stand. An unresolvable member is an ERROR rather than a silent skip —
 * a parser that quietly drops what it does not understand would hand back a
 * short set and the comparison would pass for the wrong reason.
 */
export function reservedSlugsFrom(source: string): Set<string> {
  const consts = new Map<string, string>();
  const constRe = /export\s+const\s+([A-Z0-9_]+)\s*(?::[^=]+)?=\s*'([^']*)'/g;
  let m = constRe.exec(source);
  while (m !== null) {
    consts.set(m[1], m[2]);
    m = constRe.exec(source);
  }

  const setRe = /export\s+const\s+RESERVED_SERVICE_SLUGS\s*(?::[^=]+)?=\s*new\s+Set\s*\(\s*\[([^\]]*)\]/;
  const found = setRe.exec(source);
  if (!found) throw new Error('RESERVED_SERVICE_SLUGS set literal not found in the policy module');

  const out = new Set<string>();
  for (const raw of found[1].split(',')) {
    const member = raw.replace(/\/\/[^\n]*/g, '').trim();
    if (!member) continue;
    const literal = /^'([^']*)'$/.exec(member);
    if (literal) { out.add(literal[1]); continue; }
    const resolved = consts.get(member);
    if (resolved === undefined) {
      throw new Error(`reserved-slug member ${member} could not be resolved to a value`);
    }
    out.add(resolved);
  }
  return out;
}

const boardSlugs = reservedSlugsFrom(readFileSync(POLICY, 'utf-8'));

describe('the reserved-slug mirror cannot drift from the board', () => {
  it('the frontend mirror equals RESERVED_SERVICE_SLUGS exactly', () => {
    expect([...RESERVED_CONNECTION_SLUGS].sort()).toEqual([...boardSlugs].sort());
  });

  it('CONTROL: the extractor is not vacuous — it really reads the board module', () => {
    // A comparison against an empty set would pass while the mirror said
    // nothing, which is the failure this whole file exists to prevent.
    expect(boardSlugs.size).toBeGreaterThan(0);
    expect(boardSlugs.has('board')).toBe(true);
  });

  it('CONTROL: a slug ADDED on the board is detected', () => {
    const grown = reservedSlugsFrom(`
      export const KNOWLEDGE_BOARD_SOURCE_SLUG = 'board';
      export const OTHER_SLUG = 'ledger';
      export const RESERVED_SERVICE_SLUGS: ReadonlySet<string> = new Set([
        KNOWLEDGE_BOARD_SOURCE_SLUG,
        OTHER_SLUG,
      ]);
    `);
    expect([...grown].sort()).toEqual(['board', 'ledger']);
    // ...and against today's mirror that is a disagreement, which is a failure.
    expect([...RESERVED_CONNECTION_SLUGS].sort()).not.toEqual([...grown].sort());
  });

  it('CONTROL: an inline string member is read too, not only a named constant', () => {
    const inline = reservedSlugsFrom(
      "export const RESERVED_SERVICE_SLUGS: ReadonlySet<string> = new Set(['board', 'inline']);",
    );
    expect([...inline].sort()).toEqual(['board', 'inline']);
  });

  it('CONTROL: an unresolvable member THROWS rather than being silently dropped', () => {
    expect(() => reservedSlugsFrom(
      'export const RESERVED_SERVICE_SLUGS: ReadonlySet<string> = new Set([SOME_UNKNOWN_SLUG]);',
    )).toThrow(/could not be resolved/);
  });

  it('CONTROL: a missing set literal THROWS rather than yielding an empty set', () => {
    expect(() => reservedSlugsFrom('export const SOMETHING_ELSE = 1;'))
      .toThrow(/not found/);
  });
});
