// @vitest-environment jsdom
import { StrictMode, type PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useMapData } from './useMapData';
import { fetchMapGraph, type MapGraphResponse } from './mapGraphApi';
vi.mock('./mapGraphApi',()=>({fetchMapGraph:vi.fn()}));
const socket=vi.hoisted(()=>({handlers:new Map<string,(value:unknown)=>void>(),subscribe:(name:string,fn:(value:unknown)=>void)=>{socket.handlers.set(name,fn);return()=>socket.handlers.delete(name)}}));
vi.mock('../../hooks/useWebSocket',()=>({useWebSocket:()=>({subscribe:socket.subscribe,connected:false})}));
const fetcher=vi.mocked(fetchMapGraph),clients:QueryClient[]=[];
const graph=(id:string,time='2026-10-07T03:00:00Z'):MapGraphResponse=>({nodes:[{id,title:id,status:'todo',priority:'normal',project:null,phaseId:null,updated:time}],edges:[],phases:[],reports:[],fullCount:1,generatedAt:time});
function deferred(){let resolve!:(value:MapGraphResponse)=>void,reject!:(reason:Error)=>void;const promise=new Promise<MapGraphResponse>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
function client(){const c=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(c);return c;}
function mount(c=client(),strict=false){const query={};return renderHook(()=>useMapData(query),{wrapper:({children}:PropsWithChildren)=> <QueryClientProvider client={c}>{strict?<StrictMode>{children}</StrictMode>:children}</QueryClientProvider>});}
function event(name:string,value:unknown={}){act(()=>socket.handlers.get(name)?.(value));}
beforeEach(()=>{fetcher.mockReset();socket.handlers.clear()});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.clear())});

test('authority invalidation cannot relabel cached graph or websocket patches as a new read',async()=>{
 fetcher.mockResolvedValueOnce(graph('old'));const h=mount();await waitFor(()=>expect(h.result.current.graph.nodes[0]?.id).toBe('old'));
 const fresh=deferred();fetcher.mockReturnValue(fresh.promise);event('project.authority_changed');
 await waitFor(()=>expect(h.result.current.graph.nodes).toEqual([]));expect(h.result.current.authorityReady).toBe(false);
 event('task.updated',{task:{...graph('old').nodes[0],title:'stale patch'}});expect(h.result.current.graph.nodes).toEqual([]);
 await act(async()=>fresh.resolve(graph('allowed')));await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));expect(h.result.current.graph.nodes[0].id).toBe('allowed');
});

test('late old whole read cannot restore data after a newer authority result',async()=>{
 const old=deferred(),fresh=deferred();fetcher.mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise);const h=mount();await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
 event('project.authority_changed');await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
 await act(async()=>fresh.resolve(graph('allowed')));await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));
 await act(async()=>old.resolve(graph('revoked')));expect(h.result.current.graph.nodes.map(n=>n.id)).toEqual(['allowed']);
});

test('failed current authority read remains empty and unqualified',async()=>{
 fetcher.mockResolvedValueOnce(graph('old'));const h=mount();await waitFor(()=>expect(h.result.current.graph.nodes).toHaveLength(1));
 fetcher.mockRejectedValue(new Error('Forbidden'));event('project.authority_changed');await waitFor(()=>expect(h.result.current.error?.message).toBe('Forbidden'));
 expect(h.result.current.authorityReady).toBe(false);expect(h.result.current.graph.nodes).toEqual([]);
 event('task.updated',{task:{...graph('old').nodes[0],title:'cannot restore'}});expect(h.result.current.graph.nodes).toEqual([]);
});

test('remount never reuses an earlier mount authority snapshot',async()=>{
 const c=client();fetcher.mockResolvedValueOnce(graph('old'));const old=mount(c);await waitFor(()=>expect(old.result.current.graph.nodes).toHaveLength(1));old.unmount();
 const fresh=deferred();fetcher.mockReturnValue(fresh.promise);const h=mount(c);expect(h.result.current.graph.nodes).toEqual([]);expect(h.result.current.authorityReady).toBe(false);
 await act(async()=>fresh.resolve(graph('new')));await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));expect(h.result.current.graph.nodes[0].id).toBe('new');
});

test('StrictMode remount and repeated authority epochs retain only the active cache',async()=>{
 const c=client();fetcher.mockImplementation(async()=>graph('allowed'));const h=mount(c,true);await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));
 for(let i=0;i<3;i++){event('project.authority_changed');await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));}
 await waitFor(()=>expect(c.getQueryCache().findAll({queryKey:['map-graph']})).toHaveLength(1));expect(h.result.current.graph.nodes[0].id).toBe('allowed');
});

test('ordinary metadata patches and deletions preserve the admitted read',async()=>{
 fetcher.mockResolvedValue(graph('task'));const h=mount();await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));const count=fetcher.mock.calls.length;
 event('task.updated',{task:{...graph('task').nodes[0],title:'Current title',activeAgent:{name:'Current agent'},subtasks:[{status:'completed'}]}});
 await waitFor(()=>expect(h.result.current.graph.nodes[0].title).toBe('Current title'));expect(h.result.current.graph.nodes[0]).toMatchObject({agent:null,progress:{done:1,total:1}});expect(h.result.current.authorityReady).toBe(true);expect(fetcher.mock.calls).toHaveLength(count);
 event('task.deleted',{id:'task'});await waitFor(()=>expect(h.result.current.graph.nodes).toEqual([]));expect(h.result.current.authorityReady).toBe(true);
});

test('old manual delta cannot overwrite the new graph or its sync timestamp',async()=>{
 const oldDelta=deferred(),fresh=deferred();const current=graph('allowed','2026-10-07T03:05:00Z');
 fetcher.mockResolvedValueOnce(graph('old')).mockReturnValueOnce(oldDelta.promise).mockReturnValueOnce(fresh.promise).mockResolvedValue(current);
 const h=mount();await waitFor(()=>expect(h.result.current.graph.nodes).toHaveLength(1));event('tasks.updated');await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
 event('project.authority_changed');await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(3));await act(async()=>fresh.resolve(current));await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));
 await act(async()=>oldDelta.resolve(graph('revoked','2026-10-07T03:01:00Z')));expect(h.result.current.graph.nodes.map(n=>n.id)).toEqual(['allowed']);
 event('tasks.updated');await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(4));expect(fetcher.mock.calls[3][1]).toBe(current.generatedAt);
});

test('failed background whole read cannot be rehabilitated by a socket patch',async()=>{
 const c=client();fetcher.mockResolvedValueOnce(graph('old'));const h=mount(c);
 await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));
 fetcher.mockRejectedValueOnce(new Error('Forbidden'));
 await act(async()=>{await c.invalidateQueries({queryKey:['map-graph']})});
 await waitFor(()=>expect(h.result.current.authorityReady).toBe(false));
 event('task.updated',{task:{...graph('old').nodes[0],title:'stale'}});
 expect(h.result.current.graph.nodes).toEqual([]);
 fetcher.mockResolvedValueOnce(graph('allowed'));
 event('tasks.updated');await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));
 expect(fetcher.mock.calls[2][1]).toBeUndefined();
 expect(h.result.current.graph.nodes.map(n=>n.id)).toEqual(['allowed']);
});

test('same-epoch background read retains admission during parent renders and revokes it on failure',async()=>{
 const c=client();fetcher.mockResolvedValueOnce(graph('admitted'));const h=mount(c);
 await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));
 const pending=deferred();fetcher.mockReturnValueOnce(pending.promise);
 await act(async()=>{void c.invalidateQueries({queryKey:['map-graph']});});h.rerender();
 expect(h.result.current.authorityReady).toBe(true);expect(h.result.current.graph.nodes[0].id).toBe('admitted');
 await act(async()=>pending.reject(new Error('Forbidden')));
 await waitFor(()=>expect(h.result.current.authorityReady).toBe(false));expect(h.result.current.graph.nodes).toEqual([]);
 event('task.updated',{task:graph('admitted').nodes[0]});expect(h.result.current.graph.nodes).toEqual([]);
});

test('authority change during retained background refresh clears immediately and rejects its late response',async()=>{
 const c=client();fetcher.mockResolvedValueOnce(graph('old'));const h=mount(c);
 await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));
 const background=deferred(),fresh=deferred();fetcher.mockReturnValueOnce(background.promise).mockReturnValueOnce(fresh.promise);
 await act(async()=>{void c.invalidateQueries({queryKey:['map-graph']});});h.rerender();expect(h.result.current.authorityReady).toBe(true);
 event('project.authority_changed');expect(h.result.current.graph.nodes).toEqual([]);expect(h.result.current.authorityReady).toBe(false);
 await act(async()=>background.resolve(graph('revoked')));expect(h.result.current.graph.nodes).toEqual([]);
 await act(async()=>fresh.resolve(graph('current')));await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));expect(h.result.current.graph.nodes[0].id).toBe('current');
});

test.each(['metadata','deletion'] as const)('background whole read cannot overwrite a later %s event',async kind=>{
 const c=client();fetcher.mockResolvedValueOnce(graph('known'));const h=mount(c);await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));
 const stale=deferred(),current=deferred();fetcher.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
 await act(async()=>{void c.invalidateQueries({queryKey:['map-graph']});});h.rerender();
 if(kind==='metadata')event('task.updated',{task:{...graph('known').nodes[0],title:'New metadata'}});else event('task.deleted',{id:'known'});
 await waitFor(()=>expect(kind==='metadata'?h.result.current.graph.nodes[0]?.title:h.result.current.graph.nodes.length).toBe(kind==='metadata'?'New metadata':0));
 await act(async()=>stale.resolve(graph('known')));
 await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(3));
 expect(kind==='metadata'?h.result.current.graph.nodes[0]?.title:h.result.current.graph.nodes.length).toBe(kind==='metadata'?'New metadata':0);
 const final=graph('known');if(kind==='metadata')final.nodes[0].title='New metadata';else{final.nodes=[];final.fullCount=0;}
 await act(async()=>current.resolve(final));await waitFor(()=>expect(h.result.current.generatedAt).toBe(final.generatedAt));
 expect(kind==='metadata'?h.result.current.graph.nodes[0]?.title:h.result.current.graph.nodes.length).toBe(kind==='metadata'?'New metadata':0);
 expect(fetcher.mock.calls[2][1]).toBeUndefined();
});

test('debounce during retained whole refresh cannot launch a concurrent delta',async()=>{
 const c=client();fetcher.mockResolvedValueOnce(graph('known'));const h=mount(c);await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));
 const stale=deferred(),current=deferred();fetcher.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
 await act(async()=>{void c.invalidateQueries({queryKey:['map-graph']});});event('tasks.updated');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,350))});
 expect(fetcher).toHaveBeenCalledTimes(2);expect(h.result.current.authorityReady).toBe(true);
 await act(async()=>stale.resolve(graph('known')));await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(3));
 expect(fetcher.mock.calls[2][1]).toBeUndefined();await act(async()=>current.resolve(graph('fresh')));
 await waitFor(()=>expect(h.result.current.graph.nodes[0].id).toBe('fresh'));
});

test('explicit refresh waits for a new whole read',async()=>{
 fetcher.mockResolvedValueOnce(graph('old'));const h=mount();
 await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));
 const next=deferred();fetcher.mockReturnValueOnce(next.promise);
 act(()=>h.result.current.refetch());
 expect(h.result.current.authorityReady).toBe(false);expect(h.result.current.graph.nodes).toEqual([]);
 await act(async()=>next.resolve(graph('allowed')));
 await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));
 expect(h.result.current.graph.nodes.map(n=>n.id)).toEqual(['allowed']);
});

test.each(['task.created','task.updated','task.deleted'])('%s during a whole read requires a subsequent snapshot',async name=>{
 const old=deferred(),fresh=deferred();fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
 const h=mount();await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
 event(name,{id:'old',task:{...graph('old').nodes[0],title:'changed'}});
 // The debounce must not start a competing whole read while React Query owns one.
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,350))});
 expect(fetcher).toHaveBeenCalledTimes(1);
 await act(async()=>old.resolve(graph('old')));await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
 expect(h.result.current.authorityReady).toBe(false);expect(h.result.current.graph.nodes).toEqual([]);
 await act(async()=>fresh.resolve(graph('allowed')));await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));
 expect(h.result.current.graph.nodes.map(n=>n.id)).toEqual(['allowed']);
});

test('failed in-flight whole read cannot revoke a newer admission from a competing delta',async()=>{
 const old=deferred();fetcher.mockReturnValueOnce(old.promise);const h=mount();
 await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));event('tasks.updated');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,350))});expect(fetcher).toHaveBeenCalledTimes(1);
 await act(async()=>old.reject(new Error('old failure')));await waitFor(()=>expect(h.result.current.error?.message).toBe('old failure'));
 fetcher.mockResolvedValueOnce(graph('allowed'));event('tasks.updated');
 await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));expect(fetcher).toHaveBeenCalledTimes(2);
 expect(h.result.current.graph.nodes.map(n=>n.id)).toEqual(['allowed']);
});

test('continuous socket traffic has bounded admission reads and supports explicit retry',async()=>{
 const reads=[deferred(),deferred(),deferred()];
 for(const read of reads)fetcher.mockReturnValueOnce(read.promise);
 const h=mount();
 for(let i=0;i<reads.length;i++){
  await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(i+1));
  event('tasks.updated');await act(async()=>reads[i].resolve(graph('contested-'+i)));
  expect(h.result.current.authorityReady).toBe(false);expect(h.result.current.graph.nodes).toEqual([]);
 }
 await waitFor(()=>expect(h.result.current.error?.message).toContain('Retry'));
 event('tasks.updated');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,350))});
 expect(fetcher).toHaveBeenCalledTimes(3);
 fetcher.mockResolvedValueOnce(graph('settled'));act(()=>h.result.current.refetch());
 await waitFor(()=>expect(h.result.current.authorityReady).toBe(true));expect(fetcher).toHaveBeenCalledTimes(4);
 expect(h.result.current.graph.nodes.map(n=>n.id)).toEqual(['settled']);
});
