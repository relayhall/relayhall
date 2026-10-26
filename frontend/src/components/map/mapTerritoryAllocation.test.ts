import { expect, test } from 'vitest';
import { convexHull, type Box } from './mapGraphModel';
import { organicTerritoryPath, PLANE_METRICS, type OrganicRegion } from './mapPlaneModel';

// Frozen at 63d753f: path-string oracle before allocation-only scalar arithmetic.
function originalTerritoryPath(region: OrganicRegion): string {
  type Point = [number,number];
  const root=region.box,polygons:Point[][]=[];
  const add=(points:Point[])=>{
    const poly=convexHull(points.map(([x,y])=>[
      Math.max(root.x,Math.min(root.x+root.w,x)),
      Math.max(root.y,Math.min(root.y+root.h,y))] as const));
    if(poly.length>=3) polygons.push(poly);
  };
  const rectangle=(b:Box,pad=0)=>add([[b.x-pad,b.y-pad],[b.x+b.w+pad,b.y-pad],
    [b.x+b.w+pad,b.y+b.h+pad],[b.x-pad,b.y+b.h+pad]]);
  for(const box of region.clusters) rectangle(box,24);
  // A branch is a diagonal ribbon, not a staircase. The convex capsule
  // overlaps phase ground and the neighbouring ribbons at each fork.
  const corridor=(x1:number,y1:number,x2:number,y2:number,routed=false)=>{
    const ends=region.clusters.filter(b=>(x1>=b.x&&x1<=b.x+b.w&&y1>=b.y&&y1<=b.y+b.h)
      ||(x2>=b.x&&x2<=b.x+b.w&&y2>=b.y&&y2<=b.y+b.h));
    const radius=routed?12:Math.max(48,Math.min(256,...ends.map(b=>Math.min(b.w,b.h)*0.4)));
    add([...[x1,x2].flatMap((x,i)=>Array.from({length:8},(_,j)=>[
      x+radius*Math.cos(j*Math.PI/4),(i?y2:y1)+radius*Math.sin(j*Math.PI/4)] as Point))]);
  };
  if(region.routedBranches) {
    for(const points of region.routedBranches)for(let i=1;i<points.length;i++)
      corridor(points[i-1][0],points[i-1][1],points[i][0],points[i][1],true);
  } else for(const [a,b,c,d] of region.branches) corridor(a,b,c,d);
  const caption=region.captionBox??root;
  const headerW=Math.min(caption.w,1024);
  rectangle({x:caption.x,y:caption.y,w:headerW,h:Math.min(caption.h,PLANE_METRICS.captionHeaderH)});
  const first=region.branches[1];
  if(first&&!region.routedBranches)corridor(caption.x+headerW/2,caption.y+PLANE_METRICS.captionHeaderH/2,first[0],first[1]);
  // Bound pathological phase counts without losing containment. Dense
  // projects use the enclosing hull; ordinary projects retain their forks.
  if(!region.routedBranches&&(region.clusters.length<=2||polygons.length>128))
    return 'M '+convexHull(polygons.flat()).map(p=>p.join(' ')).join(' L ')+' Z';
  // Preserve the existing bounded union work without filling the empty space
  // between detached cells. Nonzero SVG subpaths paint their actual union.
  if(polygons.length>128)return polygons.map(poly=>'M '+poly.map(p=>p.join(' ')).join(' L ')+' Z').join(' ');
  // Union convex pieces by splitting their boundary at intersections and
  // retaining only exposed segments. This preserves the gaps between arms.
  const cross=(a:Point,b:Point)=>a[0]*b[1]-a[1]*b[0];
  const sub=(a:Point,b:Point):Point=>[a[0]-b[0],a[1]-b[1]];
  const inside=(p:Point,poly:Point[])=>poly.every((a,i)=>
    cross(sub(poly[(i+1)%poly.length],a),sub(p,a))>1e-5);
  const key=(p:Point)=>p.map(v=>Math.round(v*1e5)/1e5).join(',');
  const segments=new Map<string,[Point,Point]>();
  for(const [index,poly] of polygons.entries())for(let i=0;i<poly.length;i++) {
    const a=poly[i],b=poly[(i+1)%poly.length],v=sub(b,a),cuts=[0,1];
    for(const [otherIndex,other] of polygons.entries())if(otherIndex!==index)
      for(let j=0;j<other.length;j++){
        const c=other[j],d=other[(j+1)%other.length],w=sub(d,c),den=cross(v,w);
        if(Math.abs(den)<1e-8){
          if(Math.abs(cross(sub(c,a),v))<1e-5){
            const length=v[0]*v[0]+v[1]*v[1];
            for(const p of [c,d]){const t=((p[0]-a[0])*v[0]+(p[1]-a[1])*v[1])/length;if(t>0&&t<1)cuts.push(t);}
          }
          continue;
        }
        const t=cross(sub(c,a),w)/den,u=cross(sub(c,a),v)/den;
        if(t>0&&t<1&&u>=0&&u<=1)cuts.push(t);
      }
    cuts.sort((x,y)=>x-y);
    for(let j=1;j<cuts.length;j++){
      const lo=cuts[j-1],hi=cuts[j];if(hi-lo<1e-8)continue;
      const point=(t:number):Point=>[a[0]+v[0]*t,a[1]+v[1]*t];
      if(polygons.some((p,k)=>k!==index&&inside(point((lo+hi)/2),p)))continue;
      const start=point(lo),end=point(hi),id=key(start)+'|'+key(end),reverse=key(end)+'|'+key(start);
      if(segments.has(reverse))segments.delete(reverse);else segments.set(id,[start,end]);
    }
  }
  const outgoing=new Map<string,Array<[Point,Point]>>();
  for(const edge of segments.values()){const at=key(edge[0]),list=outgoing.get(at)??[];list.push(edge);outgoing.set(at,list);}
  const paths:string[]=[];
  while(outgoing.size){
    const start=outgoing.keys().next().value as string;
    let at=start;const points:Point[]=[];
    do{
      const list=outgoing.get(at);if(!list?.length)break;
      const edge=list.pop()!;if(!list.length)outgoing.delete(at);
      points.push(edge[0]);at=key(edge[1]);
    }while(at!==start);
    if(points.length<3)continue;
    const corners=points.filter((p,i)=>Math.abs(cross(sub(p,points[(i+points.length-1)%points.length]),sub(points[(i+1)%points.length],p)))>1e-5);
    const arcs=corners.map((p,i)=>{
      const a=corners[(i+corners.length-1)%corners.length],b=corners[(i+1)%corners.length];
      const before=Math.hypot(...sub(p,a)),after=Math.hypot(...sub(b,p)),r=Math.min(12,before/3,after/3);
      return {p,enter:[p[0]+(a[0]-p[0])*r/before,p[1]+(a[1]-p[1])*r/before],
        exit:[p[0]+(b[0]-p[0])*r/after,p[1]+(b[1]-p[1])*r/after]};
    });
    if(arcs.length)paths.push('M '+arcs[0].enter.join(' ')+arcs.map(v=>' L '+v.enter.join(' ')+' Q '+v.p.join(' ')+' '+v.exit.join(' ')).join('')+' Z');
  }
  return paths.join(' ');
}

function outlineControls(): OrganicRegion[] {
  const regions: OrganicRegion[]=[];
  for(const gap of [-60,-48,-24,0,24,48,60])for(const epsilon of [0,1e-9,1e-7]) {
    const region:OrganicRegion={laneId:'contact',core:false,box:{x:-100,y:-100,w:800,h:800},
      captionBox:{x:0,y:0,w:100,h:80},clusters:[{x:0,y:0,w:100,h:80},{x:100+gap+epsilon,y:epsilon,w:100,h:80}],
      branches:[[50,40,150+gap+epsilon,40+epsilon]],routedBranches:[[[50,40],[150+gap+epsilon,40+epsilon]],[[50,40],[50,40]]]};
    regions.push(region,{...region,clusters:[...region.clusters].reverse(),branches:[...region.branches].reverse(),routedBranches:region.routedBranches!.map(points=>[...points].reverse())});
  }
  for(const scale of [-0,1e-9,1e-5,1,1e150,1e160,1e305])regions.push({laneId:'extreme',core:false,
    box:{x:-scale*100,y:-scale*100,w:scale*1000,h:scale*1000},
    clusters:[{x:0,y:-0,w:scale*50,h:scale*50},{x:scale*50,y:0,w:scale*50,h:scale*50}],
    branches:[[0,-0,scale*100,0]],routedBranches:[[[0,-0],[scale*100,0],[scale*100,0]]]});
  // With no routed segments, each nondegenerate cluster contributes one
  // polygon and the caption contributes one: exercise both sides of 128.
  for(const count of [126,127,128,129])for(const routed of [false,true]) {
    const clusters=Array.from({length:count},(_,i)=>({x:(i%16)*100,y:Math.floor(i/16)*100,w:40,h:40}));
    regions.push({laneId:'fallback-'+count,core:false,box:{x:-100,y:-100,w:2000,h:1200},clusters,
      captionBox:{x:0,y:1000,w:120,h:80},branches:[],...(routed?{routedBranches:[]}: {})});
  }
  return regions;
}

test.each(outlineControls().map((region,id)=>({region,id})))('territory allocation parity $id', ({region})=>{
  const before=structuredClone(region);
  expect(organicTerritoryPath(region)).toBe(originalTerritoryPath(region));
  expect(region).toEqual(before);
});
