/**
 * --accent-color is a `ui` token. It may not be ink on text.
 *
 * The contrast matrix in docs/design-system.md declares --accent-color at the
 * 3:1 ui threshold, and the per-Theme gate measures it there. Used as `color`
 * on something a person READS it is therefore ungated below AA, and in
 * relay-light it measures 4.40:1 on --accent-soft -- the defect walkthrough
 * item R7 named and two review rounds kept finding one more instance of, in a
 * closed filter panel, a modal tab, a create form.
 *
 * A count of what is left ("N sites deferred") cannot end that, because the
 * next instance is always outside the count. This test states the property
 * instead: EVERY surviving `color: var(--accent-color)` declaration in the app
 * is one of the icon rules named below, each of which reaches an <svg> or a
 * decorative pseudo-element through currentColor and never text. A new text
 * use fails as an unexpected selector; a removed exemption fails as a stale
 * one. Neither direction can pass silently.
 *
 * To repair a failure, do not add an entry: change the declaration to
 * --text-accent, which is the text tier of the same hue. Add an entry only
 * when the rule genuinely colours an icon, and say which icon.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/**
 * selector -> what the colour actually reaches. Icons only.
 *
 * Round 3 of the review deleted two of these. `.task-column-drag-over
 * .task-column-content::before` was called "a decorative drop-target marker,
 * not text" -- and it carries `content: '↓ Drop here'`, so it paints words, at
 * 4.40:1 in relay-light. `.link-icon` was called "an icon element" and nothing
 * in the app renders it. An exemption list is only as good as its audit, so
 * the two tests below now audit it mechanically instead of trusting the
 * sentence beside each entry.
 */
const ICON_EXEMPTIONS: Record<string, string> = {
  '.skill-card-name':
    'the GraduationCap icon; .skill-card-name h2 immediately below overrides the title to --text-primary',
  '.core-placeholder-icon': 'the wrapper around the {icon} prop on the explanatory shell',
  '.metadata-item svg': 'an svg element, by element selector',
  '.session-meta-item svg': 'an svg element, by element selector',
};

/** Every file under src, for the renderer check below. */
function walkAll(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walkAll(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

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

const stylesheets = walk(SRC);

/** Every non-test .ts/.tsx source, concatenated, for the renderer audit. */
const RENDERED_SOURCE = walkAll(SRC)
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

/**
 * Declaration-anchored on purpose. A bare substring search also matches
 * `scrollbar-color:`, `border-top-color:`, `accent-color:`,
 * `border-block-end-color:` and a custom property named `--status-orb-color`,
 * which is how an earlier census of this very defect came out 50% too high.
 */
const DECL = /(^|[;{\s])color:\s*var\(\s*--accent-color\s*\)/;
const RULE_OPEN = /^([^{}/][^{}]*?)\{/;

/**
 * Class names are TOKENS, not substrings. `source.includes('link-icon')` is
 * satisfied by `task-link-icon`, which is how the first version of the
 * unrendered-class audit below let the exact dead rule it was written for pass
 * (review d7dad4b7 F1). The boundaries are the characters that may appear in a
 * class name, so a match must not be flanked by one.
 */
function isClassRendered(cls: string, source: string): boolean {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(source);
}

/** The last class in a selector -- the one the rule is keyed on. */
function lastClassOf(selector: string): string | null {
  const classes = selector.match(/\.([A-Za-z0-9_-]+)/g);
  return classes && classes.length ? classes[classes.length - 1].slice(1) : null;
}

/**
 * Rules that declare a non-empty `content` paint generated TEXT, whatever else
 * they do. The value is PARSED rather than lookahead-matched: `\s*` backtracks
 * to zero width, so a negative lookahead for `none` matches `content: none`
 * anyway -- which this detector's own control caught on the first run.
 */
const CONTENT_DECL = /(?:^|[;{\s])content:\s*([^;}]*)/;

function paintsGeneratedContent(line: string): boolean {
  const m = CONTENT_DECL.exec(line);
  if (!m) return false;
  const value = m[1].trim().replace(/^['"]|['"]$/g, '').trim();
  return value !== '' && value !== 'none';
}

const found: { selector: string; where: string; body: string[] }[] = [];
for (const file of stylesheets) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let selector = '(none)';
  let start = 0;
  lines.forEach((line, i) => {
    const open = RULE_OPEN.exec(line);
    if (open) { selector = open[1].trim(); start = i; }
    if (DECL.test(line)) {
      // The rule body, so a later test can ask what else the rule declares.
      const body: string[] = [];
      for (let j = start; j < lines.length; j += 1) {
        body.push(lines[j]);
        if (lines[j].includes('}')) break;
      }
      found.push({ selector, where: `${path.relative(SRC, file)}:${i + 1}`, body });
    }
  });
}

describe('--accent-color is a ui token and is never ink on text', () => {
  test('the scan is not vacuous', () => {
    expect(stylesheets.length).toBeGreaterThan(50);
    // The exemptions exist in the tree, so the scanner must find at least them.
    expect(found.length).toBeGreaterThanOrEqual(Object.keys(ICON_EXEMPTIONS).length);
  });

  test('the declaration pattern does not match a different -color property', () => {
    // The control for the pattern itself: these four shapes are NOT this rule.
    expect(DECL.test('  scrollbar-color: var(--accent-color) var(--border-default);')).toBe(false);
    expect(DECL.test('  border-top-color: var(--accent-color);')).toBe(false);
    expect(DECL.test('  accent-color: var(--accent-color);')).toBe(false);
    expect(DECL.test('  --status-orb-color: var(--accent-color);')).toBe(false);
    // ...and these two are.
    expect(DECL.test('  color: var(--accent-color);')).toBe(true);
    expect(DECL.test('.x { color: var(--accent-color); }')).toBe(true);
  });

  test('every surviving declaration is a named icon rule', () => {
    const unexpected = found
      .filter((f) => !(f.selector in ICON_EXEMPTIONS))
      .map((f) => `${f.where}  ${f.selector}`);
    expect(unexpected).toEqual([]);
  });

  test('no exemption is stale', () => {
    const live = new Set(found.map((f) => f.selector));
    const stale = Object.keys(ICON_EXEMPTIONS).filter((s) => !live.has(s));
    expect(stale).toEqual([]);
  });

  // Round 3's finding, promoted into a drilled check: an "icon" rule that
  // declares generated content paints words, and no prose beside the entry
  // can make that untrue.
  test('no exemption paints generated content', () => {
    const painting = found
      .filter((f) => f.selector in ICON_EXEMPTIONS)
      .filter((f) => f.body.some(paintsGeneratedContent))
      .map((f) => `${f.where}  ${f.selector}`);
    expect(painting).toEqual([]);
  });

  test('the generated-content detector fires on the shape it exists for', () => {
    // The control for the control: round 3's actual defect, and its neighbours.
    expect(paintsGeneratedContent("  content: '\u2193 Drop here';")).toBe(true);
    expect(paintsGeneratedContent('  content: attr(data-label);')).toBe(true);
    expect(paintsGeneratedContent('  content: "";')).toBe(false);
    expect(paintsGeneratedContent('  content: none;')).toBe(false);
    expect(paintsGeneratedContent('  align-content: center;')).toBe(false);
  });

  // An exemption for a selector nothing renders is not an exemption, it is a
  // dead rule -- which is what `.link-icon` turned out to be. Element-scoped
  // selectors (`... svg`) are exempt from this check because the element, not
  // a class, is what renders them.
  test('every exempted class is rendered by some component', () => {
    const unrendered = Object.keys(ICON_EXEMPTIONS)
      .filter((sel) => !/\bsvg\b/.test(sel))
      .map(lastClassOf)
      .filter((cls): cls is string => Boolean(cls))
      .filter((cls) => !isClassRendered(cls, RENDERED_SOURCE));
    expect(unrendered).toEqual([]);
  });

  // Round 4's finding, promoted into a drilled control. The first version of
  // the audit above asked `source.includes('link-icon')`, and `task-link-icon`
  // -- a real, unrelated class in TaskLinks.tsx -- contains that substring. So
  // re-adding the exact false exemption round 3 deleted stayed GREEN. A class
  // name is a token, not a substring, and this pins that.
  test('the rendered-class matcher is exact, not a substring test', () => {
    const fixture = '<span className="task-link-icon"><Link2 size={16} /></span>';
    expect(isClassRendered('link-icon', fixture)).toBe(false);
    expect(isClassRendered('task-link-icon', fixture)).toBe(true);
    // ...and against the real tree: `.link-icon` is the rule round 3 deleted.
    expect(isClassRendered('link-icon', RENDERED_SOURCE)).toBe(false);
    expect(isClassRendered('task-link-icon', RENDERED_SOURCE)).toBe(true);
    // A live exemption must of course still be found.
    expect(isClassRendered('skill-card-name', RENDERED_SOURCE)).toBe(true);
  });
});
