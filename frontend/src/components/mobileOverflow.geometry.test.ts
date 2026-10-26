/**
 * PHONE-WIDTH OVERFLOW RULES, PINNED AT THE STYLESHEET (E461).
 *
 * The Action Center page scrolled sideways on a phone: its five-tab row was wider
 * than the screen and the shell (`.main-content`, `overflow-y: auto`) turned
 * that into a sideways scroll of the whole page. The census in
 * `scripts/mobile-overflow-census.mjs` (a real browser, 375 and 320 px) found
 * more pages with the same fault. Vitest applies no CSS, so each cure is pinned
 * here the way `Sidebar.geometry.test.ts` pins the sidebar: read the stylesheet
 * from disk, check the rule. The browser census proves the pixels; these pins
 * keep the cause from coming back unnoticed between census runs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(join(HERE, '..', relative), 'utf-8').replace(/\r\n/g, '\n');

function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} is missing`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('\n}', start));
}

describe('the Action Center page frame', () => {
  const css = read('pages/NotificationsPage.css');
  test('the view switch is capped at its column, and the page may shrink below its content', () => {
    expect(css.length).toBeGreaterThan(500);
    expect(rule(css, '.notifications-page-tabs')).toMatch(/max-width:\s*100%/);
    expect(rule(css, '.notifications-page')).toMatch(/min-width:\s*0/);
  });
});

describe('the Timeline rows', () => {
  test('a long unbroken word in a row wraps inside the row', () => {
    expect(rule(read('components/notifications/TimelinePanel.css'), '.timeline-panel-item-body')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('the dashboard system status grid', () => {
  const css = read('components/dashboard/SystemStatus.css');
  test('its two columns may shrink below their content and the label wraps', () => {
    expect(rule(css, '.system-status-grid')).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(rule(css, '.system-status-item')).toMatch(/min-width:\s*0/);
    expect(rule(css, '.system-status-label')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('the Personalities header', () => {
  test('the title row wraps instead of running past the viewport', () => {
    const body = rule(read('pages/PersonalitiesPage.css'), '.personalities-title');
    expect(body).toMatch(/flex-wrap:\s*wrap/);
    expect(body).toMatch(/max-width:\s*100%/);
  });
});

describe('the knowledge source registration file input', () => {
  test('the native file input may shrink to its column', () => {
    const css = read('components/services/KnowledgeSourceRegistrationPanel.css');
    expect(css).toMatch(/\.ksr-file input\[type="file"\] \{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
  });
});
