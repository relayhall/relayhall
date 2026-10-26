// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,expect,test,vi} from 'vitest';
import {SessionsPage} from './SessionsPage';
import {fetchPresence,fetchSessions,fetchSession} from '../utils/telemetryProjection';
vi.mock('../utils/telemetryProjection',async original=>({...await original<object>(),fetchPresence:vi.fn(),fetchSessions:vi.fn(),fetchSession:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function show(search:string){
  vi.mocked(fetchPresence).mockResolvedValue({sources:[]} as any);vi.mocked(fetchSessions).mockResolvedValue({sessions:[]} as any);
  return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={['/sessions'+search]}><SessionsPage/></MemoryRouter></QueryClientProvider>);
}
const key={connectorId:'11111111-1111-4111-8111-111111111111',sourceProduct:'claude-code',sessionRef:'rhp_abcdefghijklmnopqrstuvwx123'};
test('full triple link reads its exact session even outside the recent list',async()=>{
  vi.mocked(fetchSession).mockResolvedValue({session:{...key},events:[],truncated:false} as any);
  show('?'+new URLSearchParams(key));
  expect(await screen.findByRole('region',{name:'Linked native session'})).toBeInTheDocument();
  expect(fetchSession).toHaveBeenCalledWith(key);
});
test('partial identity never queries an ambiguous session',async()=>{
  show('?sessionRef='+key.sessionRef);
  expect(await screen.findByText(/requires its full Connector/)).toBeInTheDocument();expect(fetchSession).not.toHaveBeenCalled();
});
test('refused session is unavailable rather than an invented empty timeline',async()=>{
  vi.mocked(fetchSession).mockRejectedValue(new Error('restricted'));show('?'+new URLSearchParams(key));
  expect(await screen.findByText('Linked native session is restricted, expired or unavailable.')).toBeInTheDocument();
  expect(screen.queryByRole('region',{name:'Linked native session'})).not.toBeInTheDocument();
});
