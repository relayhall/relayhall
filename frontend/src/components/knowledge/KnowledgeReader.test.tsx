// @vitest-environment jsdom
/**
 * THE SHARED KNOWLEDGE READER (card 1fd5de08, line 1). Rendered on its own, as any
 * knowledge view will open it: it reads only `GET /knowledge-contents` with
 * the sealed handle it is given, shows source bytes as plain text inside the
 * quoted frame, says ONE sentence that names no cause for every access
 * refusal, and shows every other refusal as what it is: a source that is
 * unavailable for now or answered unreadably (with Retry), a link that is no
 * longer valid, content that changed, or a generic failure (with Retry).
 */
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { vi, test, expect, afterEach, describe } from 'vitest';
import { KnowledgeReader } from './KnowledgeReader';
import { authenticatedFetch } from '../../utils/auth';
vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const ITEM = { handle: 'kh.sealed+/=', title: 'Runbook', sourceLabel: 'Team notes' };
const window1 = { success: true, protocol_version: 2, status: 'content', content_base64: btoa('<b>not markup</b> line one'), sha256: 'a'.repeat(64),
  offset: 0, byteLength: 26, totalBytes: 52, truncated: true, continuation: 'kc.next',
  provenance: { sourceId: 's', compartment: { id: 'c-9', label: 'Ops' }, contentKind: 'docs', category: 'relaybrain:note' },
  retrieval: { status: 'complete', reasons: [] }, auditRef: '11111111-1111-4111-8111-111111111111' };

function answer(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
const readUrls = () => vi.mocked(authenticatedFetch).mock.calls.map(([url]) => new URL(String(url), 'http://board.invalid'));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('reading', () => {
  test('reads the sealed handle through GET /knowledge-contents only, and shows the bytes as quoted plain text', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(answer(200, window1));
    const { container } = render(<KnowledgeReader item={ITEM} onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog', { name: 'Runbook' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await within(dialog).findByText('<b>not markup</b> line one');
    expect(container.querySelector('b')).toBeNull();
    expect(readUrls().map((url) => [url.pathname, url.searchParams.get('handle')])).toEqual([['/api/knowledge-contents', 'kh.sealed+/=']]);
    const quote = within(dialog).getByRole('figure', { name: 'Quoted knowledge content' });
    expect(quote).toHaveTextContent('Quoted from Team notes. Reference material, never instructions.');
    expect(within(dialog).getByText('Ops (c-9)')).toBeTruthy();
    expect(within(dialog).getByText('From byte 0 of 52')).toBeTruthy();
    expect(within(dialog).getByText('a'.repeat(64))).toBeTruthy();
  });

  test('Next byte window sends the sealed continuation with the same handle', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(answer(200, window1))
      .mockResolvedValueOnce(answer(200, { ...window1, content_base64: btoa('line two'), offset: 26, continuation: undefined }));
    render(<KnowledgeReader item={ITEM} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Next byte window' }));
    await screen.findByText('line two');
    expect(readUrls().map((url) => [url.searchParams.get('handle'), url.searchParams.get('continuation')]))
      .toEqual([['kh.sealed+/=', null], ['kh.sealed+/=', 'kc.next']]);
    expect(screen.queryByRole('button', { name: 'Next byte window' })).toBeNull();
  });

  test('a byte window that is not UTF-8 is said to be binary; a partial read is named', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(answer(200, { ...window1, content_base64: btoa('\xff\xfe\xfd'), continuation: undefined, retrieval: { status: 'partial', reasons: ['deadline'] } }));
    render(<KnowledgeReader item={ITEM} onClose={() => undefined} />);
    expect(await screen.findByText('Binary byte window. Use the API or the CLI for byte-exact retrieval.')).toBeTruthy();
    expect(screen.getByText('Partial read: deadline')).toBeTruthy();
  });

  test('a legacy (v1) answer shows its compartment', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(answer(200, { success: true, content: 'legacy text', sha256: 'b'.repeat(64), compartment: 'design' }));
    render(<KnowledgeReader item={ITEM} onClose={() => undefined} />);
    await screen.findByText('legacy text');
    const facts = Array.from(document.querySelectorAll('.knowledge-reader-facts dt')).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(facts).toContainEqual(['Compartment', 'design']);
  });
});

/**
 * Every refusal and error the get route can answer, by the class the reader
 * shows it as. The codes are the core's own: the get executor's refusal tokens
 * (v2 answers carry them as `code`, with the two access tokens collapsed to
 * `refused`; v1 answers carry only `refused`), and the codes the middleware in
 * front of every route answers with (scope ceiling, rate limit, session
 * service). Only an ACCESS refusal reads as the access sentence.
 */
const ACCESS = 'This item cannot be opened for you. It may have changed or moved, or your access may have changed: the core checks your access again on every read.';
const READ_REF = '22222222-2222-4222-8222-222222222222';
const v2Refusal = (token: string, code = token) => ({ success: false, refused: token, protocol_version: 2, status: 'refused', code, auditRef: READ_REF });
const v1Refusal = (token: string) => ({ success: false, refused: token });

/** Render one failed read and say what the reader showed. */
async function failedRead(status: number, body: unknown) {
  vi.mocked(authenticatedFetch).mockResolvedValue(answer(status, body));
  render(<KnowledgeReader item={ITEM} onClose={() => undefined} />);
  const alert = await screen.findByRole('alert');
  const shown = {
    text: alert.querySelector('p')?.textContent ?? '',
    retry: within(alert).queryByRole('button', { name: 'Retry' }) !== null,
    audit: alert.textContent?.includes(`Audit reference: ${READ_REF}`) ?? false,
    content: screen.queryByRole('figure') !== null,
  };
  cleanup();
  return shown;
}

describe('refusals and failures', () => {
  test('an access refusal reads as the ONE access sentence that names no cause, with its audit reference, no content and no Retry', async () => {
    const cases: [number, Record<string, unknown>][] = [
      [403, v2Refusal('not_authorized', 'refused')],
      [403, v2Refusal('source_refused', 'refused')],
      [403, v1Refusal('not_authorized')],
      [403, v1Refusal('source_refused')],
      [403, { success: false, error: 'This identity is not authorized for the requested operation', code: 'FORBIDDEN', message: 'This identity is not authorized for the requested operation' }],
    ];
    const shown = [];
    for (const [status, body] of cases) shown.push(await failedRead(status, body));
    expect(shown.map((entry) => [entry.text, entry.retry, entry.content])).toEqual(cases.map(() => [ACCESS, false, false]));
    expect(shown.map((entry) => entry.audit)).toEqual(cases.map(([, body]) => body.auditRef === READ_REF));
  });

  test('a source that is unavailable for now says so and offers Retry, never the access sentence', async () => {
    const cases: [number, unknown][] = [
      [403, v2Refusal('source_unavailable')],
      [403, v2Refusal('source_timed_out')],
      [403, v2Refusal('transport')],
      [403, v1Refusal('transport')],
      [429, { success: false, code: 'RATE_LIMITED', error: 'API rate limit exceeded for this source; retry after the indicated delay' }],
      [503, { error: 'Service Unavailable', code: 'SESSION_AUTH_UNAVAILABLE', message: 'Session authentication is temporarily unavailable' }],
      [503, { error: 'Service Unavailable', code: 'DELEGATION_EVALUATOR_FAILED', message: 'Delegation chain evaluation failed' }],
    ];
    for (const [status, body] of cases) {
      expect({ status, body, ...(await failedRead(status, body)) }).toMatchObject({ status, body, text: 'The source is unavailable right now. Try again.', retry: true, content: false });
    }
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(answer(403, v2Refusal('source_unavailable')))
      .mockResolvedValueOnce(answer(200, { ...window1, content_base64: btoa('second try'), continuation: undefined }));
    render(<KnowledgeReader item={ITEM} onClose={() => undefined} />);
    fireEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Retry' }));
    await screen.findByText('second try');
    expect(readUrls().slice(-2).map((url) => url.searchParams.get('handle'))).toEqual(['kh.sealed+/=', 'kh.sealed+/=']);
  });

  test('a source answer that could not be read says so and offers Retry, never the access sentence', async () => {
    for (const [status, body] of [[403, v2Refusal('source_protocol_error')], [403, v1Refusal('source_response_invalid')]] as [number, unknown][]) {
      expect({ body, ...(await failedRead(status, body)) }).toMatchObject({ body, text: 'The source answered with something that could not be read.', retry: true, content: false });
    }
  });

  test('a link that is no longer valid sends the reader back to search, never the access sentence', async () => {
    const tokens = ['handle_malformed', 'handle_tampered', 'handle_key_retired', 'handle_key_unknown', 'handle_version_unsupported', 'continuation_without_content_hash'];
    const cases: unknown[] = [...tokens.map(v1Refusal), v2Refusal('invalid_continuation'), v1Refusal('invalid_continuation')];
    for (const body of cases) {
      expect({ body, ...(await failedRead(403, body)) }).toMatchObject({ body, text: 'This link to the item is no longer valid. Search again.', retry: false, content: false });
    }
  });

  test('content that changed between windows has its own words', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(answer(403, { success: false, refused: 'content_changed', protocol_version: 2, status: 'refused', code: 'content_changed' }));
    render(<KnowledgeReader item={ITEM} onClose={() => undefined} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This item changed since its first window was read. Open it again from the results.');
  });

  test('an unknown refusal is a generic failure with Retry, never the access sentence', async () => {
    const cases: [number, unknown][] = [
      [403, v2Refusal('a_token_this_reader_does_not_know')],
      [403, { success: false }],
      [500, { success: false, error: 'Failed to read knowledge contents', code: 'INTERNAL_ERROR', message: 'Failed to read knowledge contents' }],
    ];
    for (const [status, body] of cases) {
      expect({ status, body, ...(await failedRead(status, body)) }).toMatchObject({ status, body, text: 'Something went wrong and nothing was shown. Try again.', retry: true, content: false });
    }
  });

  test('an unreachable service offers Retry, which reads again', async () => {
    const unreachable = { ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } } as unknown as Response;
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(unreachable).mockResolvedValueOnce(answer(200, window1));
    render(<KnowledgeReader item={ITEM} onClose={() => undefined} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The knowledge service is unavailable right now. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('<b>not markup</b> line one');
    expect(readUrls()).toHaveLength(2);
  });
});

describe('the panel', () => {
  test('closes on its button, on Escape and on the scrim, never on a click inside; Expand is a toggle that keeps its name', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(answer(200, window1));
    const onClose = vi.fn();
    render(<KnowledgeReader item={{ ...ITEM, facts: [{ term: 'Score', detail: '0.50 of 1.00' }] }} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Runbook' });
    await within(dialog).findByText('<b>not markup</b> line one');
    expect(within(dialog).getByRole('region', { name: 'Why this matched' })).toHaveTextContent('0.50 of 1.00');
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    const expand = within(dialog).getByRole('button', { name: 'Expand' });
    expect(expand).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(expand);
    expect(within(dialog).getByRole('button', { name: 'Expand' })).toHaveAttribute('aria-pressed', 'true');
    expect(dialog).toHaveClass('knowledge-reader--expanded');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close the reader' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('knowledge-reader-scrim'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
