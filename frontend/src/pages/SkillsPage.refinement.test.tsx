// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { authenticatedFetch } from '../utils/auth';
import { SkillsPage } from './SkillsPage';
vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../components/skills/SkillDetailModal', () => ({ SkillDetailModal: ({ skill }: any) => <div role="dialog" aria-label={skill?.name || 'New skill'} /> }));
const skill = (name: string) => ({ id: name, name, description: name, category: 'workflow', tags: [], is_global: true, version: null });
const response = (name: string) => new Response(JSON.stringify({ success: true, skills: [skill(name)] }), { status: 200 });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test('retains useful rows during filtering and only the latest response settles the view', async () => {
  const pending: Array<(response: Response) => void> = [];
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response('Initial skill')).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const user = userEvent.setup(); render(<SkillsPage />);
  expect(await screen.findByRole('button', { name: /Initial skill/ })).toBeInTheDocument();
  await user.type(screen.getByPlaceholderText('Search skills...'), 'ab');
  expect(pending).toHaveLength(2);
  expect(screen.getByRole('button', { name: /Initial skill/ })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Updating skills');
  await act(async () => pending[1](response('Latest skill')));
  expect(await screen.findByRole('button', { name: /Latest skill/ })).toBeInTheDocument();
  await act(async () => pending[0](response('Obsolete skill')));
  expect(screen.queryByRole('button', { name: /Obsolete skill/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  const card = screen.getByRole('button', { name: /Latest skill/ }); card.focus(); await user.keyboard('{Enter}');
  expect(screen.getByRole('dialog', { name: 'Latest skill' })).toBeInTheDocument();
});

test('a failed request settles with retry feedback instead of an empty success state', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: 'Registry unavailable' }), { status: 503 })).mockResolvedValueOnce(response('Recovered skill'));
  const user = userEvent.setup(); render(<SkillsPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Registry unavailable');
  expect(screen.queryByText('No skills found')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByRole('button', { name: /Recovered skill/ })).toBeInTheDocument());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
