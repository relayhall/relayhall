import { expect, test } from 'vitest';
import { segmentIntersectsBox, type Box } from './mapGraphModel';

// Frozen pre-optimization implementation: differential contract oracle.
function original(
  x1: number, y1: number, x2: number, y2: number, box: Box,
): boolean {
  // Liang-Barsky: the segment meets the box iff the parameter interval
  // surviving all four half-plane clips is non-empty.
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const tests: Array<[number, number]> = [
    [-dx, x1 - box.x],
    [dx, box.x + box.w - x1],
    [-dy, y1 - box.y],
    [dy, box.y + box.h - y1],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return false;     // parallel and outside this edge
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return true;
}


test('clipping preserves inclusive boundaries and degenerate segments', () => {
 const b={x:0,y:0,w:10,h:10};
 for(const [x1,y1,x2,y2,expected] of [
  [-1,0,11,0,true],[-1,-1,11,-1,false],[0,-1,0,11,true],[-1,-1,0,0,true],
  [5,5,5,5,true],[11,5,11,5,false],[0,0,0,0,true],[11,11,12,12,false],
 ] as const) expect(segmentIntersectsBox(x1,y1,x2,y2,b)).toBe(expected);
 expect(segmentIntersectsBox(-1,0,1,0,{x:0,y:0,w:0,h:0})).toBe(true);
});

test('allocation-free clipping matches the frozen algorithm across seeded geometry and numeric extremes', () => {
 let seed=0x64d8fb;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed/4294967296-.5)*20000;};
 for(let i=0;i<30000;i++) {
  const x1=random(),y1=random(),x2=i%3?random():x1,y2=i%4?random():y1;
  const b={x:random(),y:random(),w:random(),h:random()};
  expect(segmentIntersectsBox(x1,y1,x2,y2,b)).toBe(original(x1,y1,x2,y2,b));
 }
 const values=[NaN,Infinity,-Infinity,Number.MAX_VALUE,-Number.MAX_VALUE,Number.MIN_VALUE,-Number.MIN_VALUE,0,-0,Number.EPSILON,-Number.EPSILON];
 for(let field=0;field<8;field++)for(const value of values){
  const v=[-1,5,11,5,0,0,10,10];v[field]=value;
  const [x1,y1,x2,y2,x,y,w,h]=v,b={x,y,w,h};
  expect(segmentIntersectsBox(x1,y1,x2,y2,b)).toBe(original(x1,y1,x2,y2,b));
 }
});
