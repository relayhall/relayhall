/**
 * selectAccessibleNames.test.ts — card 61ba2b81: every select on the human
 * surface has an accessible name, kept true as a CLASS, not one instance at
 * a time (two pages had already shipped the same axe select-name CRITICAL
 * defect one review apart).
 *
 * The sweep is static and total: every raw `<select` and every `<Select`
 * component usage in production source must carry, inside its own attribute
 * region, an `aria-label`/`aria-labelledby`, an `id` PROVABLY paired with a
 * `<label htmlFor>` (literal ids by value; dynamic ids only when the same
 * expression appears in an htmlFor — an id alone names nothing, review
 * 7fe57865 F1), or a wrapping `<label>`. The ui/Select passthrough is
 * exempt ONLY at its single `{...rest}` render — any other select in that
 * file is bound like everything else (review 7fe57865 F1). jsdom axe
 * coverage of the repaired surface lives in a11y.smoke.test.tsx; the live
 * pass runs axe via CDP against DEV with pass counts recorded.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

interface SelectSite {
  line: number;
  attributes: string;
  wrappedInLabel: boolean;
}

/** Every <select ...> / <Select ...> element with its full attribute region. */
function selectSites(source: string): SelectSite[] {
  const sites: SelectSite[] = [];
  const pattern = /<(select|Select)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    // The element's own closing '>' — brace-aware so `onChange={(e) => ...}`
    // arrows and other expression bodies never truncate the region.
    let depth = 0;
    let close = -1;
    for (let i = match.index; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0 && source[i - 1] !== '=') { close = i; break; }
    }
    const attributes = source.slice(match.index, close === -1 ? source.length : close);
    const line = source.slice(0, match.index).split('\n').length;
    // A wrapping <label> ancestor on the same or preceding lines satisfies
    // the name rule (label wrapping is one of the sanctioned mechanisms).
    const windowStart = Math.max(0, match.index - 400);
    const before = source.slice(windowStart, match.index);
    const lastLabelOpen = before.lastIndexOf('<label');
    const lastLabelClose = before.lastIndexOf('</label>');
    const wrappedInLabel = lastLabelOpen !== -1 && lastLabelOpen > lastLabelClose;
    sites.push({ line, attributes, wrappedInLabel });
  }
  return sites;
}

/**
 * The auditable core, exported to the fixtures below: given one file's
 * source, classify every select site. `isSelectWrapper` marks the ui/Select
 * passthrough file, whose ONLY exempt site is the `{...rest}` render.
 */
export function auditSelects(
  file: string,
  source: string,
  isSelectWrapper: boolean,
): { covered: string[]; offenders: string[] } {
  const covered: string[] = [];
  const offenders: string[] = [];
  for (const site of selectSites(source)) {
    if (isSelectWrapper && site.attributes.includes('{...rest}')) {
      // The single passthrough render: its CONSUMERS carry the name.
      continue;
    }
    const hasAriaLabel = /aria-label(ledby)?\s*=/.test(site.attributes);
    const literalId = site.attributes.match(/\bid\s*=\s*["']([^"']+)["']/)
      ?? site.attributes.match(/\bid\s*=\s*\{\s*["']([^"']+)["']\s*\}/);
    const literalPaired = literalId !== null
      && (source.includes(`htmlFor="${literalId[1]}"`) || source.includes(`htmlFor={'${literalId[1]}'}`)
        || source.includes(`htmlFor={\`${literalId[1]}\`}`) || source.includes(`htmlFor={"${literalId[1]}"}`));
    // A DYNAMIC id names nothing by itself (review 7fe57865 F1): it counts
    // only when the pairing is PROVABLE — either the exact same expression
    // appears in a label's htmlFor, or the id comes from a shared id-factory
    // call (`id={fieldDomId('x')}`) and the file pairs labels through that
    // same factory (`htmlFor={fieldDomId(...)}` — the ProjectResources
    // renderField pattern).
    const dynamicId = literalId === null
      ? site.attributes.match(/\bid\s*=\s*(\{[^}]+\})/)
      : null;
    const factoryName = dynamicId?.[1].match(/^\{\s*([A-Za-z_$][\w$]*)\s*\(/)?.[1] ?? null;
    const dynamicPaired = dynamicId !== null && (
      source.includes(`htmlFor=${dynamicId[1]}`)
      || (factoryName !== null && source.includes(`htmlFor={${factoryName}(`))
    );
    if (hasAriaLabel || literalPaired || dynamicPaired || site.wrappedInLabel) {
      covered.push(`${file}:${site.line}`);
    } else {
      offenders.push(`${file}:${site.line} — <select> with no aria-label, provably paired label, or wrapping label`);
    }
  }
  return { covered, offenders };
}

describe('every select on the human surface has an accessible name', () => {
  const files = walk(SRC);
  const offenders: string[] = [];
  const covered: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const isSelectWrapper = file.endsWith(join('components', 'ui', 'Select.tsx'));
    const result = auditSelects(file, source, isSelectWrapper);
    covered.push(...result.covered);
    offenders.push(...result.offenders);
  }

  test('the sweep is not vacuous and finds no unnamed select', () => {
    // A green row must mean something: the sweep must actually have walked
    // the known select population (37 consumer sites at authoring time;
    // growth is fine, shrinkage below the floor means the scanner broke).
    expect(covered.length).toBeGreaterThanOrEqual(15);
    expect(offenders).toEqual([]);
  });

  test('the two repaired surfaces carry their fixes', () => {
    const reports = readFileSync(join(SRC, 'pages', 'ReportsPage.tsx'), 'utf8');
    expect(reports).toContain('aria-label="Filter by project"');
    expect(reports).toContain('All projects');
    expect(reports).not.toContain('All Projects</option>');
    const skills = readFileSync(join(SRC, 'pages', 'SkillsPage.tsx'), 'utf8');
    expect(skills).toContain('All categories');
    expect(skills).not.toContain('All Categories');
  });
});

describe('the gate itself stays red-capable (review 7fe57865 F1 fixtures)', () => {
  test('an unpaired DYNAMIC id does not pass', () => {
    const fixture = '<select id={categoryFilter} value={x} onChange={(e) => set(e.target.value)}><option>o</option></select>';
    const result = auditSelects('fixture.tsx', fixture, false);
    expect(result.offenders).toHaveLength(1);
    expect(result.covered).toHaveLength(0);
  });

  test('a dynamic id PROVABLY paired with the same htmlFor expression passes', () => {
    const fixture = '<label htmlFor={selectId}>Kind</label><select id={selectId} value={x}><option>o</option></select>';
    const result = auditSelects('fixture.tsx', fixture, false);
    expect(result.offenders).toHaveLength(0);
    expect(result.covered).toHaveLength(1);
  });

  test('the wrapper exemption covers ONLY the passthrough render — an extra unnamed select in that file fails', () => {
    const fixture = [
      'export const Select = React.forwardRef((props, ref) => (',
      '  <select ref={ref} className="form-select" {...rest}>{children}</select>',
      '));',
      'export const Rogue = () => <select><option>Unnamed control</option></select>;',
    ].join('\n');
    const result = auditSelects('components/ui/Select.tsx', fixture, true);
    expect(result.offenders).toHaveLength(1);
    expect(result.offenders[0]).toContain(':4');
  });

  test('a shared id-factory pairing passes; the same call with no factory-paired label fails', () => {
    const paired = [
      "const fieldDomId = (key) => `resource-field-${key}`;",
      "<label htmlFor={fieldDomId(key)}>Role</label>",
      "<Select id={fieldDomId('repositoryRole')} value={x}><option>o</option></Select>",
    ].join('\n');
    expect(auditSelects('fixture.tsx', paired, false).offenders).toHaveLength(0);
    const unpaired = "<Select id={fieldDomId('repositoryRole')} value={x}><option>o</option></Select>";
    expect(auditSelects('fixture.tsx', unpaired, false).offenders).toHaveLength(1);
  });

  test('a removed aria-label goes red (positive sensitivity control)', () => {
    const fixture = '<select className="reports-project-filter" value={activeProject} onChange={(e) => setActiveProject(e.target.value)}><option value="">All projects</option></select>';
    const result = auditSelects('fixture.tsx', fixture, false);
    expect(result.offenders).toHaveLength(1);
  });
});
