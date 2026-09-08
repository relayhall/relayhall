// @vitest-environment jsdom
/**
 * Stored-XSS pins for the report detail page (task da1209f5; same
 * safety-floor class as review a2b2f742 F2). Report content is stored
 * agent-writable data (reports:write), so it must render through the shared
 * sanitizer — benign Markdown intact, active HTML stripped.
 */
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { authenticatedFetch } from '../utils/auth';
import { ReportDetailPage } from './ReportDetailPage';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const mockFetch = vi.mocked(authenticatedFetch);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function reportResponse(content: string, handover: unknown = null) {
  return jsonResponse({
    success: true,
    report: {
      id: 'r1', title: 'Fixture report', content, summary: null, tags: [],
      project_id: null, task_ids: [], author: 'owner', pinned: false,
      handover,
      created_at: '2026-08-09T00:00:00Z', updated_at: '2026-08-09T00:00:00Z',
    },
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/reports/r1']}>
      <Routes>
        <Route path="/reports/:id" element={<ReportDetailPage />} />
        <Route path="/reports" element={<div>reports list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(cleanup);

describe('ReportDetailPage sanitization', () => {
  test('stored report content cannot execute active HTML', async () => {
    mockFetch.mockResolvedValue(reportResponse(
      '# Safe Heading\n\n<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n\n[bad](javascript:alert(3))\n\n**benign bold**',
    ));
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Safe Heading' });
    expect(screen.getByText('benign bold')).toBeInTheDocument();
    const html = container.innerHTML;
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });

  test('benign markdown renders normally (tables, code, links)', async () => {
    mockFetch.mockResolvedValue(reportResponse(
      '## Section\n\n`code span`\n\n[link](https://example.test/doc)\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    ));
    renderPage();
    await screen.findByRole('heading', { name: 'Section' });
    expect(screen.getByText('code span')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'link' });
    expect(link).toHaveAttribute('href', 'https://example.test/doc');
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('ReportDetailPage structured handover', () => {
  const handover = {
    schema_version: 1,
    decisions: ['Use the Report object.'],
    assumptions: ['The task stays project-bound.'],
    alternatives_rejected: ['A YAML footer.'],
    unresolved_questions: ['Who verifies it?'],
  };

  test('renders all four machine-readable categories as ordinary text', async () => {
    mockFetch.mockResolvedValue(reportResponse('Body', handover));
    renderPage();
    await screen.findByRole('heading', { name: 'Structured handover' });
    expect(screen.getByText('Use the Report object.')).toBeInTheDocument();
    expect(screen.getByText('The task stays project-bound.')).toBeInTheDocument();
    expect(screen.getByText('A YAML footer.')).toBeInTheDocument();
    expect(screen.getByText('Who verifies it?')).toBeInTheDocument();
  });

  test('edits one-item-per-line fields and sends the normalized wire shape', async () => {
    mockFetch
      .mockResolvedValueOnce(reportResponse('Body', handover))
      .mockResolvedValueOnce(reportResponse('Body', handover));
    renderPage();
    await screen.findByRole('heading', { name: 'Structured handover' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Decisions'), { target: { value: 'First\nSecond' } });
    fireEvent.change(screen.getByLabelText('Unresolved questions'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const request = mockFetch.mock.calls[1][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.handover).toEqual({
      schema_version: 1,
      decisions: ['First', 'Second'],
      assumptions: ['The task stays project-bound.'],
      alternatives_rejected: ['A YAML footer.'],
      unresolved_questions: [],
    });
  });
});
