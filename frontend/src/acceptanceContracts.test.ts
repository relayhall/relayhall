import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import sidebarSource from './components/Sidebar.tsx?raw';
import taskColumnSource from './components/tasks/TaskColumn.tsx?raw';
import createTaskSource from './pages/TaskCreatePage.tsx?raw';
import personalitiesSource from './pages/PersonalitiesPage.tsx?raw';
import personalityDetailSource from './pages/PersonalityDetailPage.tsx?raw';
import principalsSource from './pages/PrincipalsPage.tsx?raw';
import createIdentityWizardSource from './components/identity/CreateIdentityWizard.tsx?raw';
import aboutSource from './pages/AboutPage.tsx?raw';

// CSS must be read from disk: a `?raw` import of a stylesheet yields '' under
// vitest's CSS handling, which silently turned every CSS pin below into a
// no-op (caught by RH-UI.1a's positive pins). Source-text pins on stylesheets
// therefore go through readCss(), never through `?raw`.
const HERE = dirname(fileURLToPath(import.meta.url));
const readCss = (rel: string): string => {
  const text = readFileSync(join(HERE, rel), 'utf-8');
  expect(text.length, `${rel} read empty — pin would be vacuous`).toBeGreaterThan(0);
  return text;
};
const dockerfileSource = readFileSync(join(HERE, '../Dockerfile'), 'utf-8');
const composeSource = readFileSync(join(HERE, '../../docker-compose.yml'), 'utf-8');
const nginxSource = readFileSync(join(HERE, '../nginx.conf'), 'utf-8');
/**
 * The same file with its COMMENTS REMOVED.
 *
 * Round-1 review CONTROL C1: every pin below was a `.toContain()` over the
 * raw text, and `.toContain()` cannot tell a directive from a comment about
 * one. A mutant that commented out BOTH settings directives and added
 * `return 302 https://example.invalid/;` passed the entire pin — nginx would
 * have executed an off-origin redirect while the suite stayed green. A pin on
 * configuration has to read the configuration.
 */
const nginxDirectives = nginxSource.replace(/(^|\n)[^\S\n]*#[^\n]*/g, '$1');
/**
 * Every REDIRECT the served configuration can emit, as (kind, target).
 *
 * Round-2 review CONTROL C1-R2: the off-origin pin used to reject two
 * literal spellings, and `return 302 $scheme://example.invalid/;` passed
 * the whole file while nginx emitted an off-origin Location. Enumerating
 * the ways a target can LEAVE the origin is the wrong direction for a pin;
 * the targets are parsed and only one shape is admitted.
 */
const RETURN_REDIRECT = /\breturn\s+(?:30\d)\s+([^;\n]+);/g;
const REWRITE_REDIRECT = /\brewrite\s+\S+\s+([^;\n]+?)\s+(?:redirect|permanent)\s*;/g;
const personalitiesCss = readCss('./pages/PersonalitiesPage.css');
const personalityDetailCss = readCss('./pages/PersonalityDetailPage.css');
const principalsCss = readCss('./pages/PrincipalsPage.css');
const aboutCss = readCss('./pages/AboutPage.css');
const sidebarCss = readCss('./components/Sidebar.css');
const taskColumnCss = readCss('./components/tasks/TaskColumn.css');
import navigationSource from './config/navigation.ts?raw';
import loginSource from './pages/LoginPage.tsx?raw';
import wordmarkSource from './components/Wordmark.tsx?raw';
import buildSource from './utils/build.ts?raw';
import configContextSource from './contexts/RelayHallConfigContext.tsx?raw';
import tasksPageSource from './pages/TasksPage.tsx?raw';
import subtaskListSource from './components/tasks/SubtaskList.tsx?raw';
import statusSelectSource from './components/tasks/SubtaskStatusSelect.tsx?raw';
import taskDetailPageSource from './pages/TaskDetailPage.tsx?raw';
import taskCardSource from './components/tasks/TaskCard.tsx?raw';
import projectDetailSource from './components/projects/ProjectDetailModal.tsx?raw';
import lifecycleRequestSource from './utils/subtaskLifecycle.ts?raw';
import appSource from './App.tsx?raw';

// Every TS/TSX source in the tree, for repo-wide source-text ratchets.
const allSources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const indexCss = readCss('./index.css');
const fontsCss = readCss('./styles/fonts.css');
const variablesCss = readCss('./styles/variables.css');

describe('design-system hard rules (RH-DESIGN.6 §4.2, task ae0f3f5c)', () => {
  it('ships self-hosted Plex via tokens only', () => {
    expect(variablesCss).toContain("--font-body: 'IBM Plex Sans'");
    expect(variablesCss).toContain("--font-mono: 'IBM Plex Mono'");
    expect(indexCss).toContain('font-family: var(--font-body)');
    expect(indexCss).toContain('font-family: var(--font-mono)');
    const faces = fontsCss.match(/@font-face/g) || [];
    expect(faces.length).toBe(7);
    expect(fontsCss.match(/font-display: swap/g)?.length).toBe(7);
  });

  it('renders the skip link into a labelled main landmark', () => {
    expect(appSource).toContain('className="skip-link" href="#main-content"');
    expect(appSource).toContain('id="main-content"');
    expect(indexCss).toContain('.skip-link:focus-visible');
  });

  it('holds the inline-style colour ratchet (hex in TS/TSX only ever decreases)', () => {
    // RH-UI.1b end state: the only hex left in TS/TSX is the personality
    // data palette (types/personality.ts — named colour choices stored as
    // principal-facing data, applied via the --personality-color runtime
    // property). Everything else uses semantic tokens; raise is a defect.
    const FROZEN = 10;
    const hex = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
    let total = 0;
    for (const [path, source] of Object.entries(allSources)) {
      if (path.endsWith('acceptanceContracts.test.ts')) continue;
      total += (source.match(hex) || []).length;
    }
    expect(total, 'new colour literals in TS/TSX — use semantic tokens').toBeLessThanOrEqual(FROZEN);
  });

  it('declares a live Button.css rule for every emitted Button variant (review 2a83b89b F1)', () => {
    const buttonSource = allSources['./components/Button.tsx'];
    const buttonCss = readCss('./components/Button.css');
    expect(buttonSource).toContain('btn-${variant}');
    const variants = buttonSource.match(/variant\?: ([^;]+);/)?.[1] ?? '';
    const names = [...variants.matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const v of names) {
      expect(buttonCss, `Button variant "${v}" has no .btn-${v} declaration`).toMatch(
        new RegExp(`\\.btn-${v}\\b`));
    }
  });

  it('renders every contextual-scoping ancestor from the class-rename map (review d2ca332b F2)', () => {
    const map = JSON.parse(readFileSync(join(HERE, '../../scripts/class-rename-map.json'), 'utf-8'));
    const contextual = map.contextual ?? {};
    const allTsx = Object.values(allSources).join('\n');
    for (const [sheet, scoping] of Object.entries(contextual)) {
      for (const ancestor of new Set(Object.values(scoping as Record<string, string>))) {
        const cls = (ancestor as string).replace(/^\./, '');
        expect(allTsx, `contextual ancestor ${ancestor} (for ${sheet}) is rendered nowhere`).toContain(cls);
      }
    }
  });

  it('keeps the focus ring on the accent-derived token', () => {
    expect(variablesCss).toContain('--focus-ring: 0 0 0 3px var(--focus-ring-color)');
    expect(indexCss).not.toMatch(/rgba\(249,\s*115,\s*22/); // the old orange input ring
    expect(indexCss).not.toMatch(/rgba\(139,\s*92,\s*246/); // the old purple fallback
  });
});

describe('clean-install owner acceptance contracts', () => {
  it('brands the browser surface as RelayHall', () => {
    expect(indexHtml).toContain('<title>RelayHall</title>');
    expect(indexHtml).not.toContain('ClawBoard');
  });

  it('carries the RH-UI.3 icon set and the theme-variant hook', () => {
    // The retired marks are gone from the document as well as from disk — a
    // dangling <link> is how a deleted favicon keeps being requested.
    expect(indexHtml).not.toContain('nim-favicon');
    expect(indexHtml).not.toContain('favicon.png"');
    expect(indexHtml).toContain('href="/dashboard/favicon.svg" data-theme-variant');
    for (const size of ['16', '32', '64']) {
      expect(indexHtml).toContain(`href="/dashboard/favicon-${size}.png"`);
    }
    expect(indexHtml).toContain('rel="apple-touch-icon"');
    expect(indexHtml).toContain('<meta name="description"');
    // og:image needs an absolute public URL, and nothing of ours is public
    // until the c2885bbd gate. RH-PUB.B1 adds it there — not here.
    expect(indexHtml).toContain('property="og:title"');
    // Match the TAG, not the string: the document explains in a comment why the
    // tag is absent, and a pin that reads prose is a pin that reads nothing.
    expect(indexHtml).not.toMatch(/<meta[^>]+og:image/);
  });

  it('keeps product attribution fixed and out of configuration reach (§5.3)', () => {
    // Both attribution points render the component, never a config field. If
    // either ever interpolated an Appearance value, a deployment could dress
    // the product up as something else — the floor this pins.
    expect(loginSource).toContain('<Wordmark height={15} />');
    expect(loginSource).toMatch(/Powered by/);
    expect(sidebarSource).toContain('sidebar-product-line');
    expect(sidebarSource).toContain('<Wordmark height={13} mono quiet />');
    // The property is that the component cannot READ configuration, so pin its
    // imports rather than its prose — it explains this rule in a comment, and a
    // pin that matched the explanation would fire on the code being correct.
    expect(wordmarkSource).not.toMatch(/^import .*(RelayHallConfigContext|config\/relayhall)/m);

    // Public links ride the build flag and default to private, so a forgotten
    // build argument cannot publish a link ahead of the owner's gate.
    expect(buildSource).toContain("import.meta.env.VITE_PUBLIC_BUILD === 'true'");
    expect(loginSource).toContain('IS_PUBLIC_BUILD ?');
    expect(aboutSource).toContain('IS_PUBLIC_BUILD ?');
    expect(aboutSource).toContain('DOCS_URL');
    expect(aboutSource).toContain('PROBLEM_URL');
    expect(dockerfileSource).toContain('ARG VITE_PUBLIC_BUILD=false');
    expect(dockerfileSource).toContain('ENV VITE_PUBLIC_BUILD=$VITE_PUBLIC_BUILD');
    expect(composeSource).toContain('VITE_PUBLIC_BUILD: ${VITE_PUBLIC_BUILD:-false}');
    expect(nginxSource).toMatch(/location = \/release-manifest\.json[\s\S]*Cache-Control "no-store" always;[\s\S]*X-Content-Type-Options "nosniff" always;/);
  });

  it('cold-loads the documented root About route through the secured dashboard SPA', () => {
    // Comment-stripped for the reason C1 gives; this pin had the same hole.
    const rootAbout = nginxDirectives.match(/location = \/about \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    expect(rootAbout).not.toBe('');
    expect(rootAbout).toContain('absolute_redirect off;');
    expect(rootAbout).toContain('return 302 /dashboard/about;');
    expect(rootAbout).toContain('add_header Cache-Control "no-store" always;');
    expect(rootAbout).toContain('add_header Content-Security-Policy $relayhall_csp always;');
    expect(rootAbout).toContain('add_header X-Content-Type-Options "nosniff" always;');
    expect(appSource).toContain('<Route path="/about" element={<AboutPage />} />');
  });

  // Card c57a8fbf, narrowed by correction report 2daeee9c. The SPA is mounted
  // at Vite basename /dashboard/, so /dashboard/settings/* already answered
  // 200 cold and on refresh; what 404'd was the plausible root path a person
  // types from memory. The repair is the /about treatment, in two locations.
  //
  // This is NOT the route census the original card suggested and the
  // re-scoping WITHDREW: it pins the two blocks that exist and the one
  // try_files fallback that covers every client route, and it deliberately
  // does not enumerate client routes against nginx locations.
  it('cold-loads the root Settings prefix through the secured dashboard SPA', () => {
    const bare = nginxDirectives.match(/location = \/settings \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    const children = nginxDirectives.match(/location \/settings\/ \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    expect(bare, 'no exact /settings location').not.toBe('');
    expect(children, 'no /settings/ prefix location').not.toBe('');

    for (const [name, block] of [['/settings', bare], ['/settings/', children]] as const) {
      expect(block, `${name} emits an absolute redirect`).toContain('absolute_redirect off;');
      // The target carries the request URI, not a literal path: the Access
      // manager's deep link is ?approval=<id>, and a literal target would drop
      // exactly what the deep link exists to carry.
      expect(block, `${name} does not preserve the request URI`).toContain('return 302 /dashboard$request_uri;');
      expect(block).toContain('add_header Cache-Control "no-store" always;');
      expect(block).toContain('add_header Content-Security-Policy $relayhall_csp always;');
      expect(block).toContain('add_header X-Content-Type-Options "nosniff" always;');
    }

    // Each block returns EXACTLY ONE redirect, so a second `return` cannot be
    // added beside the pinned one and win by being later (C1's mutant).
    for (const [name, block] of [['/settings', bare], ['/settings/', children]] as const) {
      expect(block.match(/^\s*return\s/gm)?.length, `${name} has more than one return`).toBe(1);
    }

    // And NOWHERE in the served configuration does a redirect leave this
    // origin. Round-2 review CONTROL C1-R2: this used to reject two literal
    // spellings — a lower-case scheme and a protocol-relative `//` — and
    // `return 302 $scheme://example.invalid/;` in the root block passed the
    // whole file while nginx emitted an off-origin Location. Enumerating the
    // ways a target can leave the origin is the wrong direction for a pin.
    // Every redirect TARGET in the file is read instead, and only one shape
    // is admitted: an origin-relative path, which may carry nginx variables
    // AFTER the leading slash but cannot begin with one.
    const redirectTargets = [
      // `return 30x <target>;`
      ...[...nginxDirectives.matchAll(RETURN_REDIRECT)]
        .map(match => ['return', match[1].trim()] as const),
      // `rewrite <regex> <target> (redirect|permanent);` is a redirect too,
      // and a pin that only reads `return` would not see one arrive.
      ...[...nginxDirectives.matchAll(REWRITE_REDIRECT)]
        .map(match => ['rewrite', match[1].trim()] as const),
    ];
    // A pin over an empty set passes for the wrong reason.
    expect(redirectTargets.length, 'no redirect targets parsed — the pin would be vacuous')
      .toBeGreaterThanOrEqual(3);
    for (const [kind, raw] of redirectTargets) {
      const target = raw.replace(/^(["'])([\s\S]*)\1$/, '$2');
      expect(target.startsWith('/'), `${kind} target ${raw} is not an origin-relative path`).toBe(true);
      expect(target.startsWith('//'), `${kind} target ${raw} is protocol-relative`).toBe(false);
      expect(/:\/\//.test(target), `${kind} target ${raw} carries a scheme`).toBe(false);
    }

    // A prefix location, never a regex: a regex location would also match
    // /settingsomething and would change how the whole server block matches.
    expect(nginxDirectives).not.toMatch(/location\s+~\*?\s+[^\n]*settings/);

    // The redirect has to land on a client route that exists. The shell and
    // its index redirect are what /dashboard/settings resolves to.
    expect(appSource).toContain('<Route path="/settings" element={<SettingsPage />}>');
    expect(appSource).toContain('<Route index element={<SettingsIndexRedirect />} />');

    // And the one fallback that makes every child of it resolve. This is the
    // invariant the re-scoped card names as correct, in place of a census.
    expect(nginxDirectives).toMatch(/location \/dashboard\/ \{[\s\S]*?try_files \$uri \$uri\/ \/dashboard\/index\.html;/);
  });

  it('keeps a 44px hamburger target clear of About content at phone and tablet widths', () => {
    const hamburgerRule = sidebarCss.match(/\.sidebar-hamburger\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(hamburgerRule, 'sidebar hamburger rule missing').not.toBe('');
    const targetWidth = Number(hamburgerRule.match(/\bwidth:\s*(\d+)px;/)?.[1]);
    const targetHeight = Number(hamburgerRule.match(/\bheight:\s*(\d+)px;/)?.[1]);
    const targetLeft = Number(hamburgerRule.match(/\bleft:\s*(\d+)px;/)?.[1]);
    const targetTop = Number(hamburgerRule.match(/\btop:\s*(\d+)px;/)?.[1]);
    expect(targetWidth).toBeGreaterThanOrEqual(44);
    expect(targetHeight).toBeGreaterThanOrEqual(44);

    const breakpoint = aboutCss.match(/@media \(max-width: 1279px\) \{[\s\S]*?\.about-page__header \{[\s\S]*?padding-top: (\d+)px;/);
    expect(breakpoint, 'About header has no hamburger-breakpoint clearance').not.toBeNull();
    const headerClearance = Number(breakpoint?.[1]);
    const hamburger = {
      left: targetLeft,
      top: targetTop,
      right: targetLeft + targetWidth,
      bottom: targetTop + targetHeight,
    };

    // Bind the real responsive insets at the audited phone and tablet widths.
    // The heading/card flow begins below the header; vertical clearance also
    // prevents the 44px fixed target from overlapping the title at either size.
    const geometry = [
      { width: 390, contentLeft: 12 + 16, headingTop: 12 + 16 + headerClearance },
      { width: 1024, contentLeft: 16 + 32, headingTop: 16 + 32 + headerClearance },
    ];
    expect(geometry).toEqual([
      { width: 390, contentLeft: 28, headingTop: 88 },
      { width: 1024, contentLeft: 48, headingTop: 108 },
    ]);
    expect(hamburger).toEqual({ left: 14, top: 14, right: 58, bottom: 58 });
    for (const { headingTop } of geometry) {
      expect(headingTop).toBeGreaterThanOrEqual(hamburger.bottom + 16);
    }
  });

  it('pins mobile sidebar disclosure and focus-exclusion semantics', () => {
    expect(sidebarSource).toContain('aria-expanded={mobileOpen}');
    expect(sidebarSource).toContain('aria-controls="sidebar-navigation"');
    expect(sidebarSource).toContain('id="sidebar-navigation"');
    expect(sidebarSource).toContain("const inertWhenClosed = mobileClosed ? { inert: '' } : {};");
    expect(sidebarSource).toContain('aria-hidden={mobileClosed || undefined}');
    expect(sidebarSource).toContain("event.key !== 'Escape'");
    expect(sidebarSource).toContain('menuButtonRef.current?.focus()');
  });

  it('keeps sidebar utility links and product identity inside one named landmark', () => {
    expect(sidebarSource).toContain('<aside');
    expect(sidebarSource).toContain('aria-label="Application sidebar"');
    expect(sidebarSource.match(/aria-label="Application sidebar"/g)).toHaveLength(1);
    expect(sidebarSource).toContain('<nav aria-label="Main navigation">');
  });

  it('keeps mobile Tasks actions explicitly named when their visible text is hidden', () => {
    expect(tasksPageSource).toContain('ariaLabel="Show archived"');
    expect(tasksPageSource).toContain('ariaPressed={showArchived}');
    expect(tasksPageSource).toContain('ariaLabel="Archive completed"');
    expect(tasksPageSource).toContain('ariaLabel="Create new task"');
    expect(allSources['./components/Button.tsx']).toContain('aria-label={ariaLabel}');
  });

  it('keeps task columns structurally valid, heading-nested, and contrast-safe', () => {
    expect(taskColumnSource).toContain('role="group"');
    expect(taskColumnSource).not.toContain('role="list"');
    expect(taskColumnSource).toContain('<h2>{title}</h2>');
    expect(taskColumnCss).toMatch(/\.task-column-title h2\s*\{[^}]*font:\s*inherit;/s);
    expect(taskColumnCss).toMatch(/\.task-column-empty-hint\s*\{[^}]*color:\s*var\(--text-secondary\)/s);
    expect(taskColumnCss).not.toMatch(/\.task-column-empty-hint\s*\{[^}]*var\(--text-quaternary\)/s);
    expect(taskCardSource).toContain('<article');
    // C2 (3cdf6e65 §2.1/§2.2, reviewed pin update): drag moved from the
    // article to the left-edge grip handle; the article carries neither a
    // role nor draggable; native drag is gated off coarse pointers.
    expect(taskCardSource).not.toContain('draggable={!disableDrag}');
    expect(taskCardSource).toContain('draggable={dragEnabled}');
    expect(taskCardSource).toContain("window.matchMedia('(pointer: coarse)')");
    expect(taskCardSource).toContain('className="task-card-drag-handle"');
    expect(taskCardSource).toContain('aria-label={`Move task: ${task.title}`}');
    expect(taskCardSource).toContain('aria-label={`Open task: ${task.title}`}');
    expect(taskCardSource).not.toContain('role="button"');
    expect(taskCardSource).not.toContain('tabIndex={0}');
    // the retired emoji flag must not return (9f01ba4b D20)
    // (reviewed fix for a vacuous lookup: allSources globs only ts/tsx, so
    // the CSS must be read directly)
    const taskCardCssRaw = readFileSync(join(HERE, 'components/tasks/TaskCard.css'), 'utf-8');
    expect(taskCardCssRaw).not.toContain('\u{1F534}');
  });

  it('leaves the icon links to the theme engine (§7: external asset URLs retire)', () => {
    // The deployment config used to reach into document.head and overwrite
    // link[rel="icon"] with branding.faviconUrl — a root-absolute default that
    // 404s under the /dashboard/ base and discarded the Theme's own mark.
    // RH-UI.4 deletes the field; until then it must not touch the document.
    expect(configContextSource).not.toMatch(/rel="icon"|rel = 'icon'|newIconLink/);
    expect(configContextSource).not.toMatch(/\.href\s*=\s*fetchedConfig\.branding\.faviconUrl/);
  });

  it('does not expose a PROD/DEV environment selector', () => {
    expect(sidebarSource).not.toMatch(/dashboard-dev|Pick the dashboard target|>PROD<|>DEV</);
  });

  it('presents personalities as optional and board-managed, with no repository-import surface', () => {
    // Re-pinned 2026-08-09 (owner ruling): the repository sync was removed.
    // Personalities are board-native — the page must offer creation and must
    // NOT offer any repository import.
    expect(createTaskSource).toContain('Personality (optional)');
    expect(personalitiesSource).toContain('<h1>Personalities</h1>');
    expect(personalitiesSource).toContain('New personality');
    expect(personalitiesSource).not.toContain('Import repository');
    expect(personalitiesSource).not.toContain('/personalities/sync');
  });

  it('uses owner-facing task and personality terminology in navigation', () => {
    expect(navigationSource).toContain("label: 'Tasks'");
    expect(navigationSource).toContain("label: 'Personalities'");
    expect(navigationSource).not.toContain("label: 'Work items'");
    expect(navigationSource).not.toContain("label: 'Agent Types'");
  });

  it('keeps the Principals and Personalities registries on the shared design system (P1.5c)', () => {
    // Page-level actions use the shared Button; forms use the shared classes.
    for (const source of [personalitiesSource, personalityDetailSource, principalsSource]) {
      expect(source).toContain("from '../components/Button'");
    }
    for (const source of [personalitiesSource, personalityDetailSource]) {
      expect(source).toContain('className="form-');
    }
    // The Principals page no longer HOLDS a form: card `5592baf6` replaced the
    // four-field "New principal" editor with the one Create identity wizard, so
    // the contract follows the fields to the component that now owns them.
    expect(principalsSource).toContain('<CreateIdentityWizard');
    expect(principalsSource).not.toContain('className="form-');
    expect(createIdentityWizardSource).toContain("from '../Button'");
    expect(createIdentityWizardSource).toContain('className="form-');
    // The dashboard is mounted under a basename ('/dashboard/' in production),
    // so a root-absolute <a href="/settings/..."> 404s in every deployment that
    // is not served from the site root. Both surfaces link onward with the
    // router instead, and this is the guard that keeps it that way.
    for (const source of [principalsSource, createIdentityWizardSource]) {
      expect(source).not.toMatch(/<a\s[^>]*href="\//);
      expect(source).toContain("from 'react-router-dom'");
    }
    // The dark-mode regression: these tokens are not defined anywhere in the
    // design system, so an unfallbacked var() renders the surface transparent.
    // (scripts/check-design-tokens.py now enforces this repo-wide; this block
    // stays as the page-level P1.5c contract.)
    for (const css of [personalitiesCss, personalityDetailCss, principalsCss]) {
      expect(css).not.toContain('var(--bg-secondary');
      expect(css).not.toContain('var(--bg-primary');
      expect(css).not.toContain('var(--border-primary');
      expect(css).not.toContain('var(--color-primary');
      expect(css).not.toContain('var(--bg-hover');
    }
    // No classless <button> may remain on these pages — the global padding
    // reset renders one as a raw zero-padding UA control on a dark page.
    for (const source of [personalitiesSource, personalityDetailSource, principalsSource]) {
      const buttonTags = source.match(/<button\b[\s\S]*?>/g) || [];
      for (const tag of buttonTags) {
        expect(tag, `classless <button> found: ${tag}`).toContain('className=');
      }
    }
    // The pre-VOCAB.1 CSS namespace is gone from the registry pages.
    for (const css of [personalitiesCss, personalityDetailCss]) {
      expect(css).not.toMatch(/\.agent-/);
    }
    // The server's protected-principal rules stay mirrored, not replaced.
    expect(principalsSource).toContain('PROTECTED_HANDLES');
    expect(principalsSource).toContain("me?.id !== p.id");
  });

  it('shows explicit Review and Stuck columns with the canonical subtask labels', () => {
    expect(tasksPageSource).toContain("const COLUMNS: ColumnKey[] = ['ideas', 'todo', 'in-progress', 'review', 'stuck', 'completed', 'archived']");
    expect(tasksPageSource).toContain("ideas: 'Ideas'");
    expect(tasksPageSource).toContain("review: 'Review'");
    expect(tasksPageSource).toContain("stuck: 'Stuck'");
    expect(tasksPageSource).not.toContain('Ideas / Plans');
    expect(tasksPageSource).not.toContain('Stuck / Review');
    for (const label of ['Not started', 'In progress', 'To be reviewed', 'Completed', 'Stuck', 'Skipped']) {
      expect(statusSelectSource).toContain(label);
    }
    expect(subtaskListSource).toContain('SubtaskStatusSelect');
    expect(subtaskListSource).toContain('Review note:');
    expect(subtaskListSource).toContain('Stuck reason:');
    expect(createTaskSource).not.toContain('<SubtaskStatusSelect');
    expect(createTaskSource).toContain("status: 'empty' as const");
    expect(taskDetailPageSource).toContain('<SubtaskList');
    expect(taskDetailPageSource).toContain('/subtasks/by-id/${encodeURIComponent(subtaskId)}/status');
    expect(tasksPageSource).toContain('buildSubtaskLifecycleRequest');
    for (const endpoint of ['/approve', '/reject', '/skip', '/status']) {
      expect(lifecycleRequestSource).toContain(endpoint);
    }
    for (const source of [createTaskSource, taskDetailPageSource, subtaskListSource]) {
      expect(source).not.toMatch(/tri-state|click to cycle/i);
    }
    expect(tasksPageSource).not.toContain("target.status === 'review' ? 'stuck'");

    // F4 (review 66c78a1d): board-native Model/Thinking are the BASIC path
    // only — every task surface gates them on the absence of a connector
    // profile, and connector saves clear the board-native fields so a task
    // never carries two execution sources of truth.
    expect(createTaskSource).toContain("!executionProfile?.serviceId && (");
    expect(createTaskSource).toContain("executionProfile?.serviceId ? undefined : (model || undefined)");
    expect(taskDetailPageSource).toContain('<ExecutionProfileEditor');
    expect(taskDetailPageSource).toContain('legacyExecutionProfile');
    // Unarchive now goes through the server-derived prior-state endpoint
    // (design 986be411 §4, owner ruling E5 — resolves 7092b73d): the old
    // restore-to-todo write is retired.
    expect(tasksPageSource).toContain("/unarchive`, { method: 'POST' }");
    expect(tasksPageSource).not.toContain("handleUpdateTask(taskId, { status: 'todo'");
  });

  it('retires Task detail modals and routes every task opener to the canonical page (C3 §3.7)', () => {
    expect(allSources['./components/tasks/TaskDetailModal.tsx']).toBeUndefined();
    expect(allSources['./components/tasks/EditTaskModal.tsx']).toBeUndefined();
    expect(taskCardSource).not.toContain('TaskDetailModal');
    expect(taskCardSource).toContain('navigate(`/tasks/${task.id}`)');
    expect(projectDetailSource).not.toContain('TaskDetailModal');
    expect(projectDetailSource).toContain('navigate(`/tasks/${task.id}`)');
    expect(createTaskSource).toContain("import './TaskCreatePage.css'");
    expect(createTaskSource).not.toContain('EditTaskModal.css');
  });

});
