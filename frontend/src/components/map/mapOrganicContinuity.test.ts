import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as m from './mapPlaneModel';
import { placeArchiveCore } from './mapOrganicCore';
import type { PlaneLayoutResult } from './mapPlaneModel';
import type { Box, MapGraph, PlacedElement, PlacedTile } from './mapGraphModel';
import fixture from './__fixtures__/organic-density.json';
// Synthetic248-task/10-phase fixture from the source-pinned visual regression.
//
// E386 round 2 (review B2) changed the contract several of these pinned:
// Organic keeps no home, cell, angle or archive core from one layout to the
// next, because a region or core that kept the ground it took while the
// archive was shown would never shrink back. Every test whose premise was a
// RETAINED world is repaired by name below and says what replaced it: the
// world is laid out from what is shown (and the lattice from the session's
// order), so going back to a scope gives back that scope's world exactly,
// and the archive core is as big as the archive that is shown.
const graph=fixture as unknown as MapGraph;
// The record as it crosses the worker boundary. E386 retired persistence and
// the parser that read a stored record; the in-memory record is what a reload
// test can still mean within one session.
const clone=(anchors:m.MapPlaneAnchors)=>JSON.parse(JSON.stringify(anchors)) as m.MapPlaneAnchors;
const initial=m.layoutOrganicPlane(graph,{});
const ids=new Set(graph.nodes.filter(n=>['phase0','phase1','phase2'].includes(n.phaseId??'')).map(n=>n.id));
const changed={...graph,nodes:graph.nodes.map(n=>ids.has(n.id)?{...n,status:'archived' as const}:n)};
const next=m.layoutOrganicPlane(changed,{},initial.anchors);
const close=(a:number,b:number)=>Math.abs(a-b)<.01;
const ink=(l:PlaneLayoutResult)=>l.elements.filter(e=>e.kind==='tile'||e.kind==='pill');
const core=(l:PlaneLayoutResult)=>l.organicRegions!.find(r=>r.core)!.box;
const archived=(e:PlacedElement)=>e.kind==='tile'?ids.has(e.id):e.kind==='pill'&&ids.has(e.taskId);
const coords=(e:Box|undefined)=>{assert(e);return [e.x,e.y,e.w,e.h];};
const contains=(a:Box,b:Box)=>b.x>=a.x-.01&&b.y>=a.y-.01&&b.x+b.w<=a.x+a.w+.01&&b.y+b.h<=a.y+a.h+.01;

// Independent pre-indexing loop retained as a membership/order oracle. Do not
// derive expected ownership by splitting keys: saved owner names can contain NUL.
function originalForeign(homes:Record<string,Box>,local:Record<string,Box>,region:string) {
 const result:Array<{owner:string;box:Box}>=[];
 for(const [owner,home] of Object.entries(homes)) {
  if(owner===region)continue;
  if(owner===m.ORGANIC_CORE){result.push({owner,box:home});continue;}
  result.push({owner,box:{...home,w:Math.min(home.w,1024),h:m.PLANE_METRICS.captionHeaderH}});
  const origin=local[owner+'\0origin'];if(!origin)continue;
  for(const [key,box] of Object.entries(local))if(key.startsWith(owner+'\0')&&key!==owner+'\0origin')
   result.push({owner,box:{x:box.x+home.x+origin.x-24,y:box.y+home.y+origin.y-24,w:box.w+48,h:box.h+48}});
 }
 return result;
}

test('ordered routing inventory preserves nested owner prefixes, hidden and orphan cells exactly',()=>{
 const homes:Record<string,Box>={
  'A':{x:-80,y:40,w:1800,h:500},
  'A\0child':{x:700,y:-30,w:220,h:400},
  'AB':{x:1000,y:800,w:800,h:100},
  '2':{x:2000,y:800,w:140,h:100},
  [m.ORGANIC_CORE]:{x:-1500,y:-1600,w:1024,h:1024},
  'missing-origin':{x:9000,y:500,w:700,h:200},
 };
 const local:Record<string,Box>={
  'A\0hidden-phase':{x:-400,y:20,w:200,h:100},
  'A\0origin':{x:15,y:-25,w:0,h:0},
  'A\0child\0origin':{x:30,y:10,w:0,h:0},
  'A\0child\0orphan-task':{x:-55,y:-80,w:220,h:128},
  'AB\0origin':{x:0,y:0,w:0,h:0},
  'AB\0report':{x:15,y:20,w:220,h:44},
  '2\0origin':{x:7,y:9,w:0,h:0},
  '2\0task':{x:0,y:0,w:220,h:128},
  'missing-origin\0cell':{x:-900,y:3,w:400,h:500},
  'no-home\0orphan':{x:5,y:6,w:7,h:8},
 };
 const before=JSON.stringify({homes,local});
 const inventory=m.organicRoutingObstacles(homes,local);
 for(const region of [...Object.keys(homes),'absent']) {
  const actual=inventory.filter(v=>v.owner!==region);
  assert.deepEqual(actual,originalForeign(homes,local,region),region);
  assert.deepEqual(actual.filter(v=>v.owner!==m.ORGANIC_CORE),originalForeign(homes,local,region).filter(v=>v.owner!==m.ORGANIC_CORE));
 }
 assert.equal(JSON.stringify({homes,local}),before);
 assert(inventory.some(v=>v.owner==='A'&&v.box.x===-144),'NUL child cell also belongs to exact A prefix');
 assert.equal(inventory.filter(v=>v.owner==='missing-origin').length,1);
 assert(!inventory.some(v=>v.owner==='no-home'));
});

test('routing inventory matches the old loop after completion, filter return and signed archive relocation',()=>{
 for(const layout of [initial,next,m.layoutOrganicPlane(changed,{},next.anchors)]) {
  const homes=layout.anchors.organicHomes!,local=layout.anchors.organicLocal!;
  const inventory=m.organicRoutingObstacles(homes,local);
  for(const region of Object.keys(homes))assert.deepEqual(inventory.filter(v=>v.owner!==region),originalForeign(homes,local,region));
 }
});
test('actual75-circle-contains-every-archived-task-report-corner',()=>{
 // E386: no retained home keeps the world signed, so the core is not left of
 // the origin any more; the containment is the contract.
 const c=core(next),r=c.w/2,x=c.x+r,y=c.y+r;assert(close(c.w,c.h));
 for(const b of ink(next).filter(archived))for(const px of [b.x,b.x+b.w])for(const py of [b.y,b.y+b.h])assert((px-x)**2+(py-y)**2<=r*r+.1,b.id);
});
test('full-circle-clear-of-live-ink-captions-and-phase-ground',()=>{
 const c=core(next),r=c.w/2,x=c.x+r,y=c.y+r;
 const boxes=[...ink(next).filter(e=>!archived(e)),...next.organicRegions!.filter(r=>!r.core).flatMap(r=>[
  {...r.captionBox!,w:Math.min(r.captionBox!.w,1024),h:m.PLANE_METRICS.captionHeaderH},...r.clusters])];
 for(const b of boxes){const px=Math.max(b.x,Math.min(b.x+b.w,x)),py=Math.max(b.y,Math.min(b.y+b.h,y));assert((px-x)**2+(py-y)**2>=r*r-.1,'circle overlaps '+('id' in b?b.id:'ground'));}
});
// E386, superseding 'live-homes-and-task-report-world-positions-unchanged':
// archiving three phases grows the core, and the live world is laid out
// around it; un-archiving them gives the world back exactly.
test('archiving grows the core around which the live world is laid out; un-archiving returns the world',()=>{
 assert(core(next).w>core(initial).w);
 const fresh=m.layoutOrganicPlane(changed,{});
 assert.deepEqual(ink(next).map(coords),ink(fresh).map(coords));
 const back=m.layoutOrganicPlane(graph,{},next.anchors);
 for(const e of ink(initial))assert.deepEqual(coords(ink(back).find(n=>n.id===e.id)),coords(e),e.id);
 assert.deepEqual(back.organicRegions,initial.organicRegions);
 assert.equal(next.archiveDrift,false);
});
let replay:PlaneLayoutResult;
test('signed-core-parser-and-reload-fixed-point',()=>{
 const parsed=clone((next.anchors));assert.deepEqual(parsed.organicHomes![m.ORGANIC_CORE],next.anchors.organicHomes![m.ORGANIC_CORE]);
 replay=m.layoutOrganicPlane(changed,{},parsed);
 for(const e of ink(next))assert.deepEqual(coords(ink(replay).find(n=>n.id===e.id)),coords(e),e.id);
 assert.deepEqual(core(replay),core(next));assert.equal(replay.archiveDrift,false);
});
test('filter-away-and-return-preserves-archived-world',()=>{
 const hidden={...changed,nodes:changed.nodes.filter(n=>!ids.has(n.id))};
 const away=m.layoutOrganicPlane(hidden,{},next.anchors),back=m.layoutOrganicPlane(changed,{},away.anchors);
 for(const e of ink(next))assert.deepEqual(coords(ink(back).find(n=>n.id===e.id)),coords(e),e.id);
});
test('first-organic-world-already-archived-reload-is-fixed',()=>{
 const first=m.layoutOrganicPlane(changed,{}),again=m.layoutOrganicPlane(changed,{},clone((first.anchors)));
 for(const e of ink(first))assert.deepEqual(coords(ink(again).find(n=>n.id===e.id)),coords(e),e.id);
 assert.deepEqual(core(again),core(first));
});
test('signed-fit-and-routing-envelope-contain-all-painted-ink',()=>{
 // E386: the world is no longer signed (nothing retained keeps it left of the
 // origin); the fit and the world envelope must still contain all the ink.
 const fit=m.planeContentBounds(next.elements,next.organicRegions!.map(r=>r.box));assert(next.worldBounds);
 for(const b of [...ink(next),...next.organicRegions!.map(r=>r.box)]){assert(contains(fit,b));assert(contains(next.worldBounds,b));}
 const scale=Math.min((1877-64)/fit.w,(843-64)/fit.h),ox=(1877-fit.w*scale)/2-fit.x*scale,oy=(843-fit.h*scale)/2-fit.y*scale;
 for(const b of ink(next)){assert(b.x*scale+ox>=-.1);assert(b.y*scale+oy>=-.1);assert((b.x+b.w)*scale+ox<=1877.1);assert((b.y+b.h)*scale+oy<=843.1);}
});
// E386, superseding 'enclosed-core-compacts-only-archive-with-scaled-model-and-reload':
// retained foreign ground could enclose the core and force its archive to
// scale down. No ground is retained now, so a record carrying such homes and
// cells is ignored: the layout is the one of what is shown, at full scale.
test('a record carrying foreign Organic homes and cells around the core is ignored',()=>{
 const a=JSON.parse(JSON.stringify(initial.anchors)),c=core(initial);
 const walls=[{x:c.x-32,y:c.y-32,w:c.w+64,h:8},{x:c.x-32,y:c.y+c.h+24,w:c.w+64,h:8},{x:c.x-32,y:c.y-32,w:8,h:c.h+64},{x:c.x+c.w+24,y:c.y-32,w:8,h:c.h+64}];
 walls.forEach((box,i)=>{const id='enclosure-'+i,home={x:6000+i*2048,y:6000,w:220,h:128};a.organicHomes[id]=home;a.organicLocal[id+'\0origin']={x:0,y:0,w:0,h:0};a.organicLocal[id+'\0wall']={...box,x:box.x-home.x,y:box.y-home.y};});
 const walled=m.layoutOrganicPlane(changed,{},a),plain=m.layoutOrganicPlane(changed,{},initial.anchors);
 assert.deepEqual(walled,plain);
 assert(Object.values(walled.archiveScales!).every(s=>s===1));
});
// 'invalid-core-parser-preserves-unrelated-home' went with the parser (E386).
// E386, superseding 'occupied-core-recovery-preserves-live-homes-and-world':
// a retained core could stand over live work and had to be recovered. No core
// is retained now, so a record carrying one over live work is ignored.
test('a record carrying an archive core over live work is ignored',()=>{
 const a=JSON.parse(JSON.stringify(initial.anchors)),tile=ink(initial).find(e=>e.kind==='tile'&&!archived(e));
 a.organicHomes[m.ORGANIC_CORE]={x:tile!.x,y:tile!.y,w:1024,h:1024};
 const placed=m.layoutOrganicPlane(changed,{},a),plain=m.layoutOrganicPlane(changed,{},initial.anchors);
 assert.equal(placed.archiveRecovery,false);
 assert.deepEqual(placed,plain);
});

for(const box of [{x:0,y:0,w:16,h:16},{x:0,y:0,w:1024,h:512},{x:NaN,y:0,w:1024,h:1024}])test('invalid-core-refuses-'+String(box.w)+'-'+String(box.h)+'-'+String(box.x),()=>assert.throws(()=>placeArchiveCore(box,[],[],[]),RangeError));
test('occupied-old-core-recovers-clear-fixed-radius-and-replays',()=>{
 const old={x:0,y:0,w:1024,h:1024},obstacles=[{x:400,y:400,w:224,h:224}],retained=[{id:'old',x:180,y:300,w:32,h:32}],pending=[{id:'new',x:0,y:0,w:170,h:96}];
 const next=placeArchiveCore(old,retained,pending,obstacles),c=next.circle,r=c.w/2,cx=c.x+r,cy=c.y+r;
 assert.equal(next.recovered,true);assert.equal(c.w,old.w);assert.equal(c.h,old.h);
 for(const b of obstacles){const x=Math.max(b.x,Math.min(b.x+b.w,cx)),y=Math.max(b.y,Math.min(b.y+b.h,cy));assert((x-cx)**2+(y-cy)**2>=r*r);}
 for(const b of next.blocks){assert((b.scale??1)>0);for(const x of [b.x,b.x+b.w])for(const y of [b.y,b.y+b.h])assert((x-cx)**2+(y-cy)**2<=r*r+.001);}
 const replay=placeArchiveCore(c,next.blocks,[],obstacles);assert.deepEqual(replay.circle,c);assert.deepEqual(replay.blocks,next.blocks);assert.equal(replay.recovered,false);
});

// Retained regression counterexamples for local growth, rather than private-only scripts.
{
 const first=initial,run=test;
 const overlap=(a:Box,b:Box)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
 const project=graph.nodes[0].project!;
 const added={...graph,nodes:[...graph.nodes,{...graph.nodes[0],id:'new-phase-task',phaseId:'new-phase'}],phases:[...graph.phases,{...graph.phases[0],id:'new-phase',position:10}]};
 run('enclosed-retained-home-arrival-terminates-without-moving-survivors',()=>{
  const anchors=JSON.parse(JSON.stringify(first.anchors)),home=anchors.organicHomes[project];
  // A valid retained foreign project occupies the whole right frontier;
  // the existing home's top/left are fixed. A rectangular growth policy
  // cannot use open space above/below it without moving the home.
  anchors.organicHomes['foreign-retained']={x:home.x+home.w+64,y:0,w:4096,h:1e9};
  const after=m.layoutOrganicPlane(added,{},anchors);
  for(const old of first.elements.filter(e=>['tile','band','container'].includes(e.kind))){
   const now=after.elements.find(e=>e.id===old.id);assert.deepEqual([now!.x,now!.y],[old.x,old.y],old.id);
  }
 });
 run('filtered-phase-reservation-survives-new-phase-return',()=>{
  const hidden='phase3',filtered={...added,nodes:added.nodes.filter(n=>n.phaseId!==hidden)};
  const scoped=m.layoutOrganicPlane(filtered,{},first.anchors),restored=m.layoutOrganicPlane(added,{},scoped.anchors);
  const regions=restored.organicRegions!.filter(r=>!r.core);
  for(const r of regions)for(let i=0;i<r.clusters.length;i++)for(let j=i+1;j<r.clusters.length;j++)assert(!overlap(r.clusters[i],r.clusters[j]),r.clusters[i].phaseId+' overlaps '+r.clusters[j].phaseId);
  for(const old of first.elements.filter(e=>e.kind==='tile')){const now=restored.elements.find(e=>e.id===old.id);assert.deepEqual([now!.x,now!.y],[old.x,old.y],old.id);}
 });
 // E386, superseding 'same-phase-large-arrival-keeps-existing-world-and-no-overlap':
 // the regions re-fit what is shown, so a phase that grows by 80 moves the
 // clusters around it; inside the grown phase every card keeps its cell.
 run('same-phase-large-arrival-keeps-every-card-in-its-cell-and-no-overlap',()=>{
  const growth={...graph,nodes:[...graph.nodes,...Array.from({length:80},(_,i)=>({...graph.nodes[0],id:'growth-'+i}))]};
  const after=m.layoutOrganicPlane(growth,{},first.anchors);
  const band=(l:PlaneLayoutResult)=>l.elements.find(e=>e.kind==='tile'&&e.id===graph.nodes[0].id) as PlacedTile;
  const own=band(first).bandId;
  const cell=(l:PlaneLayoutResult,id:string)=>{const t=l.elements.find(e=>e.id===id)!,b=l.elements.find(e=>e.id===own)!;return [t.x-b.x,t.y-b.y];};
  for(const old of first.elements.filter((e):e is PlacedTile=>e.kind==='tile'&&e.bandId===own))assert.deepEqual(cell(after,old.id),cell(first,old.id),old.id);
  const boxes=after.elements.filter(e=>e.kind==='tile');
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)assert(!overlap(boxes[i],boxes[j]),boxes[i].id+' overlaps '+boxes[j].id);
 });
 run('growth-roundtrip-and-next-project-reserve-overflow',()=>{
  const growth={...graph,nodes:[...graph.nodes,...Array.from({length:80},(_,i)=>({...graph.nodes[0],id:'growth-'+i}))]};
  const grown=m.layoutOrganicPlane(growth,{},first.anchors);
  const reloaded=m.layoutOrganicPlane(growth,{},clone((grown.anchors)));
  assert.deepEqual(reloaded,grown,'full grown-layout reload must be a fixed point');
  const withProject={...growth,nodes:[...growth.nodes,{...graph.nodes[0],id:'second-project-task',project:'new-project'}]};
  const after=m.layoutOrganicPlane(withProject,{},reloaded.anchors);
  // E386: a new project re-fits the world (the old clause held every grown
  // position); taking it away again gives the grown world back exactly.
  assert.deepEqual(m.layoutOrganicPlane(growth,{},after.anchors).elements,grown.elements);
  const boxes=after.elements.filter(e=>e.kind==='tile'||e.kind==='pill');
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)assert(!overlap(boxes[i],boxes[j]),boxes[i].id+' overlaps '+boxes[j].id);
  const fit=m.planeContentBounds(after.elements);
  for(const b of boxes){assert(b.x>=fit.x&&b.y>=fit.y&&b.x+b.w<=fit.x+fit.w&&b.y+b.h<=fit.y+fit.h,'Fit clips '+b.id);assert(b.x+b.w<=after.width&&b.y+b.h<=after.height,'world envelope clips '+b.id);}
 });
 // E386, superseding 'completion-filter-growth-return-world-positions': a
 // completion (an edit) moves nothing; a phase filtered away and back returns
 // as arrivals (laid out like a fresh phase), and filtering it away again
 // gives the filtered world back exactly.
 run('completion-moves-nothing-and-a-filter-round-trip-returns-the-filtered-world',()=>{
  const growth={...graph,nodes:[...graph.nodes,...Array.from({length:80},(_,i)=>({...graph.nodes[0],id:'growth-'+i}))]};
  const grown=m.layoutOrganicPlane(growth,{},first.anchors);
  const completed={...growth,nodes:growth.nodes.map(n=>n.id===graph.nodes[0].id?{...n,status:'completed' as const}:n)};
  const settled=m.layoutOrganicPlane(completed,{},grown.anchors);
  for(const old of grown.elements.filter(e=>['tile','band','container'].includes(e.kind))){const now=settled.elements.find(e=>e.id===old.id);assert.deepEqual([now!.x,now!.y],[old.x,old.y],old.id);}
  const filtered={...completed,nodes:completed.nodes.filter(n=>n.phaseId!=='phase0')};
  const scoped=m.layoutOrganicPlane(filtered,{},settled.anchors);
  const restored=m.layoutOrganicPlane(completed,{},scoped.anchors);
  assert.equal(restored.elements.filter(e=>e.kind==='tile').length,completed.nodes.length);
  const again=m.layoutOrganicPlane(filtered,{},restored.anchors);
  assert.deepEqual(again.elements,scoped.elements);
  assert.deepEqual(again.organicRegions,scoped.organicRegions);
 });
 // E386, superseding 'report-only-arrival-preserves-tasks-and-old-pills': the
 // task's Report grid grows its cell, so its phase and the regions around it
 // re-fit; taking the Reports away again gives the world back exactly.
 run('report-only-arrival-re-fits-and-its-departure-returns-the-world',()=>{
  const arrival={...graph,reports:[...graph.reports!,...Array.from({length:30},(_,i)=>({id:'new-report-'+i,taskId:graph.nodes[1].id,title:'New report '+i}))]};
  const after=m.layoutOrganicPlane(arrival,{},first.anchors);
  assert.deepEqual(m.layoutOrganicPlane(graph,{},after.anchors).elements,first.elements);
  const boxes=after.elements.filter(e=>e.kind==='tile'||e.kind==='pill');
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)assert(!overlap(boxes[i],boxes[j]),boxes[i].id+' overlaps '+boxes[j].id);
  assert.deepEqual(m.layoutOrganicPlane(arrival,{},clone((after.anchors))),after);
 });
 // E386: the projects are laid out around the core that is shown, so they
 // move outward as it grows (the old clause held their positions).
 run('archive-core-growth-does-not-cover-surviving-project-tasks',()=>{
  const archivedIds=new Set(graph.nodes.filter(n=>n.phaseId==='phase0'||n.phaseId==='phase1'||n.phaseId==='phase2').map(n=>n.id));
  const changed={...graph,nodes:graph.nodes.map(n=>archivedIds.has(n.id)?{...n,status:'archived' as const}:n)};
  const after=m.layoutOrganicPlane(changed,{},first.anchors),core=after.organicRegions!.find(r=>r.core)!;
  for(const t of after.elements.filter(e=>e.kind==='tile'&&!archivedIds.has(e.id))){
   const dx=(t.x+t.w/2-core.box.x-core.box.w/2)/(core.box.w/2),dy=(t.y+t.h/2-core.box.y-core.box.h/2)/(core.box.h/2);
   assert(dx*dx+dy*dy>=1,'archive ellipse covers surviving '+t.id);
  }
 });
}

test('independent-phases-have-compact-initial-ground-and-real-dependent-arrival',()=>{
 const bounds=m.planeContentBounds(initial.elements);
 assert(bounds.h/bounds.w<3,'synthetic independent roots must not recreate the prior11:1 column');
 const added:MapGraph={...graph,nodes:[...graph.nodes,{...graph.nodes[0],id:'dependent-arrival',phaseId:'new-phase'}],
   phases:[...graph.phases,{...graph.phases[0],id:'new-phase',position:10}],
   edges:[...graph.edges,{from:'dependent-arrival',to:graph.nodes[0].id,kind:'dependency'}]};
 const after=m.layoutOrganicPlane(added,{},initial.anchors);
 // E386: the arrival's phase re-fits the regions (the old clause held every
 // position); taking it away gives the initial world back exactly.
 assert(after.elements.some(e=>e.id==='dependent-arrival'));
 assert.deepEqual(m.layoutOrganicPlane(graph,{},after.anchors).elements,initial.elements);
});

test('detached-growth-ground-and-full-width-corridors-do-not-cover-foreign-tiles',()=>{
function polygons(d:string){const tokens=d.match(/[MLQZ]|[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi)||[];let i=0,out:number[][][]=[],p:number[][]=[],at=[0,0];const point=()=>[Number(tokens[i++]),Number(tokens[i++])];while(i<tokens.length){const c=tokens[i++];if(c==='M'){if(p.length)out.push(p);p=[];at=point();p.push(at);}else if(c==='L'){at=point();p.push(at);}else if(c==='Q'){const a=at,q=point(),b=point();for(let t=1;t<=16;t++){const u=t/16;p.push([(1-u)**2*a[0]+2*u*(1-u)*q[0]+u*u*b[0],(1-u)**2*a[1]+2*u*(1-u)*q[1]+u*u*b[1]]);}at=b;}else if(c==='Z'){out.push(p);p=[];}else throw Error('unsupported_path');}if(p.length)out.push(p);return out;}
function inside(point:number[],paths:number[][][]){let winding=0;for(const p of paths)for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length],cross=(b[0]-a[0])*(point[1]-a[1])-(point[0]-a[0])*(b[1]-a[1]);if(a[1]<=point[1]&&b[1]>point[1]&&cross>0)winding++;else if(a[1]>point[1]&&b[1]<=point[1]&&cross<0)winding--;}return winding!==0;}
const first=initial;
const foreign={...graph.nodes[0],id:'foreign-task',project:'foreign-project',phaseId:'foreign-phase'};
const both={...graph,nodes:[...graph.nodes,foreign],phases:[...graph.phases,{...graph.phases[0],id:'foreign-phase'}]};
const placed=m.layoutOrganicPlane(both,{},first.anchors);
const grownGraph={...both,nodes:[...both.nodes,...Array.from({length:80},(_,i)=>({...graph.nodes[0],id:'growth-'+i}))]};
const grown=m.layoutOrganicPlane(grownGraph,{},placed.anchors);
const violations:Array<{region:string;foreignTile:string;point:number[]}>=[],clearance:Array<{region:string;tile:string}>=[];
for(const region of grown.organicRegions!.filter(r=>!r.core)){
 const contours=polygons(region.outline!);
 for(const tile of grown.elements.filter((e):e is PlacedTile=>e.kind==='tile'&&e.laneId!==region.laneId)){
  const point=[tile.x+tile.w/2,tile.y+tile.h/2];
  if(inside(point,contours))violations.push({region:region.laneId,foreignTile:tile.id,point});
 }
 for(const points of region.routedBranches??[])for(let i=1;i<points.length;i++){
  const a=points[i-1],b=points[i],ground={x:Math.min(a[0],b[0])-12,y:Math.min(a[1],b[1])-12,w:Math.abs(a[0]-b[0])+24,h:Math.abs(a[1]-b[1])+24};
  assert(a[0]===b[0]||a[1]===b[1],'route must be axis aligned for full swept-ground check');
  for(const tile of grown.elements.filter((e):e is PlacedTile=>e.kind==='tile'&&e.laneId!==region.laneId))if(ground.x<tile.x+tile.w&&ground.x+ground.w>tile.x&&ground.y<tile.y+tile.h&&ground.y+ground.h>tile.y)clearance.push({region:region.laneId,tile:tile.id});
 }
}

assert.deepEqual(violations,[]);assert.deepEqual(clearance,[]);assert(grown.organicRegions!.every(r=>!r.blockedBranches));
});


test('archive coordinates and circle do not depend on first partial or full DOM measurement',()=>{
 const fresh=m.layoutOrganicPlane(graph,{});
 const before=m.layoutOrganicPlane(changed,{},fresh.anchors);
 const measured:Record<string,{w:number,h:number}>={};
 const expected=new Map(ink(before).map(e=>[e.id,[e.x,e.y]]));
 for(const [index,e] of ink(before).entries()) {
  measured[e.id]=e.kind==='tile'?{w:170,h:123}:{w:36,h:36};
  if(index!==29&&index!==ink(before).length-1)continue;
  const actual=m.layoutOrganicPlane(changed,measured,clone((before.anchors)));
  assert.deepEqual(core(actual),core(before),'same cohort core moved after measurement');
  for(const item of ink(actual))assert.deepEqual([item.x,item.y],expected.get(item.id),'measured position '+item.id);
  const c=core(actual),r=c.w/2,cx=c.x+r,cy=c.y+r;
  for(const item of ink(actual).filter(archived))for(const x of [item.x,item.x+item.w])for(const y of [item.y,item.y+item.h])
    assert((x-cx)**2+(y-cy)**2<=r*r+.1,'measured ink outside circle '+item.id);
  const again=m.layoutOrganicPlane(changed,measured,clone((actual.anchors)));
  assert.deepEqual(core(again),c);
  for(const item of ink(actual))assert.deepEqual(coords(ink(again).find(e=>e.id===item.id)),coords(item));
 }
});
