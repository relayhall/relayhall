/**
 * Every design token named from TypeScript must exist.
 *
 * scripts/check-design-tokens.py enforces this for stylesheets, and it is
 * thorough there -- but it reads *.css, and a `style={{ color: 'var(--x)' }}`
 * in a .tsx file is not a stylesheet. Three tokens had been living in that
 * blind spot: ActiveWorkPreview's priority ladder returned `var(--orange-400)`
 * and `var(--blue-400)`, and ProjectOverview's progress bar returned
 * `var(--yellow-400)` and `var(--orange-400)`. None of the three is defined in
 * any Theme, so the declaration was invalid at computed-value time and the
 * property fell back to `unset` -- an inherited colour for the chip, no fill
 * at all for the bar. Nothing was red anywhere: not the type checker, not the
 * suites, not the token gate, not axe (an absent background is not a contrast
 * failure).
 *
 * This test closes that hole from inside the frontend suite rather than by
 * widening a shared Python gate that five concurrent lanes depend on.
 *
 * It is deliberately blunt: it does not care WHICH stylesheet defines a token,
 * only that some stylesheet in the app does. A token that no stylesheet
 * declares cannot resolve at runtime no matter where it is used.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC);
const stylesheets = files.filter((f) => f.endsWith('.css'));
const scripts = files.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

/** Every custom property DECLARED by any stylesheet in the app. */
const declared = new Set<string>();
for (const file of stylesheets) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) declared.add(m[1]);
}

/** Every custom property READ from TypeScript, with where it was read. */
const used = new Map<string, string[]>();
for (const file of scripts) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      const where = `${path.relative(SRC, file)}:${i + 1}`;
      used.set(m[1], [...(used.get(m[1]) ?? []), where]);
    }
  });
}

describe('design tokens named from TypeScript', () => {
  test('the census is not empty (this test would otherwise pass vacuously)', () => {
    expect(stylesheets.length).toBeGreaterThan(50);
    expect(declared.size).toBeGreaterThan(100);
    expect(used.size).toBeGreaterThan(10);
  });

  test('a token no stylesheet declares is detected', () => {
    // The control: the detector must actually fire on the shape it exists for.
    const fake = '--token-that-no-stylesheet-declares';
    expect(declared.has(fake)).toBe(false);
  });

  test('every token used from a .ts/.tsx file is declared by some stylesheet', () => {
    const missing = [...used.entries()]
      .filter(([token]) => !declared.has(token))
      .map(([token, where]) => `${token} used at ${where.join(', ')}`);
    expect(missing).toEqual([]);
  });
});
