/**
 * Every colour lane L1 paints follows the Theme (card b1e3b16d).
 *
 * Dark, light and high-contrast are three blocks of semantic tokens in
 * `styles/variables.css` (`[data-theme="relay-dark"]` — also the no-Theme
 * fallback — `relay-light` and `high-contrast`). A surface follows the Theme
 * exactly when every colour it paints is one of those tokens; a literal, or a
 * token only one Theme defines, is a surface that stays dark in light mode (or
 * vanishes in high contrast). So for the stylesheets this lane adds — and the
 * bell's two blocks in `Sidebar.css` — this reads every colour-bearing declaration
 * and asserts: no literal colour, and every token it names is defined by all
 * three Theme blocks. The pairings themselves are enforced per Theme by
 * scripts/check-design-contrast.py; the rendered check at 390px in both
 * Themes is the lane's browser pass.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');

const variables = read('styles/variables.css');

function themeBlock(selector: string): string {
  const at = variables.indexOf(`${selector} {`);
  expect(at, `${selector} is missing from variables.css`).toBeGreaterThan(-1);
  return variables.slice(at, variables.indexOf('\n}', at));
}

const THEMES = {
  'relay-dark': themeBlock('[data-theme="relay-dark"]'),
  'relay-light': themeBlock('[data-theme="relay-light"]'),
  'high-contrast': themeBlock('[data-theme="high-contrast"]'),
};

const sidebarCss = read('components/Sidebar.css');
const bellBlockStart = sidebarCss.indexOf('THE BELL IN THE ACCOUNT ROW');

const SHEETS: Record<string, string> = {
  'components/approvals/ApprovalsQueue.css': read('components/approvals/ApprovalsQueue.css'),
  'components/approvals/ApprovalDrawer.css': read('components/approvals/ApprovalDrawer.css'),
  'components/approvals/DecisionNotice.css': read('components/approvals/DecisionNotice.css'),
  // Card 502fb19e slice S3 (design section 9.4): the change request's decide form, dialog and My requests.
  'components/approvals/ChangeRequests.css': read('components/approvals/ChangeRequests.css'),
  'components/notifications/NotificationBell.css': read('components/notifications/NotificationBell.css'),
  // Card 5854f0d6 Slice B (Notifications and Timeline design): the action list, the Timeline,
  // and the dashboard's "Needs your action" card and Activity widget.
  'components/notifications/ActionList.css': read('components/notifications/ActionList.css'),
  'components/notifications/TimelinePanel.css': read('components/notifications/TimelinePanel.css'),
  'components/dashboard/NotificationsCard.css': read('components/dashboard/NotificationsCard.css'),
  'components/dashboard/ActivityFeed.css': read('components/dashboard/ActivityFeed.css'),
  'pages/ApprovalsPage.css': read('pages/ApprovalsPage.css'),
  'pages/NotificationsPage.css': read('pages/NotificationsPage.css'),
  'components/Sidebar.css (the bell blocks)': sidebarCss.slice(bellBlockStart),
};

const COLOUR_PROPERTY = /^(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|box-shadow)$/;
const LITERAL = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|\b(white|black|red|green|blue|gray|grey)\b/i;

function colourDeclarations(css: string): Array<{ property: string; value: string }> {
  const out: Array<{ property: string; value: string }> = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) {
    if (COLOUR_PROPERTY.test(match[1])) out.push({ property: match[1], value: match[2].trim() });
  }
  return out;
}

describe('lane L1 paints only Theme tokens', () => {
  test('the bell block was found in Sidebar.css, so its check is not vacuous', () => {
    expect(bellBlockStart).toBeGreaterThan(-1);
    for (const css of Object.values(SHEETS)) expect(colourDeclarations(css).length).toBeGreaterThan(0);
  });

  test.each(Object.keys(SHEETS))('%s: no literal colour, and every colour token exists in all three Themes', (name) => {
    const problems: string[] = [];
    for (const { property, value } of colourDeclarations(SHEETS[name])) {
      if (LITERAL.test(value)) problems.push(`${property}: ${value} is a literal colour`);
      for (const token of value.matchAll(/var\((--[a-z0-9-]+)/g)) {
        for (const [theme, block] of Object.entries(THEMES)) {
          if (!new RegExp(`\\s${token[1]}:`).test(block)) problems.push(`${property}: ${token[1]} is not defined by ${theme}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
