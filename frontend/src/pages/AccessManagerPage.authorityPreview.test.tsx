// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
const fake = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../utils/auth', () => ({ authenticatedFetch: fake.fetch, auth: {getToken:()=> 'fixture'} }));
import { InventoryPanel } from './AccessManagerPage';
const identity='11111111-1111-4111-8111-111111111111';
const omitted='ffffffff-ffff-4fff-bfff-ffffffffffff';
const foreign='eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee';
const object='22222222-2222-4222-8222-222222222222';
const history=Array.from({length:50},(_,i)=>({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,live:false,transport:'mcp'}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(){
 const surface=vi.fn();
 fake.fetch.mockImplementation(async (url:string)=>{
   const query=new URL(url,'http://fixture').searchParams, credential=query.get('credentialId');
   if(credential===foreign)return {ok:false,status:404,json:async()=>({error:'Credential not found for this identity'})};
   return {ok:true,status:200,json:async()=>({access:{grants:[],profiles:[],credentials:history,credentialsTruncated:true,
     needsCredential:!credential,envelope:{alive:credential===omitted,transport:'mcp',scopes:['tasks:read']},
     resources:credential===omitted?[{id:object,actions:[{action:'read',sources:['initiator']}]}]:[]}})};
 });
 render(<InventoryPanel principals={[{id:identity,kind:'service',handle:'fixture',status:'active'} as any]} surface={surface}/>);
 fireEvent.change(screen.getByLabelText('Identity to inspect'),{target:{value:identity}});
 return surface;
}
test('omitted live key can be selected by exact UUID without enlarging the bounded history list',async()=>{
 mount();await screen.findByText(/Only the first 50 credentials/);
 expect(screen.getByLabelText('Preview credential').querySelectorAll('option')).toHaveLength(51);
 fireEvent.change(screen.getByLabelText('Exact preview credential ID'),{target:{value:omitted}});
 fireEvent.click(screen.getByRole('button',{name:'Inspect credential'}));
 await screen.findByText(object);expect(screen.getByText('Created or initiated')).toBeTruthy();
 const query=new URL(fake.fetch.mock.calls.at(-1)![0],'http://fixture').searchParams;
 expect(query.get('principalId')).toBe(identity);expect(query.get('credentialId')).toBe(omitted);
 expect(query.get('limit')).toBe('20');expect(screen.getByLabelText('Preview credential')).toHaveProperty('value',omitted);
 fireEvent.change(screen.getByLabelText('Preview credential'),{target:{value:history[0].id}});
 await screen.findByText(/Authority: inactive/);expect(screen.queryByRole('table')).toBeNull();
});
test('invalid ID never queries and foreign refusal clears permission rows',async()=>{
 const surface=mount();await screen.findByText(/Only the first 50 credentials/);const before=fake.fetch.mock.calls.length;
 fireEvent.change(screen.getByLabelText('Exact preview credential ID'),{target:{value:'invalid'}});
 fireEvent.click(screen.getByRole('button',{name:'Inspect credential'}));expect(fake.fetch.mock.calls).toHaveLength(before);
 expect(surface).toHaveBeenCalledWith('error','Enter an exact credential UUID.');
 fireEvent.change(screen.getByLabelText('Exact preview credential ID'),{target:{value:foreign}});
 fireEvent.click(screen.getByRole('button',{name:'Inspect credential'}));
 await waitFor(()=>expect(surface).toHaveBeenCalledWith('error','Credential not found for this identity'));
 expect(screen.queryByRole('table')).toBeNull();
});
