// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ArchiveMotionPlane, archiveDriftDuration, type ArchiveMotionTarget } from './ArchiveMotionPlane';

const variable = '--map-archive-duration';
let intermediate: Record<string, {x:number;y:number;scale?:number}>;
let reads: string[];
let commits: {id:string;left:string;duration:string}[];
const target=(id='task',x=0,archived=false,owner=id,scale=1):ArchiveMotionTarget=>({id,owner,x,y:0,scale,archived});
function Example({targets,scale=1,enabled=true}:{targets:ArchiveMotionTarget[];scale?:number;enabled?:boolean}) {
 return <ArchiveMotionPlane data-testid="plane" data-test-scale={scale}
   motionTargets={targets} motionScale={scale} motionEnabled={enabled}>
   {targets.map(t=><div key={t.id} data-map-motion-id={t.id}
     className={t.archived?'map-archive-motion':''}
     style={{left:t.x,top:t.y,width:170,height:120,transform:`scale(${t.scale})`}}
     ref={e=>{if(e)commits.push({id:t.id,left:e.style.left,duration:e.style.getPropertyValue(variable)});}} />)}
 </ArchiveMotionPlane>;
}
beforeEach(()=>{
 intermediate={};reads=[];commits=[];
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
  const id=this.dataset.mapMotionId;
  if(!id)return {x:100,y:50,left:100,top:50,right:100,bottom:50,width:0,height:0,toJSON(){}};
  reads.push(`${id}:${this.style.left}`);
  const plane=this.parentElement!, zoom=Number(plane.dataset.testScale);
  const current=intermediate[id]??{x:parseFloat(this.style.left),y:parseFloat(this.style.top),scale:Number(this.style.transform.match(/scale\((.*)\)/)?.[1]??1)};
  const x=100+current.x*zoom,y=50+current.y*zoom,w=170*(current.scale??1)*zoom,h=120*(current.scale??1)*zoom;
  return {x,y,left:x,top:y,right:x+w,bottom:y+h,width:w,height:h,toJSON(){}};
 });
 vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(170);
 vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(120);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

test('duration has explicit zero, short, measured travel and finite cap policies',()=>{
 expect(archiveDriftDuration(0)).toBe(0);
 expect(archiveDriftDuration(10)).toBe(1000);
 expect(archiveDriftDuration(1194)).toBe(7462.5);
 expect(archiveDriftDuration(100000)).toBe(12000);
 for(const d of [NaN,Infinity,-10])expect(archiveDriftDuration(d)).toBe(0);
});
test('initial archived mount and reload have no previous-motion replay',()=>{
 const r=render(<Example targets={[target('task',1200,true)]}/>);
 expect(r.container.querySelector('[data-map-motion-id]')!.getAttribute('style')).not.toContain(variable);
 r.unmount();render(<Example targets={[target('task',1200,true)]}/>);
 expect(reads).toEqual([]);expect(commits.every(c=>c.duration==='')).toBe(true);
});
test('duration is installed while old positions remain, before destination refs measure',()=>{
 const r=render(<Example targets={[target()]}/>);commits=[];
 r.rerender(<Example targets={[target('task',1194,true)]}/>);
 expect(reads).toEqual(['task:0px']);
 expect(commits).toEqual([{id:'task',left:'1194px',duration:'7462.5ms'}]);
});
test('batch reads precede writes and real owner groups synchronize task and pills',()=>{
 const r=render(<Example targets={[target(),target('pill',20,false,'task'),target('foreign',30)]}/>);
 const order:string[]=[];
 const get=HTMLElement.prototype.getBoundingClientRect;
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){order.push('read');return get.call(this);});
 const set=CSSStyleDeclaration.prototype.setProperty;
 vi.spyOn(CSSStyleDeclaration.prototype,'setProperty').mockImplementation(function(this:CSSStyleDeclaration,key:string,value:string|null,priority?:string){if(key===variable)order.push('write');return set.call(this,key,value,priority);});
 r.rerender(<Example targets={[target('task',160,true),target('pill',500,true,'task'),target('foreign',30)]}/>);
 const el=(id:string)=>r.container.querySelector<HTMLElement>(`[data-map-motion-id="${id}"]`)!;
 expect(el('task').style.getPropertyValue(variable)).toBe('3000ms');
 expect(el('pill').style.getPropertyValue(variable)).toBe('3000ms');
 expect(el('foreign').style.getPropertyValue(variable)).toBe('');
 expect(order.slice(order.indexOf('write'))).not.toContain('read');
});
test('unchanged rerender and camera-only zoom preserve active timing without geometry reads',()=>{
 const r=render(<Example targets={[target()]}/>);
 r.rerender(<Example targets={[target('task',1000,true)]}/>);reads=[];
 r.rerender(<Example targets={[target('task',1000,true)]} scale={2}/>);
 r.rerender(<Example targets={[target('task',1000,true)]} scale={2}/>);
 expect(reads).toEqual([]);
 expect(r.container.querySelector<HTMLElement>('[data-map-motion-id]')!.style.getPropertyValue(variable)).toBe('6250ms');
});
test('interrupted destination measures current interpolated ink rather than old final target',()=>{
 const r=render(<Example targets={[target()]}/>);
 r.rerender(<Example targets={[target('task',1000,true)]}/>);
 intermediate.task={x:200,y:0};
 r.rerender(<Example targets={[target('task',1200,true)]}/>);
 expect(commits.at(-1)?.duration).toBe('6250ms'); //1000px remaining, not200px
});
test('status reversal removes archive timing before live target commit',()=>{
 const r=render(<Example targets={[target()]}/>);
 r.rerender(<Example targets={[target('task',1000,true)]}/>);
 intermediate.task={x:200,y:0};
 r.rerender(<Example targets={[target('task',0,false)]}/>);
 expect(commits.at(-1)).toEqual({id:'task',left:'0px',duration:''});
 expect(r.container.querySelector('[data-map-motion-id]')!.className).toBe('');
});
test('camera scale uses one world frame and archive scale includes moving far corner',()=>{
 const r=render(<Example targets={[target()]} scale={0.5}/>);
 r.rerender(<Example targets={[target('task',640,true)]} scale={0.5}/>);
 expect(commits.at(-1)?.duration).toBe('2000ms');
 intermediate.task={x:640,y:0,scale:1};
 r.rerender(<Example targets={[target('task',640,true,'task',3)]} scale={0.5}/>);
 expect(Number(commits.at(-1)!.duration.replace('ms',''))).toBeCloseTo(Math.hypot(340,240)*0.5/160*1000);
});
test('newly mounted pill has no invented previous location or replay',()=>{
 const r=render(<Example targets={[target('task',1000,true)]}/>);
 r.rerender(<Example targets={[target('task',1000,true),target('pill',1020,true,'task')]}/>);
 expect(reads).toEqual([]);expect(commits.at(-1)?.duration).toBe('');
});
test('mixed translation and scale uses all four displacement corners',()=>{
 const r=render(<Example targets={[target()]}/>);
 r.rerender(<Example targets={[{...target('task',-170,true,'task',2),y:120}]}/>);
 expect(Number(commits.at(-1)!.duration.replace('ms',''))).toBeCloseTo(Math.hypot(170,240)/160*1000);
});
test('leaving Organic clears overrides and unmount has no timer or animation queue',()=>{
 const timeout=vi.spyOn(window,'setTimeout');
 const r=render(<Example targets={[target()]}/>);
 r.rerender(<Example targets={[target('task',1000,true)]}/>);
 r.rerender(<Example targets={[target('task',1000,true)]} enabled={false}/>);
 expect(commits.at(-1)?.duration).toBe('');r.unmount();
 expect(timeout).not.toHaveBeenCalled();
});
test('archive duration has a finite fallback, linear movement, independent opacity and last reduced-motion override',()=>{
 const css=readFileSync('src/components/map/MapView.css','utf8');
 const last=css.slice(css.lastIndexOf('/* Archive report controls'));
 expect(last).toContain('var(--map-archive-duration, 1000ms) linear');
 expect(last).toContain('opacity var(--transition-base) var(--ease-out)');
 expect(last.indexOf('@media (prefers-reduced-motion: reduce)')).toBeGreaterThan(last.indexOf('transition: transform'));
 expect(last).toContain('.map-plane--branched .map-archive-motion { transition: none; }');
});
