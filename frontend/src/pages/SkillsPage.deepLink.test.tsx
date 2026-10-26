// @vitest-environment jsdom
/**
 * `/skills?skill=<id>` opens that Skill (card b1e3b16d): the approvals hub
 * links a skill version waiting for review here, where versions are published
 * or returned exactly as before (SkillDetailModal, unchanged). The link adds a
 * way IN, not a way to decide: closing the Skill drops the parameter, and an id
 * this session's registry does not hold says so instead of opening nothing.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../components/skills/SkillDetailModal', () => ({
  SkillDetailModal: ({ skill, onClose }: any) => (
    <div role="dialog" aria-label={skill?.name || 'New skill'}><button type="button" onClick={onClose}>Close</button></div>
  ),
}));

import { authenticatedFetch } from '../utils/auth';
import { SkillsPage } from './SkillsPage';

const SKILLS = [
  { id: 'sk-1', name: 'terraform-review', description: 'Reviews plans.', category: 'workflow', tags: [], is_global: false, version: 3 },
  { id: 'sk-2', name: 'release-notes', description: 'Writes notes.', category: 'workflow', tags: [], is_global: true, version: 1 },
];

let location = '';
function LocationProbe() {
  const current = useLocation();
  location = `${current.pathname}${current.search}`;
  return null;
}

beforeEach(() => {
  vi.mocked(authenticatedFetch).mockImplementation(async () =>
    new Response(JSON.stringify({ success: true, skills: SKILLS }), { status: 200 }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const renderAt = (entry: string) => render(
  <MemoryRouter initialEntries={[entry]}><SkillsPage /><LocationProbe /></MemoryRouter>,
);

test('?skill=<id> opens that Skill once the registry has loaded, and closing it drops the link', async () => {
  renderAt('/skills?skill=sk-1');
  expect(await screen.findByRole('dialog', { name: 'terraform-review' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(location).toBe('/skills');
});

test('an id the registry does not hold says so, and opens nothing', async () => {
  renderAt('/skills?skill=sk-404');
  expect(await screen.findByText('The linked skill is not in the registry this session can see.')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('without the parameter nothing opens by itself', async () => {
  renderAt('/skills');
  expect(await screen.findByText('release-notes')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
