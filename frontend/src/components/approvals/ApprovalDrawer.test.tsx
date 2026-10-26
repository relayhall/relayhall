// @vitest-environment jsdom
/**
 * The approval drawer's ledger words (card b1e3b16d; a defect lane L1 left).
 *
 * The drawer keyed its labels by bare words ("requested") while the server
 * stores `approval.requested` (migration 098's CHECK, widened by 142 with
 * `approval.revoked`, by 158 with the change ledger rows), so production
 * showed raw action names and a revoked
 * request had no word at all. The only fixture used the drawer's OWN spelling,
 * so no test could fail. This one reads the action set from the BACKEND's
 * migration — a constant the drawer does not own — so the two cannot drift
 * apart unnoticed: a new action in a migration is a red test here until it has
 * a word.
 */
import '@testing-library/jest-dom/vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

let reply: unknown;
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => reply })),
}));

import { ACTION_LABELS, ApprovalDrawer, actionLabel } from './ApprovalDrawer';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'backend', 'src', 'migrations');

/** The action values the LATEST approval_events CHECK admits, read from the migrations in order. */
function backendActions(): string[] {
  const files = readdirSync(MIGRATIONS).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
  let latest: string[] | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf-8');
    const creates = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS approval_events[\s\S]*?action TEXT NOT NULL CHECK \(action IN\s*\(([^)]*)\)\)/g)];
    const alters = [...sql.matchAll(/ADD CONSTRAINT approval_events_action_check CHECK \(action IN\s*\(([^)]*)\)\)/g)];
    for (const match of [...creates, ...alters]) latest = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }
  if (!latest) throw new Error('no approval_events action CHECK found in the backend migrations');
  return latest;
}

afterEach(() => { cleanup(); });

describe('the ledger words', () => {
  test('every action the backend stores has a word, and no word is keyed by a value the backend never stores', () => {
    const actions = backendActions();
    expect(actions).toEqual(expect.arrayContaining(['approval.requested', 'approval.approved', 'approval.revoked']));
    for (const action of actions) {
      expect(ACTION_LABELS[action], `no label for ${action}`).toBeDefined();
      expect(actionLabel(action)).not.toBe(action);
    }
    expect(Object.keys(ACTION_LABELS).sort()).toEqual([...actions].sort());
  });

  test('the drawer renders the stored values as words, revoked included', async () => {
    reply = {
      success: true,
      approval: {
        id: 'a1', kind: 'grant', status: 'approved', requesterPrincipalId: 'p1', requesterHandle: 'agent-1',
        targetTaskId: 't1', targetTaskTitle: 'Fixture task', requestedScopes: [], requestedRules: [], approvedScopes: null,
        lapseReason: null, denialReason: null, requestedAt: '2026-10-10T10:00:00.000Z',
        pendingExpiresAt: '2026-10-17T10:00:00.000Z', collectExpiresAt: null,
      },
      events: backendActions().map((action, index) => ({
        id: index, occurredAt: '2026-10-10T10:00:00.000Z', approvalId: 'a1', action, actorPrincipalId: 'p-root',
        actorHandle: 'root', metadata: {},
      })),
    };
    render(<MemoryRouter><ApprovalDrawer approvalId="a1" onClose={() => undefined} /></MemoryRouter>);
    const drawer = await screen.findByRole('dialog', { name: 'Approval history' });
    await within(drawer).findByText('Who did what');
    const words = within(drawer).getAllByRole('listitem').map((row) => row.querySelector('.approval-drawer-event-action')!.textContent);
    const stored = backendActions();
    expect(words).toEqual(stored.map((action) => ACTION_LABELS[action]));
    expect(words).toEqual(expect.arrayContaining(['Requested', 'Approved', 'Denied', 'Collected', 'Lapsed', 'Revoked']));
    expect(new Set(words).size).toBe(stored.length);
    for (const action of stored) expect(drawer.textContent).not.toContain(action);
    expect(within(drawer).getByRole('link', { name: 'Fixture task' })).toHaveClass('approval-drawer-link');
  });
});
