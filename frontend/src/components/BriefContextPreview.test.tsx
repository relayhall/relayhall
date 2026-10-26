// @vitest-environment jsdom
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { authenticatedFetch } from '../utils/auth';
import { BriefContextPreview, ContextPreview, ContextPreviewTrigger, ContextPreviewPanel } from './BriefContextPreview';
vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
function ContextPreviewAction({ kind, elementId }: { kind: 'phase' | 'project'; elementId: string }) {
  return <ContextPreview kind={kind} elementId={elementId}>
    <header><ContextPreviewTrigger /></header>
    <main><ContextPreviewPanel /></main>
  </ContextPreview>;
}
const fetchMock = vi.mocked(authenticatedFetch);
const response = (brief: string) => ({ ok: true, json: async () => ({ brief }) }) as Response;
afterEach(() => { cleanup(); vi.resetAllMocks(); });
test('previews and copies the canonical brief without changing its bytes', async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const brief = '  <untrusted>\nExact data \u{1F680}\n</untrusted>  ';
  fetchMock.mockResolvedValue(response(brief));
  render(<BriefContextPreview kind="phase" elementId="p1" />);
  expect((await screen.findByLabelText('Context text')).textContent).toBe(brief);
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/phases/p1/brief'), expect.objectContaining({ method: 'POST', body: '{}' }));
  await user.click(screen.getByRole('button', { name: 'Copy displayed context' }));
  expect(copy).toHaveBeenCalledWith(brief);
  expect(screen.getByText(/estimate: 4 characters/)).toBeInTheDocument();
  expect(screen.getByLabelText('Context format')).toHaveClass('form-select');
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
});
test('late responses cannot expose the previous element or enable copying it', async () => {
  let resolveFirst!: (value: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }));
  fetchMock.mockResolvedValueOnce(response('second'));
  const { rerender } = render(<BriefContextPreview kind="phase" elementId="first" />);
  rerender(<BriefContextPreview kind="phase" elementId="second" />);
  await screen.findByText('second');
  resolveFirst(response('private first'));
  await waitFor(() => expect(screen.queryByText('private first')).not.toBeInTheDocument());
  expect(screen.getByLabelText('Context text')).toHaveTextContent('second');
});
test('a failed refresh removes old copyable content', async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValueOnce(response('old'));
  fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ message: 'Forbidden' }) } as Response);
  render(<BriefContextPreview kind="task" elementId="t1" />);
  await screen.findByText('old');
  await user.click(screen.getByRole('button', { name: 'Refresh context' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden');
  expect(screen.queryByLabelText('Context text')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy displayed context' })).toBeDisabled();
});

test('format change fetches canonical record and copies the complete JSON including metadata', async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const envelope = { success: true, task: { id: 't1', description: '<script>data</script>' }, omitted: { hidden: 2 } };
  fetchMock.mockResolvedValueOnce(response('brief'));
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => envelope } as Response);
  render(<BriefContextPreview kind="task" elementId="t1" />);
  await screen.findByText('brief');
  await user.selectOptions(screen.getByLabelText('Context format'), 'record');
  await waitFor(() => expect(screen.getByLabelText('Context text').textContent).toBe(JSON.stringify(envelope, null, 2)));
  expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/tasks/t1'), expect.objectContaining({ method: 'GET', cache: 'no-store' }));
  await user.click(screen.getByRole('button', { name: 'Copy displayed context' }));
  expect(copy).toHaveBeenCalledWith(JSON.stringify(envelope, null, 2));
});
test('published skill content resolves the exact version and shows its etag outside copied JSON', async () => {
  const user = userEvent.setup();
  const skill = { success: true, skill: { current_published_version_id: 'v2' } };
  const full = { success: true, version: { id: 'v2', content: 'full instructions' } };
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => skill } as Response);
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => skill } as Response);
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => full, headers: new Headers({ etag: '"digest"' }) } as Response);
  render(<BriefContextPreview kind="skill" elementId="s1" />);
  await screen.findByLabelText('Context text');
  await user.selectOptions(screen.getByLabelText('Context format'), 'skill-content');
  await waitFor(() => expect(screen.getByLabelText('Context text').textContent).toBe(JSON.stringify(full, null, 2)));
  expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/skills/s1/versions/v2/content'), expect.objectContaining({ method: 'GET' }));
  expect(screen.getByText('"digest"')).toBeInTheDocument();
});
test('no published skill version fails honestly and does not fetch draft content', async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, skill: { current_published_version_id: null } }) } as Response);
  render(<BriefContextPreview kind="skill" elementId="s1" />);
  await screen.findByLabelText('Context text');
  await user.selectOptions(screen.getByLabelText('Context format'), 'skill-content');
  expect(await screen.findByRole('alert')).toHaveTextContent('no published version');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Copy displayed context' })).toBeDisabled();
});
test('long report is not truncated or interpreted as HTML', async () => {
  const content = '<img src=x onerror=alert(1)> ' + 'long content '.repeat(10000);
  const envelope = { success: true, report: { id: 'r1', content } };
  fetchMock.mockResolvedValue({ ok: true, json: async () => envelope } as Response);
  const { container } = render(<BriefContextPreview kind="report" elementId="r1" />);
  expect((await screen.findByLabelText('Context text')).textContent).toBe(JSON.stringify(envelope, null, 2));
  expect(container.querySelector('img')).toBeNull();
});
test('disclosure loads on demand and Escape closes and restores focus', async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValue(response('brief'));
  render(<ContextPreviewAction kind="phase" elementId="p1" />);
  expect(fetchMock).not.toHaveBeenCalled();
  const trigger = screen.getByRole('button', { name: 'View context' });
  expect(trigger.closest('header')).not.toBeNull();
  expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toHaveAttribute('hidden');
  await user.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await screen.findByText('brief');
  await user.click(screen.getByLabelText('Context text'));
  await user.keyboard('{Escape}');
  expect(screen.queryByLabelText('Context text')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'View context' })).toHaveFocus();
});
test('clipboard denial is announced without changing the preview', async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  fetchMock.mockResolvedValue(response('copy me'));
  render(<BriefContextPreview kind="phase" elementId="p1" />);
  await screen.findByText('copy me');
  await user.click(screen.getByRole('button', { name: 'Copy displayed context' }));
  expect(await screen.findByText(/Copy failed/)).toBeInTheDocument();
  expect(screen.getByLabelText('Context text')).toHaveTextContent('copy me');
});
test('empty brief is a valid zero-token payload', async () => {
  fetchMock.mockResolvedValue(response(''));
  render(<BriefContextPreview kind="phase" elementId="p1" />);
  expect(await screen.findByText(/empty brief/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy displayed context' })).toBeEnabled();
});

test('project defaults to its canonical awareness brief and can show the resources envelope', async () => {
  const user = userEvent.setup();
  const envelope = { success: true, context: { project: { name: 'Project' }, resources: [], omitted: { hidden: 3 } } };
  fetchMock.mockResolvedValueOnce(response('Project awareness'));
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => envelope } as Response);
  render(<ContextPreviewAction kind="project" elementId="p1" />);
  await user.click(screen.getByRole('button', { name: 'View context' }));
  expect((await screen.findByLabelText('Context text')).textContent).toBe('Project awareness');
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/projects/p1/brief'), expect.objectContaining({ method: 'POST', body: '{}' }));
  await user.selectOptions(screen.getByLabelText('Context format'), 'resources');
  await waitFor(() => expect(screen.getByLabelText('Context text').textContent).toBe(JSON.stringify(envelope, null, 2)));
  expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/projects/p1/context'), expect.objectContaining({ method: 'GET' }));
});

test('skill choices distinguish metadata from published content without transport jargon', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, skill: {} }) } as Response);
  render(<BriefContextPreview kind="skill" elementId="s1" />);
  await screen.findByLabelText('Context text');
  expect(screen.getByRole('option', { name: 'Skill metadata' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Published skill content' })).toBeInTheDocument();
});

test('each separated toolbar controls only its own panel and restores its own focus', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementation(async endpoint => response(String(endpoint).includes('first') ? 'First context' : 'Second context'));
  render(<>
    <article aria-label="First"><ContextPreview kind="phase" elementId="first"><header><ContextPreviewTrigger /></header><ContextPreviewPanel /></ContextPreview></article>
    <article aria-label="Second"><ContextPreview kind="phase" elementId="second"><header><ContextPreviewTrigger /></header><ContextPreviewPanel /></ContextPreview></article>
  </>);
  const first = within(screen.getByRole('article', { name: 'First' }));
  const second = within(screen.getByRole('article', { name: 'Second' }));
  await user.click(first.getByRole('button', { name: 'View context' }));
  await first.findByText('First context');
  expect(second.queryByLabelText('Context text')).not.toBeInTheDocument();
  await user.click(second.getByRole('button', { name: 'View context' }));
  await second.findByText('Second context');
  await user.click(first.getByLabelText('Context text'));
  await user.keyboard('{Escape}');
  expect(first.getByRole('button', { name: 'View context' })).toHaveFocus();
  expect(second.getByLabelText('Context text')).toHaveTextContent('Second context');
});

test('hiding the panel for editing resets the disclosure and its payload', async () => {
  const user = userEvent.setup();
  fetchMock.mockResolvedValue(response('Private context'));
  const fixture = (editing: boolean) => <ContextPreview kind="phase" elementId="p1">
    {!editing && <><header><ContextPreviewTrigger /></header><ContextPreviewPanel /></>}
  </ContextPreview>;
  const { rerender } = render(fixture(false));
  await user.click(screen.getByRole('button', { name: 'View context' }));
  await screen.findByText('Private context');
  rerender(fixture(true));
  rerender(fixture(false));
  expect(screen.getByRole('button', { name: 'View context' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByLabelText('Context text')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('saved skill context sits in its header actions and is absent while creating', async () => {
  const { SkillDetailModal } = await import('./skills/SkillDetailModal');
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, versions: [] }) } as Response);
  const skill = { id: 's1', name: 'Example skill', current_version: null } as import('../types/skill').Skill;
  const callbacks = { onClose: vi.fn(), onSaved: vi.fn(), onDeleted: vi.fn() };
  const { rerender } = render(<SkillDetailModal skill={skill} {...callbacks} />);
  expect(screen.getByRole('button', { name: 'View context' }).closest('.skill-detail-actions')).not.toBeNull();
  rerender(<SkillDetailModal skill={null} {...callbacks} />);
  expect(screen.queryByRole('button', { name: 'View context' })).not.toBeInTheDocument();
});
