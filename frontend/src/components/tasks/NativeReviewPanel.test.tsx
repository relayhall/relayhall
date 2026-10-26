// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup,render,screen,fireEvent,waitFor } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach,expect,test,vi } from 'vitest';
import { NativeReviewPanel,nativeSessionPath,latestTaskReviewDecision } from './NativeReviewPanel';
import { authenticatedFetch } from '../../utils/auth';
vi.mock('../../utils/auth',()=>({authenticatedFetch:vi.fn()}));
afterEach(()=>{cleanup();vi.mocked(authenticatedFetch).mockReset();});
test.each(['restricted','expired','unavailable'])('%s session never creates a partial identity link',state=>{
  expect(nativeSessionPath({state,sessionRef:'rhp_private',connectorId:'connector',sourceProduct:'claude-code'})).toBeNull();
});
test('full triple deep link keeps all exact identifiers',()=>{
  expect(nativeSessionPath({state:'available',sessionRef:'rhp_x',connectorId:'connector-y',sourceProduct:'claude-code'})).toBe('/sessions?sessionRef=rhp_x&connectorId=connector-y&sourceProduct=claude-code');
  expect(nativeSessionPath({state:'available',sessionRef:'rhp_x'})).toBeNull();
});
test('Task shows unavailable without claiming an actual session, with separate output Report',async()=>{
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(JSON.stringify({result:[{id:'request',state:'passed',session:{state:'unavailable'},verdict:{reportId:'report'}}]})));
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><NativeReviewPanel taskId="task" status="completed"/></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Session unavailable.')).toBeInTheDocument();
  expect(screen.queryByText('View reported native session')).not.toBeInTheDocument();
  expect(screen.getByRole('link',{name:'Review evidence'})).toHaveAttribute('href','/reports/report');
});

test('accepted middle slice shows Todo and exact scope rather than claiming Task completion',async()=>{
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(JSON.stringify({result:[{id:'request',state:'passed',reviewScope:{kind:'subtask_slice',includesTaskCriteria:false},session:{state:'unavailable'},verdict:{reportId:'report',result:{status:'todo'}}}]})));
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><NativeReviewPanel taskId="task" status="todo"/></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Task status: todo.')).toBeInTheDocument();
  expect(screen.getByText(/Scope: subtask_slice/)).toBeInTheDocument();
  expect(screen.queryByText(/Task status: completed/)).not.toBeInTheDocument();
});
test('unstarted cancellation sends only bound digest and never claims or completes',async()=>{
  vi.mocked(authenticatedFetch).mockImplementation(async(_url,options)=>new Response(JSON.stringify({result:options?.method==='POST'?{state:'cancelled'}:[{id:'request',inputDigest:'a'.repeat(64),state:'pending',reviewScope:{kind:'task_final',includesTaskCriteria:true},session:{state:'not-started'}}]})));
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><NativeReviewPanel taskId="task" status="review"/></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Cancel unstarted review'}));
  await waitFor(()=>expect(vi.mocked(authenticatedFetch).mock.calls.some(([url,options])=>String(url).endsWith('/request/cancel') && options?.method==='POST' && options.body===JSON.stringify({inputDigest:'a'.repeat(64)}))).toBe(true));
});

test('latest decision uses timestamp across legacy and native records even when native verdict details are restricted',()=>{
  const legacy={id:'legacy',decision:'reject',createdAt:'2026-09-27T10:00:00.000Z',completedAt:'2026-09-27T10:01:00.000Z'};
  const native={id:'native',state:'passed',serviceId:'service',verifierPrincipalId:'verifier',createdAt:'2026-09-27T10:02:00.000Z',finishedAt:'2026-09-27T10:03:00.000Z',verdict:null,session:{state:'restricted'}};
  expect(latestTaskReviewDecision([legacy] as any,[native])).toBe('pass (native verification)');
  expect(latestTaskReviewDecision([{...legacy,completedAt:'2026-09-27T10:04:00.000Z'}] as any,[native])).toBe('reject');
  expect(latestTaskReviewDecision([],[])).toBe('None');
  expect(latestTaskReviewDecision([], [{...native,state:'pending'}])).toBe('None');
  expect(latestTaskReviewDecision([], [{...native,finishedAt:null}])).toBe('Unavailable; decision time missing');
});

test('redacted completed request shows state without leaking or inventing verdict details',async()=>{
  vi.mocked(authenticatedFetch).mockResolvedValue(new Response(JSON.stringify({result:[{id:'request',state:'passed',finishedAt:'2026-09-27T10:03:00.000Z',session:{state:'restricted'},verdict:null}]})));
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><NativeReviewPanel taskId="task" status="completed"/></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Evidence details restricted.')).toBeInTheDocument();
  expect(screen.getByText(/Verification passed/)).toBeInTheDocument();
  expect(screen.queryByRole('link',{name:'Review evidence'})).not.toBeInTheDocument();
});
