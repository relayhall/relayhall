// Rounds 11 and 12 (reports 0228d375, 5b83a7c7): the FOURTH and FIFTH cascade
// collisions in MapView.css. Round 11: `.map-edge--unrouted { opacity: 0.45 }`
// out-ranked `.map-edge--dimmed { opacity: 0.05 }` by source order, so an
// unrelated unroutable relationship painted nine times brighter than §4
// allows. Round 12: the exact dual - `.map-edge--knowledge.map-edge--neutral`
// out-ranked `.map-edge--lit { stroke-width: 3 }` by SPECIFICITY, and the late
// unrouted marker kept its 0.45 opacity on lit edges, so a SELECTED Knowledge
// relationship carried map-edge--lit and painted as if nothing were selected.
// Rounds 7, 8 and 10 each paid for one collision of the same shape before.
//
// This is the matrix those repairs kept missing: the stylesheet's own cascade,
// resolved the way the browser resolves it (class-selector specificity, then
// source order), across every kind x state x altitude x marker x chain
// composition the component actually emits - for BOTH halves of §4's one
// statement: the selected chain stays LIT, and everything else DIMS. A future
// rule that quietly out-ranks either fails here on the day it is written, not
// five reviews later. The resolver is deliberately minimal - simple compound
// class selectors only - because every rule that has ever collided here was
// one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const css = readFileSync(join(__dirname, 'MapView.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

type Rule = { classes: string[]; order: number; value: string };
const rulesByProperty: Record<string, Rule[]> = { opacity: [], 'stroke-width': [] };
{
  let order = 0;
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    order += 1;
    for (const property of Object.keys(rulesByProperty)) {
      const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(block[2]);
      if (!declaration) continue;
      for (const selector of block[1].split(',')) {
        const s = selector.trim();
        // Simple compound class selectors only (.a.b.c). Anything with
        // combinators, pseudo-classes or attributes is outside this matrix's
        // scope - and outside the collision class it guards against.
        if (!s.startsWith('.') || /[\s>+~:[]/.test(s)) continue;
        const classes = s.split('.').filter(Boolean);
        if (classes.length === 0) continue;
        rulesByProperty[property].push({ classes, order, value: declaration[1].trim() });
      }
    }
  }
}

/** The browser's answer: highest class-count wins, then latest source order. */
const winner = (property: string, classList: string[], initial: string) => {
  let best: Rule | null = null;
  for (const rule of rulesByProperty[property]) {
    if (!rule.classes.every(c => classList.includes(c))) continue;
    if (!best
      || rule.classes.length > best.classes.length
      || (rule.classes.length === best.classes.length && rule.order > best.order)) {
      best = rule;
    }
  }
  return best ? best.value : initial;
};
const opacityOf = (classes: string[]) => winner('opacity', classes, '1');
const widthOf = (classes: string[]) => winner('stroke-width', classes, 'initial');

/**
 * Every composition MapView.tsx actually emits: task edges carry kind + state
 * (+ unrouted + chain), aggregate edges add map-edge--aggregate, Report edges
 * carry knowledge + report (+ unrouted + chain) and no state class.
 */
const COMPOSITIONS: Array<{ name: string; classes: string[] }> = [];
{
  const STATES = ['dammed', 'active', 'satisfied', 'neutral'];
  for (const kind of ['dependency', 'knowledge']) {
    for (const state of STATES) {
      for (const aggregate of [false, true]) {
        for (const unrouted of [false, true]) {
          COMPOSITIONS.push({
            name: `${kind}-${state}${aggregate ? '-aggregate' : ''}${unrouted ? '-unrouted' : ''}`,
            classes: [
              'map-edge', `map-edge--${kind}`,
              ...(aggregate ? ['map-edge--aggregate'] : []),
              `map-edge--${state}`,
              ...(unrouted ? ['map-edge--unrouted'] : []),
            ],
          });
        }
      }
    }
  }
  for (const unrouted of [false, true]) {
    COMPOSITIONS.push({
      name: `report${unrouted ? '-unrouted' : ''}`,
      classes: ['map-edge', 'map-edge--knowledge', 'map-edge--report',
        ...(unrouted ? ['map-edge--unrouted'] : [])],
    });
  }
}

describe('MapView.css cascade matrix — §4 lit and dimmed are authoritative (rounds 11-12 B1)', () => {
  test('the parser found the rules it audits (anti-vacuity)', () => {
    // A refactor that renames these classes must retune the matrix, not let
    // it pass vacuously against nothing. Each control is a rule a collision
    // has actually hidden behind.
    expect(opacityOf(['map-edge', 'map-edge--dimmed'])).toBe('0.05');
    expect(opacityOf(['map-edge', 'map-edge--unrouted'])).toBe('0.45');
    expect(widthOf(['map-edge', 'map-edge--knowledge', 'map-edge--neutral'])).toBe('1.5');
    expect(widthOf(['map-edge', 'map-edge--lit'])).toBe('3');
  });

  test('DIMMED computes §4 opacity for every emitted composition', () => {
    for (const c of COMPOSITIONS) {
      expect(opacityOf([...c.classes, 'map-edge--dimmed']), `${c.name} dimmed`).toBe('0.05');
    }
  });

  test('LIT computes §4 width AND full opacity for every emitted composition', () => {
    for (const c of COMPOSITIONS) {
      expect(widthOf([...c.classes, 'map-edge--lit']), `${c.name} lit width`).toBe('3');
      expect(opacityOf([...c.classes, 'map-edge--lit']), `${c.name} lit opacity`).toBe('1');
    }
  });

  test('without the chain, ordinary and marker presentation are untouched', () => {
    expect(opacityOf(['map-edge', 'map-edge--dependency', 'map-edge--neutral'])).toBe('1');
    expect(opacityOf(['map-edge', 'map-edge--dependency', 'map-edge--neutral', 'map-edge--unrouted'])).toBe('0.45');
    expect(opacityOf(['map-edge', 'map-edge--knowledge', 'map-edge--report'])).toBe('0.75');
    expect(widthOf(['map-edge', 'map-edge--knowledge', 'map-edge--neutral'])).toBe('1.5');
  });

  test('the dimmed furniture family shares the node opacity', () => {
    expect(opacityOf(['map-tile', 'map-tile--dimmed'])).toBe('0.13');
    expect(opacityOf(['map-aggregate', 'map-aggregate--dimmed'])).toBe('0.13');
    expect(opacityOf(['map-aggregate-report', 'map-aggregate-report--dimmed'])).toBe('0.13');
    expect(opacityOf(['map-report-pill', 'map-report-pill--dimmed'])).toBe('0.13');
  });

  /**
   * Round 15 B1 (report 47c67214): the counters row was nowrap flex inside
   * the FIXED 220px measured aggregate box, so all six facts (done, live,
   * stuck, next, two internal-kind marks) could paint OUTSIDE the measured
   * rectangle — the painted-vs-measured class the §2 collision invariant
   * exists to prevent. The mechanism that keeps painted content inside the
   * measured box is wrap-into-height: this pins it in the stylesheet, the
   * only place jsdom can see it. Real-layout containment is executor-verified
   * live (jsdom performs no layout; the number cannot be asserted here).
   */
  test('the aggregate counters row wraps into measured height (round 15 B1)', () => {
    const rule = /\.map-aggregate-counters\s*\{([^}]*)\}/.exec(css);
    expect(rule, '.map-aggregate-counters must exist').not.toBeNull();
    expect(rule![1]).toMatch(/flex-wrap\s*:\s*wrap/);
    // And nothing may clamp the box against growing: the aggregate declares
    // a fixed inline-size but must never declare a fixed block-size.
    const aggregate = /\.map-aggregate\s*\{([^}]*)\}/.exec(css);
    expect(aggregate).not.toBeNull();
    expect(aggregate![1]).not.toMatch(/(?:^|;)\s*(?:block-size|height)\s*:/);
  });
});


describe('RH-UI.17i caption cascade', () => {
  test('caption ink starts inside the top edge for both close and aggregate wrappers', () => {
    expect(css).toMatch(/\.map-container-card\s*\{[^}]*transform-origin:\s*top left/s);
    expect(css).toMatch(/\.map-plane\[data-plane-lod\] \.map-lane-header\s*\{[^}]*transform-origin:\s*top left/s);
    expect(css).toMatch(/\.map-container\s*\{[^}]*overflow:\s*hidden/s);
  });
  test('no LOD-band selector can move or resize a container', () => {
    for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/data-plane-lod\s*=/.test(block[1])) continue;
      expect(block[2]).not.toMatch(/(?:^|;)\s*(?:left|top|width|height|transform)\s*:/);
    }
  });
});
