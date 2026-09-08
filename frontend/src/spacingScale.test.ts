/**
 * If a spacing value is on the scale, it is written as the token.
 *
 * Walkthrough item R16 counted about three hundred raw-px padding, margin and
 * gap declarations and called them "off the token scale". Measured, they are
 * two different things:
 *
 *   140 of them used a value that IS on the scale -- 4, 8, 12, 16, 20, 24, 32,
 *   40, 48, 64, 80 -- and simply spelled it in px. Those are now tokens, and
 *   the substitution is pixel-identical by construction.
 *
 *   162 of them use 6, 10, 2, 3, 14... which sit BETWEEN the scale's steps.
 *   The product has a de-facto half-step rhythm in its dense chrome that the
 *   scale does not express. Converting those would move pixels on every
 *   screen, so they are a design decision for the owner and this test does not
 *   forbid them.
 *
 * So the property here is narrow and exactly true: a value on the scale must
 * be written as its token. It cannot be satisfied by rewriting a literal to a
 * DIFFERENT literal, and it says nothing about values the scale has no name
 * for -- which is what keeps it honest rather than aspirational.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/** px -> token, read from variables.css so the test cannot drift from it. */
function scaleFromTokens(): Map<number, string> {
  const css = fs.readFileSync(path.join(SRC, 'styles', 'variables.css'), 'utf8');
  const map = new Map<number, string>();
  for (const m of css.matchAll(/(--space-\d+)\s*:\s*([\d.]+)rem\s*;/g)) {
    map.set(Math.round(parseFloat(m[2]) * 16), m[1]);
  }
  return map;
}

const SCALE = scaleFromTokens();

const PROP =
  'padding|margin|gap|row-gap|column-gap' +
  '|padding-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end)' +
  '|margin-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end)';
const DECL = new RegExp(`^\\s*(?:${PROP})\\s*:\\s*([^;]+);`);
const PX = /(?<![\w.-])(\d+(?:\.\d+)?)px/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.css')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Declarations that stay literal, each with the reason and the control that
 * requires it. An entry here is a DEFERRAL TO ANOTHER REVIEW, not a licence:
 * the stale check below fails if the literal is gone, so an exemption cannot
 * outlive the thing it defers to.
 */
const RATIFIED_LITERALS: Record<string, string> = {
  'components/tasks/TaskCard.css  padding-left: 48px;':
    'the geometry pin in pages/TasksPage.boardKeyboard.test.tsx (C2 2.1, review 324cebef B2) '
    + 'reads this value out of the stylesheet TEXT; --space-12 is exactly 48px but would defeat it',
};

const stylesheets = walk(SRC);
const onScaleLiterals: string[] = [];
const exemptSeen = new Set<string>();
let offScale = 0;

for (const file of stylesheets) {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const m = DECL.exec(line);
    if (!m) return;
    const value = m[1];
    if (value.includes('var(') || value.includes('calc(') || value.includes('%')) return;
    const found = [...value.matchAll(PX)].map((x) => Number(x[1]));
    if (!found.length) return;
    if (found.every((n) => Number.isInteger(n) && SCALE.has(n))) {
      const key = `${rel}  ${line.trim()}`;
      if (key in RATIFIED_LITERALS) exemptSeen.add(key);
      else onScaleLiterals.push(`${rel}:${i + 1}  ${line.trim()}`);
    } else {
      offScale += 1;
    }
  });
}

describe('spacing that is on the scale is written as the token', () => {
  test('the scale was read from variables.css and is not empty', () => {
    expect(SCALE.size).toBeGreaterThanOrEqual(10);
    expect(SCALE.get(16)).toBe('--space-4');
    expect(SCALE.get(24)).toBe('--space-6');
  });

  test('the scan is not vacuous', () => {
    expect(stylesheets.length).toBeGreaterThan(50);
    // The off-scale half-step rhythm is real and this test tolerates it, so it
    // must still be FOUND -- if this ever reaches zero the detector has broken
    // rather than the tree having become perfect.
    expect(offScale).toBeGreaterThan(50);
  });

  test('the detector distinguishes on-scale from off-scale', () => {
    // Mirrors the scan above exactly, including the order of its guards.
    const probe = (line: string) => {
      const m = DECL.exec(line);
      if (!m) return 'not-a-spacing-declaration';
      const value = m[1];
      if (value.includes('var(') || value.includes('calc(') || value.includes('%')) return 'already-tokenised';
      const found = [...value.matchAll(PX)].map((x) => Number(x[1]));
      if (!found.length) return 'no-px';
      return found.every((n) => Number.isInteger(n) && SCALE.has(n)) ? 'on-scale' : 'off-scale';
    };
    expect(probe('  padding: 16px;')).toBe('on-scale');
    expect(probe('  padding: 8px 24px;')).toBe('on-scale');
    expect(probe('  gap: 10px;')).toBe('off-scale');
    expect(probe('  padding: 8px 10px;')).toBe('off-scale');
    expect(probe('  padding: var(--space-4);')).toBe('already-tokenised');
    expect(probe('  padding: 0;')).toBe('no-px');
    expect(probe('  border-radius: 16px;')).toBe('not-a-spacing-declaration');
  });

  test('no on-scale spacing value is still written as a px literal', () => {
    expect(onScaleLiterals).toEqual([]);
  });

  test('every ratified literal exemption is still present, and reasoned', () => {
    const stale = Object.keys(RATIFIED_LITERALS).filter((k) => !exemptSeen.has(k));
    expect(stale).toEqual([]);
    for (const reason of Object.values(RATIFIED_LITERALS)) {
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
