// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { TaskSuccessCriteria } from './TaskSuccessCriteria';
import type { Task } from '../../types/task';
import { authenticatedFetch } from '../../utils/auth';
vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(authenticatedFetch).mockReset(); });
const task = (allowed = false) => ({ id: 'criteria-task', successCriteria: ['Independent evidence'], successCriteriaAccess: { allowed } } as Task);
test('implementer sees criteria read-only with no edit control', () => {
  render(<TaskSuccessCriteria task={task()} onSaved={vi.fn()} />);
  expect(screen.getByText('Independent evidence')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
test('lawful Verifier editor writes only the dedicated route and refreshes after success', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(JSON.stringify({ success: true })));
  render(<TaskSuccessCriteria task={task(true)} onSaved={refresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit success criteria' }));
  fireEvent.change(screen.getByLabelText('Success criteria (one check per line)'), { target: { value: 'Check one\nCheck two' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save success criteria' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(authenticatedFetch).toHaveBeenCalledWith('/api/tasks/criteria-task/success-criteria', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ successCriteria: ['Check one', 'Check two'] }) }));
});
test('server rejection retains the draft and displays the refusal; revoked hint removes editor', async () => {
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(JSON.stringify({ error: 'Verifier appointment changed' }), { status: 403 }));
  const refresh = vi.fn();
  const { rerender } = render(<TaskSuccessCriteria task={task(true)} onSaved={refresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit success criteria' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save success criteria' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Verifier appointment changed');
  expect(screen.getByLabelText('Success criteria (one check per line)')).toBeInTheDocument();
  expect(refresh).not.toHaveBeenCalled();
  rerender(<TaskSuccessCriteria task={task(false)} onSaved={refresh} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
