/**
 * Card b13e5ac9 (owner ruling D34(b); Charter v5 §6.1 and §6.2): the pure
 * placement rule every creation surface reaches through
 * TaskManagerDB.createTask. These pins name the whole decision table; the
 * real-PostgreSQL drill (projectInboxDefaultLive.test.ts) proves the same
 * rows through the production router for all four surfaces.
 */
import fs from 'fs';
import path from 'path';
import {
  INBOX_DEFAULT_STATUS,
  ORDINARY_DEFAULT_STATUS,
  resolveCreatePlacement,
  statusAbsent,
} from '../services/ProjectInboxPhase';

const INBOX = 'cda0d15a-f194-405f-9e79-cdca158e0cfd';
const ACTIVE = '0e6d3c55-6b1f-4f63-9a51-4d8f2f8e1a11';
const inForce = { id: INBOX, inForce: true };
const suspended = { id: INBOX, inForce: false };

describe('the new-card placement rule (card b13e5ac9)', () => {
  it('the two defaults are Ideas in the inbox and To-Do everywhere else', () => {
    expect([INBOX_DEFAULT_STATUS, ORDINARY_DEFAULT_STATUS]).toEqual(['ideas', 'todo']);
  });

  it.each([
    // [label, requested phaseId, requested status, inbox, expected phase, expected status]
    ['absent phase, absent status, inbox in force', undefined, undefined, inForce, INBOX, 'ideas'],
    ['absent phase, explicit status wins', undefined, 'todo', inForce, INBOX, 'todo'],
    ['explicit phase wins, absent status keeps To-Do', ACTIVE, undefined, inForce, ACTIVE, 'todo'],
    ['explicit phase and status (authorised-work exception)', ACTIVE, 'todo', inForce, ACTIVE, 'todo'],
    ['naming the inbox itself, absent status', INBOX, undefined, inForce, INBOX, 'ideas'],
    ['explicit null is the backlog and wins', null, undefined, inForce, null, 'todo'],
    ['empty-string status is absent', undefined, '', inForce, INBOX, 'ideas'],
    ['no inbox phase: today', undefined, undefined, null, null, 'todo'],
    ['no inbox phase, explicit status: today', undefined, 'ideas', null, null, 'ideas'],
    ['suspended inbox: today, never redirected', undefined, undefined, suspended, null, 'todo'],
    ['suspended inbox named explicitly: that phase, To-Do', INBOX, undefined, suspended, INBOX, 'todo'],
  ] as const)('%s', (_label, phaseId, status, inbox, expectedPhase, expectedStatus) => {
    const placed = resolveCreatePlacement({ phaseId: phaseId as string | null | undefined, status }, inbox as any);
    expect([placed.phaseId, placed.status]).toEqual([expectedPhase, expectedStatus]);
  });

  it('statusAbsent reads undefined, null and the empty string as absent, and nothing else', () => {
    expect([undefined, null, ''].map(statusAbsent)).toEqual([true, true, true]);
    expect(['ideas', 'todo', 0, false].map(statusAbsent)).toEqual([false, false, false, false]);
  });
});

describe('every creation surface reaches the one decision', () => {
  const read = (relative: string): string => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

  it('createTask decides the placement after the target Project, on its own transaction, with the inbox row locked', () => {
    const source = read('services/TaskManagerDB.ts');
    const target = source.indexOf('const projectId = data.project ? await projectTarget(');
    const decision = source.indexOf('resolveCreatePlacement(');
    const insert = source.indexOf('INSERT INTO tasks (');
    expect(target).toBeGreaterThan(0);
    expect(decision).toBeGreaterThan(target);
    expect(insert).toBeGreaterThan(decision);
    expect(source).toContain('await readInboxPhase(client, projectId, { lock: true })');
    // One INSERT site: no creation path can bypass the decision.
    expect(source.match(/INSERT INTO tasks \(/g)).toHaveLength(1);
  });

  it('the REST route keeps an absent phaseId absent, so the default can see it', () => {
    expect(read('routes/tasks.ts')).toContain('phaseId: phaseId === undefined ? undefined : normalizePhaseIdWrite(phaseId)');
  });

  it('MCP relayhall_task_create forwards its arguments to POST /tasks unchanged (no phase or status default of its own)', () => {
    const registry = read('mcp/registry.ts');
    const start = registry.indexOf("name: 'relayhall_task_create'");
    const handler = registry.slice(start, registry.indexOf("name: 'relayhall_task_account_owner_get'"));
    expect(handler).toContain("board(ctx, { method: 'POST', path: '/tasks', body");
    expect(handler).not.toMatch(/body\.(phaseId|status)\s*=/);
  });
});
