// @vitest-environment jsdom
/**
 * Transitive control-kit consumption (task `482e21fa`, design `77950a97` §7).
 *
 * ROUND 2, rewritten against review `af33fd17` finding B2. The first version
 * claimed to prove "rendered consumption" and then asserted on source text:
 *
 *     const source = read(file);
 *     expect(/<(Button|IconButton|Select)[\s>]/.test(source)).toBe(true);
 *
 * The reviewer falsified it directly — they stripped the visible label off an
 * already-converted control, leaving an `aria-hidden` icon and therefore no
 * accessible name, and the suite still passed 29/29. A test that cannot tell a
 * good conversion from a broken one is the same import-smoke weakness this task
 * exists to remove, with more ceremony.
 *
 * So every converted surface below is RENDERED, and each rendered host control
 * is asserted to (a) wear a kit class and (b) have a non-empty accessible name.
 * The name assertion is the one that bites: it is what the reviewer's hostile
 * edit broke and the old suite missed.
 *
 * The source-text census survives as a SEPARATE structural ratchet — useful for
 * catching a newly hand-rolled control, never presented as rendered proof.
 */
import { render, cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Button } from './components/Button';
import { IconButton } from './components/ui/IconButton';
import { Select } from './components/ui/Select';
import { ConfirmationModal } from './components/ConfirmationModal';
import { SubtaskStatusSelect } from './components/tasks/SubtaskStatusSelect';
import { SubtaskList } from './components/tasks/SubtaskList';
import { TaskResourcesSection } from './components/tasks/TaskResourcesSection';
import { FilterBar } from './components/tasks/FilterBar';
import ExecutionProfileEditor from './components/tasks/ExecutionProfileEditor';
import { ContextPreview } from './components/projects/ContextPreview';

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

vi.mock('./utils/auth', () => ({
  authenticatedFetch: vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ resources: [], connectors: [], context: null }),
  })),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

const KIT_CLASSES = ['btn', 'icon-btn', 'form-select'];

/**
 * The surfaces this suite promises to RENDER. Review 6005fc4a B2 showed that
 * deleting a probe entirely went unnoticed, so the promise is pinned: each
 * surface registers itself as it runs and the final check compares the set.
 */
const RENDERED_SURFACES = [
  'ConfirmationModal',
  'ConfirmationModal(danger)',
  'SubtaskStatusSelect',
  'SubtaskList',
  'TaskResourcesSection',
  'ExecutionProfileEditor',
  'ContextPreview',
  'FilterBar',
] as const;

const rendered = new Set<string>();

/**
 * Does the standards computation find a non-empty accessible name?
 *
 * The oracle is Testing Library's own `toHaveAccessibleName` matcher, not
 * anything written here. Round 2 hand-rolled the computation and review
 * 6005fc4a B2 proved the approximation wrong: it stripped only
 * `[aria-hidden="true"]`, so a label inside `<span hidden>` still counted as a
 * name while the standards matcher found the control nameless. Never
 * approximate an oracle you can borrow.
 */
function hasAccessibleName(el: Element): boolean {
  try {
    expect(el).toHaveAccessibleName();
    return true;
  } catch {
    return false;
  }
}

/**
 * Every rendered control in `root` is a kit control with an accessible name.
 * `allowRaw` lists selectors for controls the exception register covers.
 */
function expectKitControls(root: ParentNode, label: string, allowRaw: string[] = []) {
  rendered.add(label);
  const controls = Array.from(root.querySelectorAll('button, select'));
  expect(controls.length, `${label} rendered no controls at all — the probe is not exercising it`).toBeGreaterThan(0);

  for (const el of controls) {
    if (allowRaw.some(sel => el.matches(sel))) continue;
    const wearing = KIT_CLASSES.some(c => el.classList.contains(c));
    expect(wearing, `${label}: <${el.tagName.toLowerCase()} class="${el.className}"> is not a kit control`).toBe(true);
    expect(
      hasAccessibleName(el),
      `${label}: kit control <${el.tagName.toLowerCase()} class="${el.className}"> has NO accessible name`
    ).toBe(true);
  }
}

describe('the kit itself renders what the surfaces are asserted against', () => {
  test('Button renders .btn with variant and compact size', () => {
    const { container } = render(<Button variant="primary" size="compact">Go</Button>);
    expect(container.querySelector('button')).toHaveClass('btn', 'btn-primary', 'btn-compact');
  });

  test('Button carries disclosure state as aria-expanded, never aria-pressed', () => {
    const { container } = render(<Button ariaExpanded ariaControls="panel-1">Reveal</Button>);
    const button = container.querySelector('button')!;
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', 'panel-1');
    expect(button).not.toHaveAttribute('aria-pressed');
  });

  test('Button forwards the click event so nested controls can stop propagation', () => {
    const onClick = vi.fn();
    const { container } = render(<Button onClick={onClick}>Nested</Button>);
    container.querySelector('button')!.click();
    expect(typeof onClick.mock.calls[0][0].stopPropagation).toBe('function');
  });

  test('IconButton renders .icon-btn, keeps its name, and carries aria-controls', () => {
    const { container } = render(
      <IconButton ariaLabel="Close" ariaControls="region-1" ariaExpanded={false} icon={<svg />} />
    );
    const button = container.querySelector('button')!;
    expect(button).toHaveClass('icon-btn');
    expect(button).toHaveAccessibleName('Close');
    expect(button).toHaveAttribute('aria-controls', 'region-1');
  });

  test('Select renders a native select wearing .form-select', () => {
    const { container } = render(<Select aria-label="Pick"><option value="a">A</option></Select>);
    expect(container.querySelector('select')).toHaveClass('form-select');
  });
});

describe('the accessible-name check bites (the assertion review af33fd17 proved was missing)', () => {
  test('a kit control whose only content is aria-hidden has NO accessible name', () => {
    // Exactly the shape the reviewer used to falsify round 1: kit classes
    // present, label gone, icon hidden from the accessibility tree.
    const { container } = render(
      <button className="btn btn-secondary">
        <span className="btn-icon"><svg aria-hidden="true" /></span>
        <span className="btn-text" />
      </button>
    );
    expect(hasAccessibleName(container.querySelector('button')!)).toBe(false);
    expect(() => expectKitControls(container, 'hostile fixture')).toThrow(/NO accessible name/);
  });

  test('a kit control whose label is in a hidden subtree has NO accessible name', () => {
    // Review 6005fc4a B2's second falsification: `hidden`, not `aria-hidden`.
    // The round-2 helper counted this text and passed the control; the
    // standards computation does not.
    const { container } = render(
      <button className="btn btn-secondary">
        <span className="btn-icon"><svg aria-hidden="true" /></span>
        <span hidden className="btn-text">Cancel</span>
      </button>
    );
    expect(hasAccessibleName(container.querySelector('button')!)).toBe(false);
    expect(() => expectKitControls(container, 'hostile fixture')).toThrow(/NO accessible name/);
  });

  test('a raw control on a surface with no exception fails the same check', () => {
    const { container } = render(<div><button>Raw</button></div>);
    expect(() => expectKitControls(container, 'hostile fixture')).toThrow(/is not a kit control/);
  });
});

describe('converted surfaces render kit controls with accessible names', () => {
  test('ConfirmationModal', () => {
    render(
      <ConfirmationModal title="Archive this?" message="It leaves the board." onConfirm={() => {}} onCancel={() => {}} />
    );
    expectKitControls(document.querySelector('.confirmation-modal')!, 'ConfirmationModal');
    expect(document.querySelector('.modal-close')).toHaveAccessibleName('Close');
  });

  test('ConfirmationModal danger uses the kit danger variant', () => {
    render(
      <ConfirmationModal title="Delete" message="Permanent." danger onConfirm={() => {}} onCancel={() => {}} />
    );
    expect(document.querySelector('.btn-confirm')).toHaveClass('btn', 'btn-danger');
    expectKitControls(document.querySelector('.confirmation-modal')!, 'ConfirmationModal(danger)');
  });

  test('SubtaskStatusSelect', () => {
    const { container } = render(
      <SubtaskStatusSelect value="empty" onChange={() => {}} subtaskText="Write the brief" />
    );
    expectKitControls(container, 'SubtaskStatusSelect');
    expect(container.querySelector('select')).toHaveClass('form-select', 'subtask-status-select');
  });

  test('SubtaskList row actions', () => {
    const { container } = render(
      <SubtaskList
        subtasks={[
          { id: 's1', text: 'First', status: 'empty' } as never,
          { id: 's2', text: 'Second', status: 'empty' } as never,
        ]}
        onEditText={() => {}}
        onReorder={() => {}}
      />
    );
    expectKitControls(container, 'SubtaskList');
    // The row actions are named, not just icons.
    expect(screen.getAllByRole('button', { name: 'Edit subtask' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Move up' }).length).toBeGreaterThan(0);
  });

  test('TaskResourcesSection related-task control', () => {
    const { container } = render(
      <TaskResourcesSection
        resources={{ links: [], files: [], relatedTasks: ['abcdef1234567890'] } as never}
        onRelatedTaskClick={() => {}}
      />
    );
    expectKitControls(container, 'TaskResourcesSection');
  });

  test('ExecutionProfileEditor selects', () => {
    const { container } = render(<ExecutionProfileEditor value={null} onChange={() => {}} />);
    expectKitControls(container, 'ExecutionProfileEditor');
  });

  test('ContextPreview action controls', () => {
    const { container } = render(<ContextPreview projectId="p1" />);
    expectKitControls(container, 'ContextPreview');
  });

  test('FilterBar: converted controls are kit, the dropdown triggers are the registered exception', () => {
    const { container } = render(
      <FilterBar
        tasks={[]}
        filters={{
          searchQuery: 'x',
          priorities: [],
          tags: ['alpha'],
          projects: [],
          phases: [],
          statuses: [],
          mine: false,
        }}
        onFiltersChange={() => {}}
        availableTags={['alpha', 'beta']}
        availableProjects={['P']}
        availableOwners={['handle']}
        canFilterMine
      />
    );
    // The five dropdown triggers own popup state and stay raw by register.
    expectKitControls(container, 'FilterBar', [
      '.filter-dropdown-trigger',
      '[class*="filter-"][class*="-dropdown"] > button',
      '.filter-bar-filter-group > button',
    ]);
  });
});

/**
 * Raw controls that are NOT defects, with the behaviour or ARIA pattern the kit
 * cannot express. Review af33fd17 rejected round 1 for entries whose real
 * reason was visual ("sized to the row", "a kit button would be 36px"). Those
 * controls are now converted; what remains is roles, refs and roving tabindex.
 */
const EXCEPTIONS: Record<string, { count: number; why: string }> = {
  'pages/TasksPage.tsx': {
    count: 4,
    why: 'two APG menu entries (role=menuitem, role=menuitemcheckbox), the mobile column tab strip, and the search toggle that owns a ref for focus return',
  },
  'pages/TaskDetailPage.tsx': {
    count: 4,
    why: 'three role=menuitem entries and the Timeline toggle which needs a forwarded ref for focus return; stacked-region navigation uses native destination links',
  },
  'components/tasks/TaskCard.tsx': {
    count: 6,
    why: 'three structural controls (the opener and drag handle are ref-managed under the board roving-tabindex contract and carry the data-task-id/onFocus hooks the routed return depends on) plus THREE CHIPS — project badge, tag, session link — which OWNER RULING de70a6dd R7 exempts from the two-size rule by declared amendment 7-A1 on design 77950a97. That is a contract amendment, not the visual excuse review af33fd17 B1 rejected',
  },
  'components/tasks/TaskCardMoveMenu.tsx': {
    count: 1,
    why: 'role=menuitem with roving tabIndex inside the board move menu',
  },
  'components/tasks/FilterBar.tsx': { count: 0, why: 'fully converted' },
  'components/projects/ProjectResourcesEditModal.tsx': { count: 0, why: 'fully converted' },
  'components/projects/ProjectResources.tsx': { count: 0, why: 'fully converted' },
  'components/projects/ProjectDetailModal.tsx': { count: 0, why: 'fully converted' },
  'components/projects/ContextPreview.tsx': { count: 0, why: 'fully converted' },
  'components/tasks/TaskTimeline.tsx': { count: 0, why: 'fully converted' },
  'components/tasks/TaskColumn.tsx': { count: 0, why: 'fully converted' },
  'components/tasks/SubtaskList.tsx': { count: 0, why: 'fully converted' },
  'components/tasks/taskFieldEditors.tsx': { count: 0, why: 'fully converted' },
  'components/tasks/TaskResourcesSection.tsx': { count: 0, why: 'fully converted' },
  'components/tasks/SubtaskStatusSelect.tsx': { count: 0, why: 'fully converted' },
  'components/tasks/ExecutionProfileEditor.tsx': { count: 0, why: 'fully converted' },
  'components/skills/SkillDetailModal.tsx': { count: 0, why: 'fully converted' },
  'components/ConfirmationModal.tsx': { count: 0, why: 'fully converted' },
  'components/map/MapView.tsx': { count: 0, why: 'fully converted' },
  'pages/TaskCreatePage.tsx': { count: 0, why: 'fully converted' },
};

describe('structural ratchet: the raw-control census (NOT the rendered proof)', () => {
  const RAW = /<(button|select)[\s>]/g;

  for (const [file, { count, why }] of Object.entries(EXCEPTIONS)) {
    test(`${file}: ${count} raw — ${count ? why : 'no exceptions'}`, () => {
      const found = read(file).match(RAW) ?? [];
      expect(
        found.length,
        `${file} has ${found.length} raw <button>/<select>, the register allows ${count}. ` +
        `Route it through the kit, or add it to EXCEPTIONS with the behaviour or ARIA ` +
        `pattern the kit cannot express — visual size is NOT such a reason (review af33fd17 B1).`
      ).toBe(count);
    });
  }
});

describe('the rendered-surface promise is kept', () => {
  test('every surface named in RENDERED_SURFACES was actually rendered and checked', () => {
    // Deleting a probe above now fails here rather than quietly shrinking the
    // suite (review 6005fc4a B2, third falsification).
    const missing = RENDERED_SURFACES.filter(name => !rendered.has(name));
    expect(
      missing,
      `these surfaces are promised but no rendered check ran for them: ${missing.join(', ')}`
    ).toEqual([]);
  });
});
