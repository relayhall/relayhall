import { expect, test } from 'vitest';
import { taskShapeAlpha } from './mapPlaneModel';
import { roundedRoutePath } from './mapGraphModel';
import { computeMapRoutes } from './computeMapRoutes';

test('simplified tasks remain fully visible until their short side is ten screen pixels', () => {
  for (const px of [120, 80, 40, 20, 10]) expect(taskShapeAlpha(px)).toBe(1);
  expect(taskShapeAlpha(7)).toBe(0.5);
  expect(taskShapeAlpha(4)).toBe(0);
  expect(taskShapeAlpha(1)).toBe(0);
});
test('rounded paths retain endpoints and smooth corners', () => {
  const path=roundedRoutePath([[0,0],[100,0],[100,100],[200,100]],[]);
  expect(path).toContain('Q'); expect(path.startsWith('M 0 0')).toBe(true);
  expect(path.endsWith('L 200 100')).toBe(true);
  expect(path).not.toContain('NaN');
});
test('shared corridors get distinct attachment and route geometry', () => {
  const a={x:0,y:0,w:80,h:60}, b={x:200,y:0,w:80,h:60};
  const c={x:500,y:300,w:80,h:60}, d={x:600,y:350,w:80,h:60};
  const routes=computeMapRoutes({requests:[
    {key:'first',source:a,target:c,mode:'flow'},
    {key:'second',source:b,target:d,mode:'flow'}],obstacles:[a,b,c,d],
    envelope:{x:-100,y:-100,w:1000,h:800},organization:'organic'});
  expect(routes).toHaveLength(2);
  for(const row of routes){ expect(row.route.clipped).toBe(false);expect(row.route.d).toContain('Q'); }
  expect(routes[0].route.d).not.toBe(routes[1].route.d);
});


test('close routes keep a padded corridor around an unrelated task', () => {
  const source={x:20,y:120,w:80,h:60}, target={x:500,y:120,w:80,h:60};
  const middle={x:230,y:100,w:100,h:100};
  const route=computeMapRoutes({requests:[{key:'clearance',mode:'flow',source,target}],
    obstacles:[source,middle,target], envelope:{x:0,y:0,w:700,h:400},organization:'horizontal',scale:1})[0].route;
  expect(route.clipped).toBe(false);
  // Every straight section through the obstacle's horizontal span stays
  // outside its eight-pixel halo, not merely outside the card itself.
  const points=route.points!;
  for(let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i];
    if(a[1]===b[1] && Math.max(a[0],b[0])>222 && Math.min(a[0],b[0])<338)
      expect(a[1]<=92 || a[1]>=208).toBe(true);
  }
});

import { boundedHeaderStyle } from './MapViewportCard';
test('rectangular headers stay inside reserved strips at every zoom', () => {
  for (const width of [80, 220, 500, 1200]) for (const scale of [.05, .2, .5, 1, 2]) {
    const style = boundedHeaderStyle(width, scale);
    const factor = Number(String(style.transform).match(/scale\(([^)]+)\)/)![1]);
    expect(16 + 220 * factor).toBeLessThanOrEqual(width - 16 + .0001);
    expect(16 + 120 * factor).toBeLessThanOrEqual(192 - 16);
    expect(factor * scale).toBeLessThanOrEqual(1);
  }
});


test('nearby vertical tasks do not detour around a row to avoid another link', () => {
  const a={x:400,y:200,w:100,h:60}, b={x:160,y:300,w:100,h:60};
  const c={x:20,y:200,w:100,h:60}, d={x:600,y:300,w:100,h:60};
  const requests=[{key:'crossing',source:c,target:d,mode:'flow' as const},
    {key:'nearby',source:a,target:b,mode:'flow' as const}];
  const input={requests,obstacles:[a,b,c,d],envelope:{x:0,y:0,w:800,h:500},organization:'vertical' as const,scale:1};
  const result=computeMapRoutes(input)[1].route;
  expect(result.clipped).toBe(false);
  const points=result.points!;
  const length=points.slice(1).reduce((n,p,i)=>n+Math.hypot(p[0]-points[i][0],p[1]-points[i][1]),0);
  expect(length).toBeLessThan(400);
  expect(points.every(p=>p[1]>=260 && p[1]<=300)).toBe(true);
  expect(result.d).toContain('Q');
});


test('open space uses a diagonal waypoint span instead of a staircase', () => {
  const source={x:20,y:20,w:80,h:60},target={x:350,y:280,w:80,h:60};
  const route=computeMapRoutes({requests:[{key:'waypoints',source,target,mode:'flow'}],
    obstacles:[source,target],envelope:{x:0,y:0,w:600,h:500},organization:'vertical',scale:1})[0].route;
  expect(route.clipped).toBe(false);
  expect(route.points!.some((p,i,a)=>i>0 && p[0]!==a[i-1][0] && p[1]!==a[i-1][1])).toBe(true);
  expect(route.points!.length).toBeLessThanOrEqual(4);
  expect(route.d).toContain('Q');
});
