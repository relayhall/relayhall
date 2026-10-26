// @vitest-environment jsdom
/**
 * Stored-XSS pins for the report detail page (task da1209f5; same
 * safety-floor class as review a2b2f742 F2). Report content is stored
 * agent-writable data (reports:write), so it must render through the shared
 * sanitizer — benign Markdown intact, active HTML stripped.
 */
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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
    expect(screen.getByRole('button', { name: 'View context' }).closest('.report-detail-actions')).not.toBeNull();
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


test('task-bound report uses its canonical task editor, not generic PATCH', async () => {
  const response = await reportResponse('Task evidence').json();
  response.report.origin = 'task-report';
  response.report.source_task_id = 'source-task';
  response.report.task_ids = ['unrelated-association'];
  mockFetch.mockResolvedValue(jsonResponse(response));
  renderPage();
  await screen.findByRole('heading', {name:'Fixture report'});
  expect(screen.queryByRole('button', {name:'Edit'})).not.toBeInTheDocument();
  expect(screen.getByRole('link', {name:'Open task report'}))
    .toHaveAttribute('href','/tasks/source-task?report=r1#task-detail-reports-heading');
  expect(mockFetch.mock.calls.some(([,init]) => init?.method === 'PATCH')).toBe(false);
});

test('association metadata alone does not turn a standalone report into a task report', async () => {
  const response = await reportResponse('Standalone evidence').json();
  response.report.origin = 'api';
  response.report.task_ids = ['associated-task'];
  mockFetch.mockResolvedValue(jsonResponse(response));
  renderPage();
  await screen.findByRole('heading', {name:'Fixture report'});
  fireEvent.click(screen.getByRole('button',{name:'Edit'}));
  expect(screen.getByRole('heading',{name:'Edit Report'})).toBeInTheDocument();
  expect(screen.queryByRole('link',{name:'Open task report'})).not.toBeInTheDocument();
});


function ReportRouteSwitch(){const navigate=useNavigate();return <button onClick={()=>navigate("/reports/r2")}>Switch Report route</button>;}
function renderSwitchingReports(){return render(<MemoryRouter initialEntries={["/reports/r1"]}><Routes><Route path="/reports/:id" element={<><ReportDetailPage/><ReportRouteSwitch/></>}/></Routes></MemoryRouter>);}
test("late GET from a previous Report route cannot replace the canonical current Report",async()=>{
  let finish!:(response:Response)=>void;
  const second=await reportResponse("Second canonical evidence").json();second.report.id="r2";second.report.title="Second canonical report";second.report.origin="task-report";second.report.source_task_id="second-task";
  mockFetch.mockImplementation(async input=>String(input).endsWith("/r1")?new Promise<Response>(resolve=>{finish=resolve;}):jsonResponse(second));
  renderSwitchingReports();await waitFor(()=>expect(finish).toBeDefined());
  fireEvent.click(screen.getByRole("button",{name:"Switch Report route"}));await screen.findByRole("heading",{name:"Second canonical report"});
  await act(async()=>finish(reportResponse("Stale first evidence")));
  expect(screen.getByRole("heading",{name:"Second canonical report"})).toBeInTheDocument();
  expect(screen.getByRole("link",{name:"Open task report"})).toHaveAttribute("href","/tasks/second-task?report=r2#task-detail-reports-heading");
  expect(screen.queryByRole("button",{name:"Edit"})).not.toBeInTheDocument();
});
test("late PATCH result cannot reopen standalone editing on a new task-bound Report route",async()=>{
  let finish!:(response:Response)=>void;
  const second=await reportResponse("Second canonical evidence").json();second.report.id="r2";second.report.title="Second canonical report";second.report.origin="task-report";second.report.source_task_id="second-task";
  mockFetch.mockImplementation(async(input,init)=>init?.method==="PATCH"?new Promise<Response>(resolve=>{finish=resolve;}):String(input).endsWith("/r2")?jsonResponse(second):reportResponse("First evidence"));
  renderSwitchingReports();await screen.findByRole("heading",{name:"Fixture report"});
  fireEvent.click(screen.getByRole("button",{name:"Edit"}));fireEvent.click(screen.getByRole("button",{name:"Save Changes"}));await waitFor(()=>expect(finish).toBeDefined());
  fireEvent.click(screen.getByRole("button",{name:"Switch Report route"}));await screen.findByRole("heading",{name:"Second canonical report"});
  await act(async()=>finish(reportResponse("Stale patch evidence")));
  expect(screen.getByRole("heading",{name:"Second canonical report"})).toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"Edit"})).not.toBeInTheDocument();expect(screen.queryByRole("heading",{name:"Edit Report"})).not.toBeInTheDocument();
});
