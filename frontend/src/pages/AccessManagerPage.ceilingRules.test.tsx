// @vitest-environment jsdom
/**
 * The warrant form's CEILING-RULES field (card 785e1eed, lane P2-F; owner
 * rulings E17 Q5(d) and E48).
 *
 * `POST /warrants` already accepts `ceilingRules` and publishes them as the
 * warrant's own Access profile; what the form lacked was a way to enter them.
 * These tests render the REAL page and drive it the way the owner will at the
 * sitting: open New warrant, paste the packet's rules or type them, step up,
 * and read what left the page. What they pin:
 *  - rows are added and removed, one per resource type, and rows kept
 *    through Close form never share a key or a DOM id with a new one;
 *  - "Paste rules JSON" fills the rows from the packet, all or nothing;
 *  - the profile selector and the rules exclude each other, and with neither
 *    the selector is required exactly as before;
 *  - the request body carries `ceilingRules` exactly as entered, and never a
 *    profile beside them;
 *  - a rule the server's `validateRules` would refuse is refused here, before
 *    the step-up token is spent;
 *  - a server refusal renders verbatim inside the form;
 *  - a warrant's details list the rules its pinned version carries, chosen by
 *    the pinned version id and never by "the latest".
 *
 * Every id below is synthetic. The packet's SHAPE is the one the AUTHZ draft
 * prints (task and phase `all-in-project`, report `all-of-type` with no ids).
 */
import '@testing-library/jest-dom/vitest';
import axe from 'axe-core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
const routes = new Map<string, unknown>();
/** What `POST /warrants` answers; GET /warrants is a route like any other. */
let createAnswer: { status: number; body: unknown } = { status: 201, body: { success: true, warrant: {} } };
vi.mock('../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, options?: RequestInit) => {
    fetchCalls.push({ url, options });
    if (options?.method === 'POST' && url.endsWith('/warrants')) {
      const { status, body } = createAnswer;
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    }
    // The URL's ENDING decides, then length - the sibling suites' matcher.
    const match = [...routes.entries()].filter(([suffix]) => url.endsWith(suffix))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (match) {
      if (match[1] instanceof Promise) return match[1] as never;
      return { ok: true, status: 200, json: async () => match[1] };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

import { AccessManagerPage } from './AccessManagerPage';

// These tests drive a whole page through a step-up dialog. On a build host at
// load average ~35, two of them failed once and passed on every rerun; the
// message was not kept, and the default 5 s budget is the likeliest cause, so
// this file (and only this file) gets a wider one.
vi.setConfig({ testTimeout: 20_000 });

const HOLDER = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
const PROJECT = '12345678-1234-4abc-8def-123456789abc';
const PHASE = '87654321-4321-4cba-8fed-cba987654321';
const PROFILE = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';

/** The packet's three rules, in the packet's order and spelling. */
const PACKET = [
  { resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [PROJECT], verbs: ['read', 'write'] },
  { resourceType: 'phase', selectorForm: 'all-in-project', selectorIds: [PROJECT], verbs: ['read'] },
  { resourceType: 'report', selectorForm: 'all-of-type', verbs: ['read'] },
];

function seed() {
  routes.clear();
  fetchCalls.length = 0;
  createAnswer = { status: 201, body: { success: true, warrant: {} } };
  useMyPrincipal.mockReturnValue({ me: { id: 'p-root', role: 'admin' }, scopes: ['root'], loading: false });
  usePrincipals.mockReturnValue({
    principals: [{ id: HOLDER, handle: 'connector-main', displayName: 'Main connector', kind: 'service', status: 'active' }],
  });
  routes.set('/warrants', { success: true, warrants: [] });
  routes.set('/access-profiles', {
    success: true,
    profiles: [{ id: PROFILE, name: 'Reporter', publishedVersionNumber: 3 }],
  });
  routes.set('/auth/step-up', { success: true, stepUpToken: 'rhsu_test_token' });
}

beforeEach(seed);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function openForm() {
  render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'New warrant' }));
  return within(screen.getByRole('form', { name: 'Create a warrant' }));
}

/** The rule rows, in order, each scoped to its own group. */
function ruleGroups(form: ReturnType<typeof within>) {
  return form.queryAllByRole('group', { name: /^Rule \d+$/ }).map((group: HTMLElement) => within(group));
}

/** Text fields this file does not test keystroke by keystroke are PASTED:
 * the same value reaches React's onChange in one event, not forty. */
async function enter(field: HTMLElement, text: string) {
  await userEvent.click(field);
  await userEvent.paste(text);
}

async function pasteRules(form: ReturnType<typeof within>, text: string) {
  await userEvent.click(form.getByRole('button', { name: 'Paste rules JSON' }));
  const box = form.getByLabelText(/^Rules JSON/);
  await userEvent.click(box);
  await userEvent.paste(text);
  await userEvent.click(form.getByRole('button', { name: 'Fill rows from JSON' }));
}

/** The sitting's other fields: a phase anchor, which requires an expiry. */
async function fillTheRest(form: ReturnType<typeof within>) {
  await enter(form.getByLabelText('Name'), 'Main phase 10');
  await userEvent.selectOptions(form.getByLabelText('Holder (connector or service account)'), HOLDER);
  await userEvent.selectOptions(form.getByLabelText('Anchor'), 'phase');
  await enter(form.getByLabelText('Anchor id'), PHASE);
  fireEvent.change(form.getByLabelText(/^Expiry/), { target: { value: '2026-11-09T12:00' } });
  await enter(form.getByLabelText(/^Scope ceiling/), 'tasks:read, reports:read');
  await enter(form.getByLabelText(/^Max concurrent/), '3');
}

async function stepUp() {
  const dialog = within(await screen.findByRole('dialog'));
  await userEvent.type(dialog.getByLabelText('Password'), 'hunter2');
  await userEvent.click(dialog.getByRole('button', { name: 'Continue' }));
}

const createCalls = () => fetchCalls.filter((call) => call.options?.method === 'POST' && call.url.endsWith('/warrants'));

/** Every id the rules field renders is unique, and every label in a rule
 * names a control inside that same rule. */
function expectRuleIdsUniqueAndOwned(form: ReturnType<typeof within>) {
  const ids = [...document.querySelectorAll('[id^="axm-w-rules-"]')].map((node) => node.id);
  expect(ids.filter((id, at) => ids.indexOf(id) !== at)).toEqual([]);
  form.queryAllByRole('group', { name: /^Rule \d+$/ }).forEach((group: HTMLElement) => {
    group.querySelectorAll('label[for]').forEach((label) => {
      const target = document.getElementById((label as HTMLLabelElement).htmlFor);
      expect(target, `label "${label.textContent}" in ${group.getAttribute('aria-label')}`).not.toBeNull();
      expect(group.contains(target)).toBe(true);
    });
  });
}

/** The rules as the form SHOWS them, read off the rendered controls in the
 * request body's spelling; verbs in the editor's checkbox order. */
function shownRules(form: ReturnType<typeof within>) {
  return ruleGroups(form).map((group: ReturnType<typeof within>) => {
    const resourceType = (group.getByLabelText('Resource type') as HTMLSelectElement).value;
    const selectorForm = (group.getByLabelText('Selector') as HTMLSelectElement).value;
    const idsField = group.queryByLabelText(/^(Project ids|Ids)/) as HTMLInputElement | null;
    const verbs = group.getAllByRole('checkbox').filter((box: HTMLElement) => (box as HTMLInputElement).checked)
      .map((box: HTMLElement) => (box.closest('label')?.textContent ?? '').trim());
    return idsField
      ? { resourceType, selectorForm, selectorIds: idsField.value.split(/[\s,]+/).filter(Boolean), verbs }
      : { resourceType, selectorForm, verbs };
  });
}

describe('the warrant form ceiling-rules field', () => {
  test('Add rule adds one row per resource type, and Remove takes exactly that row away', async () => {
    const form = await openForm();
    expect(ruleGroups(form)).toHaveLength(0);
    await userEvent.click(form.getByRole('button', { name: 'Add rule' }));
    await userEvent.click(form.getByRole('button', { name: 'Add rule' }));
    let rows = ruleGroups(form);
    expect(rows).toHaveLength(2);
    // Each new row takes the first resource type no other row holds.
    expect(rows[0].getByLabelText('Resource type')).toHaveValue('task');
    expect(rows[1].getByLabelText('Resource type')).toHaveValue('phase');
    // A type another row holds cannot be chosen twice.
    expect(within(rows[1].getByLabelText('Resource type')).getByRole('option', { name: 'task' })).toBeDisabled();
    expect(within(rows[1].getByLabelText('Resource type')).getByRole('option', { name: 'phase' })).not.toBeDisabled();
    // `surface` is not offered at all.
    expect(within(rows[0].getByLabelText('Resource type')).queryByRole('option', { name: 'surface' })).toBeNull();

    await userEvent.click(rows[0].getByRole('button', { name: 'Remove rule 1' }));
    rows = ruleGroups(form);
    expect(rows).toHaveLength(1);
    expect(rows[0].getByLabelText('Resource type')).toHaveValue('phase');
  });

  test('rows that survive Close form keep unique keys: the form shows exactly what is sent (round 1 B1)', async () => {
    // Close form unmounts the field but the rows live on in the registry, so a
    // key minted after reopening must never repeat one a surviving row holds.
    // A repeat gave two rows one React key and one set of DOM ids: a label
    // then named another row's control, and Remove rule 1 left a stale group
    // on screen that the request body no longer carried.
    let form = await openForm();
    await pasteRules(form, JSON.stringify(PACKET));
    expect(ruleGroups(form)).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Close form' }));
    expect(screen.queryByRole('form', { name: 'Create a warrant' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'New warrant' }));
    form = within(screen.getByRole('form', { name: 'Create a warrant' }));
    expect(ruleGroups(form)).toHaveLength(3);

    await userEvent.click(form.getByRole('button', { name: 'Add rule' }));
    expectRuleIdsUniqueAndOwned(form);
    await userEvent.click(ruleGroups(form)[0].getByRole('button', { name: 'Remove rule 1' }));
    expectRuleIdsUniqueAndOwned(form);
    const groups = ruleGroups(form);
    expect(groups.map((group: ReturnType<typeof within>) => (group.getByLabelText('Resource type') as HTMLSelectElement).value))
      .toEqual(['phase', 'report', 'project']);

    // The new project row is exact; give it the id it needs, then send.
    await enter(groups[2].getByLabelText(/^Ids/), PROJECT);
    await fillTheRest(form);
    const shown = shownRules(form);
    expect(shown).toEqual([
      { resourceType: 'phase', selectorForm: 'all-in-project', selectorIds: [PROJECT], verbs: ['read'] },
      { resourceType: 'report', selectorForm: 'all-of-type', verbs: ['read'] },
      { resourceType: 'project', selectorForm: 'exact', selectorIds: [PROJECT], verbs: ['read'] },
    ]);
    await userEvent.click(form.getByRole('button', { name: 'Create warrant' }));
    await stepUp();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    const body = JSON.parse(String(createCalls()[0].options?.body));
    expect(body.ceilingRules).toEqual(shown);
  });

  test('the selector offers only the forms the resource type admits, and all-of-type hides the ids', async () => {
    const form = await openForm();
    await userEvent.click(form.getByRole('button', { name: 'Add rule' }));
    const [row] = ruleGroups(form);
    const selector = row.getByLabelText('Selector');
    expect(within(selector).getAllByRole('option').map((option) => (option as HTMLOptionElement).value))
      .toEqual(['exact', 'all-of-type', 'all-in-project', 'all-except']);
    // The option is the form's own name; what it means is the description.
    expect(selector).toHaveAccessibleDescription('These ids only; it never grows.');
    await userEvent.selectOptions(selector, 'all-in-project');
    expect(selector).toHaveAccessibleDescription('Every object of this type in the Projects named, including ones created later.');
    expect(row.getByLabelText(/^Project ids/)).toBeInTheDocument();
    // A report has no project coordinate: the form falls back to exact.
    await userEvent.selectOptions(row.getByLabelText('Resource type'), 'report');
    expect(within(row.getByLabelText('Selector')).getAllByRole('option').map((option) => (option as HTMLOptionElement).value))
      .toEqual(['exact', 'all-of-type', 'all-except']);
    expect(row.getByLabelText('Selector')).toHaveValue('exact');
    await enter(row.getByLabelText(/^Ids/), PROJECT);
    await userEvent.selectOptions(row.getByLabelText('Selector'), 'all-of-type');
    expect(row.queryByLabelText(/^Ids/)).toBeNull();
    // Switching back shows an EMPTY field: ids never ride along unseen.
    await userEvent.selectOptions(row.getByLabelText('Selector'), 'exact');
    expect(row.getByLabelText(/^Ids/)).toHaveValue('');
  });

  test('Paste rules JSON fills the rows from the packet, every field of every rule', async () => {
    const form = await openForm();
    await pasteRules(form, JSON.stringify(PACKET, null, 2));
    expect(form.getByRole('status')).toHaveTextContent('Filled 3 rules from the pasted JSON.');
    const rows = ruleGroups(form);
    expect(rows).toHaveLength(3);
    expect(rows[0].getByLabelText('Resource type')).toHaveValue('task');
    expect(rows[0].getByLabelText('Selector')).toHaveValue('all-in-project');
    expect(rows[0].getByLabelText(/^Project ids/)).toHaveValue(PROJECT);
    expect(rows[0].getByRole('checkbox', { name: 'read' })).toBeChecked();
    expect(rows[0].getByRole('checkbox', { name: 'write' })).toBeChecked();
    expect(rows[0].getByRole('checkbox', { name: 'use' })).not.toBeChecked();
    expect(rows[1].getByLabelText('Resource type')).toHaveValue('phase');
    expect(rows[1].getByRole('checkbox', { name: 'write' })).not.toBeChecked();
    expect(rows[2].getByLabelText('Resource type')).toHaveValue('report');
    expect(rows[2].getByLabelText('Selector')).toHaveValue('all-of-type');
    expect(rows[2].queryByLabelText(/Ids/)).toBeNull();
    // The paste box closes once it has filled the rows.
    expect(form.queryByLabelText(/^Rules JSON/)).toBeNull();
  });

  test.each([
    ['not JSON', '[{"resourceType": "task",', /^This is not valid JSON: /],
    ['not an array', JSON.stringify(PACKET[0]), /^Paste a JSON array of rules/],
    ['an empty array', '[]', /^The array is empty: a ceiling needs at least one rule\.$/],
    ['an unknown field', JSON.stringify([{ ...PACKET[0], scope: 'x' }]), /^Rule 1 has the unknown field 'scope'; a rule carries only: resourceType, selectorForm, selectorIds, verbs\.$/],
    ['two rules on one resource type', JSON.stringify([PACKET[0], { ...PACKET[0], verbs: ['read'] }]), /^Rule 2 repeats the resource type 'task' of rule 1: one rule per resource type\.$/],
    ['a surface rule', JSON.stringify([{ resourceType: 'surface', selectorForm: 'exact', selectorIds: [PROJECT], verbs: ['read'] }]), /^Rule 1: the resource type must be one of: task, phase, project, report, skill, personality, service, plugin, blueprint \('surface' ceilings/],
    ['all-of-type with ids', JSON.stringify([{ ...PACKET[2], selectorIds: [PROJECT] }]), /^Rule 1: all-of-type takes no ids\. /],
    ['exact with no ids', JSON.stringify([{ resourceType: 'skill', selectorForm: 'exact', selectorIds: [], verbs: ['use'] }]), /^Rule 1: exact needs at least one id\.$/],
    ['a short id', JSON.stringify([{ ...PACKET[0], selectorIds: ['12345678'] }]), /^Rule 1: every Project id must be a full UUID; not one: 12345678\.$/],
    ['all-in-project on a report', JSON.stringify([{ resourceType: 'report', selectorForm: 'all-in-project', selectorIds: [PROJECT], verbs: ['read'] }]), /^Rule 1: the selector for 'report' must be one of: exact, all-of-type, all-except \(a Report carries no project coordinate\)\.$/],
    ['no verbs', JSON.stringify([{ ...PACKET[0], verbs: [] }]), /^Rule 1: choose at least one verb\.$/],
    ['the admin verb', JSON.stringify([{ ...PACKET[0], verbs: ['read', 'admin'] }]), /^Rule 1: verbs must be drawn from: read, write, use, invoke; not one: admin\.$/],
  ])('a paste with %s fills nothing and says why', async (_label, text, problem) => {
    const form = await openForm();
    await userEvent.click(form.getByRole('button', { name: 'Add rule' }));
    await pasteRules(form, text);
    const alert = form.getByRole('alert');
    expect(alert).toHaveTextContent('Nothing was filled.');
    expect(within(alert).getAllByRole('listitem').some((item) => problem.test(item.textContent ?? ''))).toBe(true);
    // All or nothing: the one row typed before the paste is untouched.
    const rows = ruleGroups(form);
    expect(rows).toHaveLength(1);
    expect(rows[0].getByLabelText('Resource type')).toHaveValue('task');
    expect(rows[0].getByLabelText('Selector')).toHaveValue('exact');
    expect(form.getByLabelText(/^Rules JSON/)).toHaveAttribute('aria-invalid', 'true');
  });

  test('the profile selector and the rules exclude each other; with neither, the selector is required as before', async () => {
    const form = await openForm();
    const profile = form.getByLabelText('Ceiling profile (pins the published version)');
    const rules = form.getByRole('group', { name: /^Ceiling rules/ });
    // Neither: the selector is required (the existing behaviour), both enabled.
    expect(profile).toBeRequired();
    expect(profile).toBeEnabled();
    expect(rules).toBeEnabled();

    // A profile disables the whole rules field.
    await userEvent.selectOptions(profile, PROFILE);
    expect(rules).toBeDisabled();
    expect(form.getByRole('button', { name: 'Add rule' })).toBeDisabled();
    expect(form.getByRole('button', { name: 'Paste rules JSON' })).toBeDisabled();
    expect(within(rules).getByText(/A published profile is chosen above\./)).toBeInTheDocument();

    // Cleared, the rules come back; a rule then disables the selector.
    await userEvent.selectOptions(profile, '');
    expect(rules).toBeEnabled();
    await userEvent.click(form.getByRole('button', { name: 'Add rule' }));
    expect(profile).toBeDisabled();
    expect(profile).not.toBeRequired();
    expect(profile).toHaveAccessibleDescription(/Remove every rule to choose a profile instead\./);

    // Every rule removed: back to the existing behaviour.
    await userEvent.click(form.getByRole('button', { name: 'Remove rule 1' }));
    expect(profile).toBeEnabled();
    expect(profile).toBeRequired();
  });

  test('the request carries ceilingRules exactly as pasted, and no profile beside them', async () => {
    const form = await openForm();
    await fillTheRest(form);
    await pasteRules(form, JSON.stringify(PACKET));
    await userEvent.click(form.getByRole('button', { name: 'Create warrant' }));
    // The step-up dialog says what the ceiling is before anything is sent.
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Its ceiling is the 3 rules you entered, published as this warrant's own Access profile\./);
    expect(createCalls()).toHaveLength(0);
    await stepUp();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    const body = JSON.parse(String(createCalls()[0].options?.body));
    // Byte-for-byte, key order included: what was pasted is what was sent.
    expect(JSON.stringify(body.ceilingRules)).toBe(JSON.stringify(PACKET));
    expect(body).not.toHaveProperty('ceilingProfileId');
    expect(body).toMatchObject({
      stepUpToken: 'rhsu_test_token',
      name: 'Main phase 10',
      holderPrincipalId: HOLDER,
      anchors: [{ anchorType: 'phase', anchorId: PHASE }],
      ceilingScopes: ['tasks:read', 'reports:read'],
      maxConcurrent: 3,
      transportPin: 'any',
    });
    expect(await screen.findByText(/its ceiling rules were published as its own Access profile/)).toBeInTheDocument();
    // The form closed and reset: opening it again shows no rule.
    await userEvent.click(screen.getByRole('button', { name: 'New warrant' }));
    expect(ruleGroups(within(screen.getByRole('form', { name: 'Create a warrant' })))).toHaveLength(0);
  });

  test('typed rules are sent as typed: ids split on commas and spaces, verbs in the order chosen', async () => {
    const form = await openForm();
    await fillTheRest(form);
    await userEvent.click(form.getByRole('button', { name: 'Add rule' }));
    const [row] = ruleGroups(form);
    await userEvent.selectOptions(row.getByLabelText('Selector'), 'all-in-project');
    await enter(row.getByLabelText(/^Project ids/), ` ${PROJECT} ,${PHASE}`);
    // read is ticked by default; the clicks below leave the verbs in an order
    // no sort would produce (red proof M10 found an order that sorting kept).
    await userEvent.click(row.getByRole('checkbox', { name: 'write' }));
    await userEvent.click(row.getByRole('checkbox', { name: 'read' }));
    await userEvent.click(row.getByRole('checkbox', { name: 'invoke' }));
    await userEvent.click(row.getByRole('checkbox', { name: 'read' }));
    await userEvent.click(form.getByRole('button', { name: 'Create warrant' }));
    await stepUp();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    const body = JSON.parse(String(createCalls()[0].options?.body));
    expect(body.ceilingRules).toEqual([
      { resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [PROJECT, PHASE], verbs: ['write', 'invoke', 'read'] },
    ]);
    expect(body).not.toHaveProperty('ceilingProfileId');
  });

  test('a rule the server would refuse is refused before step-up, and the list follows the fixes', async () => {
    const form = await openForm();
    await fillTheRest(form);
    await userEvent.click(form.getByRole('button', { name: 'Add rule' }));
    const [row] = ruleGroups(form);
    await userEvent.type(row.getByLabelText(/^Ids/), 'not-a-uuid');
    await userEvent.click(row.getByRole('checkbox', { name: 'read' }));
    await userEvent.click(form.getByRole('button', { name: 'Create warrant' }));

    const alert = within(form.getByRole('group', { name: /^Ceiling rules/ })).getByRole('alert');
    expect(alert).toHaveTextContent('The warrant was not sent. Fix these rules first:');
    expect(within(alert).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Rule 1: every id must be a full UUID; not one: not-a-uuid.',
      'Rule 1: choose at least one verb.',
    ]);
    // Nothing left the page, and no step-up token was asked for.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(createCalls()).toHaveLength(0);
    expect(fetchCalls.some((call) => call.url.endsWith('/auth/step-up'))).toBe(false);

    // The list is live: each fix removes its line, and the last fix the list.
    await userEvent.click(row.getByRole('checkbox', { name: 'write' }));
    expect(within(alert).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.clear(row.getByLabelText(/^Ids/));
    await enter(row.getByLabelText(/^Ids/), PROJECT);
    expect(within(form.getByRole('group', { name: /^Ceiling rules/ })).queryByRole('alert')).toBeNull();
    await userEvent.click(form.getByRole('button', { name: 'Create warrant' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  test('a server refusal renders verbatim inside the form, and the rules stay for the retry', async () => {
    const refusal = "the warrant ceiling exceeds the creator's authority (§6.2): [{\"resourceType\":\"task\"}]";
    createAnswer = { status: 403, body: { error: 'Refused', code: 'CEILING_EXCEEDS_CREATOR', message: refusal } };
    const form = await openForm();
    await fillTheRest(form);
    await pasteRules(form, JSON.stringify(PACKET));
    await userEvent.click(form.getByRole('button', { name: 'Create warrant' }));
    await stepUp();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    const alert = await within(screen.getByRole('form', { name: 'Create a warrant' })).findByRole('alert');
    expect(alert).toHaveTextContent(`The server refused this warrant (HTTP 403, CEILING_EXCEEDS_CREATOR): ${refusal}`);
    expect(ruleGroups(within(screen.getByRole('form', { name: 'Create a warrant' })))).toHaveLength(3);
    // Editing the rules clears the stale refusal.
    await userEvent.click(ruleGroups(within(screen.getByRole('form', { name: 'Create a warrant' })))[2]
      .getByRole('checkbox', { name: 'use' }));
    expect(within(screen.getByRole('form', { name: 'Create a warrant' })).queryByRole('alert')).toBeNull();
  });

  test('a 5xx renders in the form too, with its error id', async () => {
    createAnswer = {
      status: 500,
      body: { error: 'Internal Server Error', code: 'WARRANT_CREATE_FAILED', message: 'Failed to create the warrant', errorId: 'err-0123' },
    };
    const form = await openForm();
    await fillTheRest(form);
    await pasteRules(form, JSON.stringify(PACKET));
    await userEvent.click(form.getByRole('button', { name: 'Create warrant' }));
    await stepUp();
    const alert = await within(screen.getByRole('form', { name: 'Create a warrant' })).findByRole('alert');
    expect(alert).toHaveTextContent('The server could not create this warrant (HTTP 500, WARRANT_CREATE_FAILED): Failed to create the warrant (error id err-0123)');
  });

  test('with no rule the profile path is unchanged: the profile is sent and ceilingRules is not', async () => {
    const form = await openForm();
    await fillTheRest(form);
    await userEvent.selectOptions(form.getByLabelText('Ceiling profile (pins the published version)'), PROFILE);
    await userEvent.click(form.getByRole('button', { name: 'Create warrant' }));
    expect(await screen.findByRole('dialog')).not.toHaveTextContent(/Its ceiling is/);
    await stepUp();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    const body = JSON.parse(String(createCalls()[0].options?.body));
    expect(body.ceilingProfileId).toBe(PROFILE);
    expect(body).not.toHaveProperty('ceilingRules');
    expect(await screen.findByText('Warrant created and recorded with its pinned ceiling.')).toBeInTheDocument();
  });

  test('the open form with rules, a paste refusal and a submit refusal is axe-clean', async () => {
    const form = await openForm();
    await fillTheRest(form);
    await pasteRules(form, JSON.stringify(PACKET));
    await userEvent.click(form.getByRole('button', { name: 'Add rule' }));
    await userEvent.click(ruleGroups(form)[3].getByRole('checkbox', { name: 'read' }));
    await userEvent.click(form.getByRole('button', { name: 'Create warrant' }));
    await pasteRules(form, '[1]');
    expect(form.getAllByRole('alert')).toHaveLength(2);
    const results = await axe.run(screen.getByRole('form', { name: 'Create a warrant' }), {
      rules: { 'color-contrast': { enabled: false } },
      resultTypes: ['violations'],
    });
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.html).join(' | ')}`)).toEqual([]);
  });
});

describe('a warrant lists the rules its pinned version carries', () => {
  const WARRANT = {
    id: '55555555-0000-4000-8000-000000000005', name: 'Main phase 10', description: '',
    holderPrincipalId: HOLDER, status: 'active', ceilingProfileName: 'Warrant ceiling — Main phase 10 (ab12cd34)',
    ceilingProfileVersionNumber: 1, ceilingProfileId: PROFILE, ceilingProfileVersionId: 'vvvvvvvv-0001-4000-8000-000000000001',
    ceilingRules: null, ceilingScopes: ['tasks:read'], expiresAt: null, transportPin: 'any',
    maxConcurrent: 3, maxTotal: 60, mintedTotal: 0, liveMinted: 0, suspendedReason: null,
    anchors: [{ anchorType: 'phase', anchorId: PHASE }],
  };

  test('warrant cap narrowing saves in place and can narrow live Agents without step-up', async () => {
    routes.set('/warrants', { success: true, warrants: [WARRANT] });
    routes.set(`/warrants/${WARRANT.id}`, { success: true, mintedIdentities: [], edit: { direction: 'narrowing', narrowedAgents: [], revokedAgents: [] } });
    render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = within(screen.getByRole('form', { name: 'Edit a warrant' }));
    expect(form.getByLabelText('Holder (connector or service account)')).toBeDisabled();
    fireEvent.change(form.getByLabelText(/^Max concurrent/), { target: { value: '2' } });
    await userEvent.click(form.getByRole('checkbox', { name: /Narrow all live minted Agents/ }));
    await userEvent.click(form.getByRole('button', { name: 'Save warrant edit' }));
    await waitFor(() => expect(fetchCalls.some(call => call.options?.method === 'PATCH')).toBe(true));
    const call = fetchCalls.find(call => call.options?.method === 'PATCH')!;
    expect(call.url).toBe(`/api/warrants/${WARRANT.id}`);
    expect(JSON.parse(String(call.options?.body))).toEqual({ maxConcurrent: 2, acknowledgeDependents: false, narrowAgents: true });
    expect(fetchCalls.filter(call => call.url.endsWith('/auth/step-up'))).toHaveLength(0);
  });

  test('a ceiling edit names a riding task before it can be acknowledged', async () => {
    const rider = { id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', title: 'Riding task', status: 'todo' };
    routes.set('/warrants', { success: true, warrants: [WARRANT] });
    routes.set(`/warrants/${WARRANT.id}/dependent-tasks`, { success: true, tasks: [rider], total: 1, concealed: 0 });
    render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = within(screen.getByRole('form', { name: 'Edit a warrant' }));
    await userEvent.click(form.getByRole('button', { name: 'Paste rules JSON' }));
    fireEvent.change(form.getByRole('textbox', { name: /Rules JSON/ }), { target: { value: JSON.stringify([
      { resourceType: 'task', selectorForm: 'exact', selectorIds: [rider.id], verbs: ['read'] },
    ]) } });
    await userEvent.click(form.getByRole('button', { name: 'Fill rows from JSON' }));
    await userEvent.selectOptions(form.getByLabelText('Lifetime for this edit'), 'keep');
    await userEvent.click(form.getByRole('button', { name: 'Save warrant edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/1 not-yet-terminal Task ride this warrant/)).toBeInTheDocument();
    expect(dialog.getByText('Riding task (todo)')).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Acknowledge riding tasks and continue' })).toBeEnabled();
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(fetchCalls.filter(call => call.options?.method === 'PATCH')).toHaveLength(0);
  });

  test('the loaded warrant edit form is accessible', async () => {
    routes.set('/warrants', { success: true, warrants: [WARRANT] });
    render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const results = await axe.run(screen.getByRole('form', { name: 'Edit a warrant' }), {
      rules: { 'color-contrast': { enabled: false } },
      resultTypes: ['violations'],
    });
    expect(results.violations.map(({ id, nodes }) => `${id}: ${nodes.map(({ html }) => html).join(', ')}`)).toEqual([]);
  });

  test('warrant widening preselects until-task and waits for an explicit lifetime endpoint', async () => {
    routes.set('/warrants', { success: true, warrants: [WARRANT] });
    render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = within(screen.getByRole('form', { name: 'Edit a warrant' }));
    fireEvent.change(form.getByLabelText(/^Max concurrent/), { target: { value: '4' } });
    expect(form.getByLabelText('Lifetime for this edit')).toHaveValue('until-task');
    await userEvent.click(form.getByRole('button', { name: 'Save warrant edit' }));
    expect(fetchCalls.filter(call => call.options?.method === 'PATCH')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.selectOptions(form.getByLabelText('Lifetime for this edit'), 'keep');
    await userEvent.click(form.getByRole('button', { name: 'Save warrant edit' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Confirm it');
    expect(fetchCalls.filter(call => call.options?.method === 'PATCH')).toHaveLength(0);
  });

  async function openDetails() {
    render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }));
    return within((await screen.findByText(WARRANT.name)).closest('li') as HTMLElement);
  }

  test('the PINNED version, chosen by id: a later version of the same profile is not this ceiling', async () => {
    routes.set('/warrants', { success: true, warrants: [WARRANT] });
    routes.set(`/access-profiles/${PROFILE}/versions`, {
      success: true,
      versions: [
        { id: WARRANT.ceilingProfileVersionId, versionNumber: 1, rules: PACKET.map((rule) => ({ selectorIds: [], ...rule })) },
        { id: 'vvvvvvvv-0002-4000-8000-000000000002', versionNumber: 2, rules: [
          { resourceType: 'skill', selectorForm: 'all-of-type', selectorIds: [], verbs: ['admin'] },
        ] },
      ],
    });
    const item = await openDetails();
    const list = await item.findByRole('list', { name: 'Pinned ceiling rules' });
    expect(within(list).getAllByRole('listitem').map((entry) => entry.textContent)).toEqual([
      'read/write on every (in 1 project) task · 12345678',
      'read on every (in 1 project) phase · 12345678',
      'read on every report',
    ]);
    expect(item.queryByText(/admin on every skill/)).toBeNull();
    expect(fetchCalls.filter((call) => call.url.endsWith(`/access-profiles/${PROFILE}/versions`))).toHaveLength(1);
  });

  test('rules carried inline on an older warrant row are listed without a read', async () => {
    routes.set('/warrants', {
      success: true,
      warrants: [{ ...WARRANT, ceilingProfileId: null, ceilingProfileVersionId: null, ceilingRules: [PACKET[2]] }],
    });
    const item = await openDetails();
    const list = await item.findByRole('list', { name: 'Pinned ceiling rules' });
    expect(within(list).getAllByRole('listitem').map((entry) => entry.textContent)).toEqual(['read on every report']);
    expect(fetchCalls.some((call) => call.url.includes('/versions'))).toBe(false);
  });

  test('an unreadable history says so in the panel; it is never an empty ceiling', async () => {
    routes.set('/warrants', { success: true, warrants: [WARRANT] });
    const refused = Promise.reject(new Error('Insufficient scope: principals:read'));
    refused.catch(() => undefined);
    routes.set(`/access-profiles/${PROFILE}/versions`, refused);
    const item = await openDetails();
    expect(await item.findByText('The pinned rules could not be read: Insufficient scope: principals:read')).toBeInTheDocument();
    expect(item.queryByRole('list', { name: 'Pinned ceiling rules' })).toBeNull();
    // The failure belongs to that list; the page-level error stays clear of it.
    expect(screen.queryByText('Insufficient scope: principals:read', { selector: '.axm-error' })).toBeNull();
  });

  test('while the history is in flight the panel says it is reading', async () => {
    routes.set('/warrants', { success: true, warrants: [WARRANT] });
    routes.set(`/access-profiles/${PROFILE}/versions`, new Promise(() => {}));
    const item = await openDetails();
    expect(await item.findByText('Reading the pinned rules…')).toBeInTheDocument();
  });
});
