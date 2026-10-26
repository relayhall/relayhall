// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MapViewportCard, containerCardInViewport } from './MapViewportCard';
import { recordMapMeasurement, type MapMeasurements } from './mapMeasurements';

afterEach(cleanup);
const camera = { scale: 1, offsetX: 0, offsetY: 0 };
const viewport = { width: 1000, height: 800 };
test.each([
  [{ x: -340, y: 0, w: 100, h: 100 }, true],
  [{ x: -341, y: 0, w: 100, h: 100 }, false],
  [{ x: 1240, y: 0, w: 100, h: 100 }, true],
  [{ x: 1241, y: 0, w: 100, h: 100 }, false],
  [{ x: 0, y: -341, w: 100, h: 100 }, false],
  [{ x: 0, y: 1040, w: 100, h: 100 }, true],
  [{ x: 0, y: 1041, w: 100, h: 100 }, false],
])('inclusive region boundary %j', (box, expected) => {
  expect(containerCardInViewport(box, camera, viewport, 240)).toBe(expected);
});
test('unknown viewport admits ink; pan and scale use screen-pixel margin', () => {
  const box = { x: 10000, y: 10000, w: 100, h: 100, facts: {} };
  expect(containerCardInViewport(box, camera, { width: 0, height: 0 }, 240)).toBe(true);
  expect(containerCardInViewport(box, camera, viewport, 240)).toBe(false);
  expect(containerCardInViewport(box, { scale: 0.1, offsetX: -500, offsetY: -500 }, viewport, 240)).toBe(true);
});
test('offscreen cards omit expensive children, returning with current metadata', () => {
  const Child = vi.fn(({ title }: { title: string }) => <button>{title}</button>);
  const measure = vi.fn();
  const view = render(<MapViewportCard admitted={false} measure={measure} style={{}}><Child title="Old" /></MapViewportCard>);
  expect(Child).not.toHaveBeenCalled();expect(measure).not.toHaveBeenCalled();
  view.rerender(<MapViewportCard admitted measure={measure} style={{}}><Child title="Current" /></MapViewportCard>);
  expect(screen.getByRole('button', { name: 'Current' })).toBeInTheDocument();
  view.rerender(<MapViewportCard admitted={false} measure={measure} style={{}}><Child title="Newest" /></MapViewportCard>);
  expect(screen.queryByRole('button')).toBeNull();expect(measure).toHaveBeenLastCalledWith(null);
  view.rerender(<MapViewportCard admitted measure={measure} style={{}}><Child title="Newest" /></MapViewportCard>);
  expect(screen.getByRole('button', { name: 'Newest' })).toBeInTheDocument();
});
test('focus survives offscreen pan and return, but never authority replacement', () => {
  const measure=vi.fn();
  const card=(admitted:boolean,scope='old')=><MapViewportCard key={scope} admitted={admitted} measure={measure} style={{}}><button>Open</button><button>Second</button></MapViewportCard>;
  const view=render(card(true));const button=screen.getByRole('button',{name:'Open'});
  act(()=>button.focus());view.rerender(card(false));expect(button).toHaveFocus();
  act(()=>screen.getByRole('button',{name:'Second'}).focus());expect(screen.getByRole('button',{name:'Second'})).toHaveFocus();
  view.rerender(card(true));expect(screen.getByRole('button',{name:'Second'})).toHaveFocus();
  view.rerender(card(false,'new-authority'));expect(screen.queryByRole('button')).toBeNull();
});
test('membership removal cannot keep a focused card', () => {
  const view=render(<MapViewportCard admitted measure={()=>{}} style={{}}><button>Open</button></MapViewportCard>);
  act(()=>screen.getByRole('button').focus());view.rerender(<></>);expect(screen.queryByRole('button')).toBeNull();
});
test('culled cards retain recorded measurements through return', () => {
  let sizes:MapMeasurements={sizes:{},planeSizes:{}};
  const measure=(element:HTMLElement|null)=>{if(element)sizes=recordMapMeasurement(sizes,'card:phase',300,160,false);};
  const card=(admitted:boolean)=><MapViewportCard admitted={admitted} measure={measure} style={{width:300,maxHeight:160}}><button>Open</button></MapViewportCard>;
  const view=render(card(true));const prior=sizes;view.rerender(card(false));expect(sizes).toBe(prior);
  view.rerender(card(true));expect(sizes).toBe(prior);expect(sizes.sizes['card:phase']).toEqual({w:300,h:160});
});
