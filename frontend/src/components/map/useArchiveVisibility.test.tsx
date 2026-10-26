// @vitest-environment jsdom
import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {useArchiveVisibility,ARCHIVE_VISIBILITY_MS} from './useArchiveVisibility';
import type {PlacedTile,PlacedReportPill} from './mapGraphModel';
const tile=(x=100,status='archived')=>({kind:'tile',id:'owner',x,y:100,w:170,h:100,node:{id:'owner',status},depth:0,laneId:'lane',bandId:null}) as PlacedTile;
const pill=(x=100)=>({kind:'pill',id:'pill',taskId:'owner',x,y:40,w:36,h:36}) as PlacedReportPill;
type Input={tiles:PlacedTile[];inside:Set<string>;pills:PlacedReportPill[];scope:string;enabled:boolean};
const input=(x=100):Input=>({tiles:[tile(x)],inside:new Set(x>=0?['owner']:[]),pills:[pill(x)],scope:'authority1',enabled:true});
const run=(initial=input())=>renderHook((p:Input)=>useArchiveVisibility(p.tiles,p.inside,p.pills,undefined,p.scope,p.enabled),{initialProps:initial});
let media:{matches:boolean;addEventListener:ReturnType<typeof vi.fn>;removeEventListener:ReturnType<typeof vi.fn>};
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});media={matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()};vi.stubGlobal('matchMedia',()=>media);});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
const advance=(ms:number)=>act(()=>vi.advanceTimersByTime(ms));
test('initial offscreen owner is never admitted, but a committed owner remains during travel',()=>{
 const a=run(input(-1200));expect(a.result.current).toEqual([]);a.unmount();
 const b=run();b.rerender(input(-1200));expect(b.result.current[0].x).toBe(-1200);
 advance(ARCHIVE_VISIBILITY_MS+2);expect(b.result.current).toEqual([]);
});
test('unrelated renders cannot extend expiry and an interrupted destination has its own bound',()=>{
 const r=run();r.rerender(input(-1200));advance(6000);
 r.rerender({...input(-1200)});advance(6202);expect(r.result.current).toEqual([]);
 r.rerender(input());r.rerender(input(-1200));advance(6000);
 r.rerender(input(-1600));advance(6202);expect(r.result.current).toHaveLength(1);
 advance(6000);expect(r.result.current).toEqual([]);
});
test.each(['scope','disabled','deletion','live','lod'])('%s immediately removes retention and cannot resurrect it',kind=>{
 const r=run();r.rerender(input(-1200));expect(r.result.current).toHaveLength(1);
 const next=input(-1200);
 if(kind==='scope')next.scope='authority2';
 if(kind==='disabled')next.enabled=false;
 if(kind==='deletion'||kind==='lod')next.tiles=[];
 if(kind==='live')next.tiles=[tile(-1200,'todo')];
 r.rerender(next);expect(r.result.current).toEqual([]);
 r.rerender(input(-1200));expect(r.result.current).toEqual([]);
});
test('retained data always comes from current membership, never an old node',()=>{
 const r=run();r.rerender(input(-1200));const next=input(-1200);
 next.tiles[0].node={...next.tiles[0].node,title:'Current authorized title'};
 r.rerender(next);expect(r.result.current[0]).toBe(next.tiles[0]);
});
test('a report-only destination change renews its owner group, but ordering does not',()=>{
 const r=run();r.rerender(input(-1200));advance(6000);
 const next=input(-1200);next.pills=[pill(-1600)];r.rerender(next);
 advance(6202);expect(r.result.current).toHaveLength(1);advance(6000);expect(r.result.current).toEqual([]);
 const p1=pill(),p2={...pill(),id:'pill2'};
 const b=run({...input(),pills:[p1,p2]});b.rerender({...input(-1200),pills:[p1,p2]});advance(6000);
 b.rerender({...input(-1200),pills:[p2,p1]});advance(6202);expect(b.result.current).toEqual([]);
});
test('reduced motion disables retention at mount and on a later preference change',()=>{
 media.matches=true;const a=run();a.rerender(input(-1200));expect(a.result.current).toEqual([]);a.unmount();
 media.matches=false;const b=run();b.rerender(input(-1200));expect(b.result.current).toHaveLength(1);
 act(()=>{media.matches=true;media.addEventListener.mock.calls.at(-1)![1]();});expect(b.result.current).toEqual([]);
});
test('an old expiry callback cannot affect a new commit; unmount cancels timers and media subscription',()=>{
 const timers=vi.spyOn(window,'setTimeout'),r=run();r.rerender(input(-1200));
 const stale=timers.mock.calls.at(-1)![0] as ()=>void;
 r.rerender(input(-1600));act(()=>stale());expect(r.result.current[0].x).toBe(-1600);
 r.unmount();expect(vi.getTimerCount()).toBe(0);expect(media.removeEventListener).toHaveBeenCalled();
});

test('a delayed commit receives the full retention duration after CSS can begin',()=>{
 let clock=0,delayCommit=false;vi.spyOn(performance,'now').mockImplementation(()=>clock);
 const r=renderHook((p:Input)=>{
   const visible=useArchiveVisibility(p.tiles,p.inside,p.pills,undefined,p.scope,p.enabled);
   // Controlled time gap after hook render, before its layout effect commits.
   if(delayCommit){clock=5000;delayCommit=false;}return visible;
 },{initialProps:input()});
 delayCommit=true;r.rerender(input(-1200));
 clock=12202;advance(7202);expect(r.result.current).toHaveLength(1);
 clock=17202;advance(5000);expect(r.result.current).toEqual([]);
});
