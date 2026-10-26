// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MapConnection } from './MapConnection';
afterEach(() => { cleanup(); vi.useRealTimers(); });
const d = 'M 0 0 L 100 0';
test('finished connectors discard drawing dashes and normalized length before subsequent zooms', () => {
  vi.useFakeTimers();
  const {container} = render(<svg><MapConnection pending={false} animate d={d}/></svg>);
  act(() => { vi.advanceTimersByTime(500); });
  const path = container.querySelector('path')!;
  expect(path.hasAttribute('pathLength')).toBe(false);
  expect(path.classList.contains('map-connection-reveal')).toBe(false);
});
test('animation completion restores the semantic edge styling', () => {
  const {container} = render(<svg><MapConnection pending={false} animate d={d} className="map-edge--knowledge"/></svg>);
  const path = container.querySelector('path')!;
  fireEvent.animationEnd(path, {animationName: 'map-connection-draw'});
  expect(path.hasAttribute('pathLength')).toBe(false);
  expect(path.classList.contains('map-edge--knowledge')).toBe(true);
  expect(path.classList.contains('map-connection-reveal')).toBe(false);
});

test('drawing length follows zoom without replaying a finished route', () => {
  vi.useFakeTimers();
  const {container, rerender} = render(<svg><MapConnection pending={false} animate scale={2} d={d}/></svg>);
  expect(container.querySelector('path')!.getAttribute('pathLength')).toBe('0.5');
  rerender(<svg><MapConnection pending={false} animate scale={4} d={d}/></svg>);
  expect(container.querySelector('path')!.getAttribute('pathLength')).toBe('0.25');
  act(() => { vi.advanceTimersByTime(500); });
  rerender(<svg><MapConnection pending={false} animate scale={0.5} d={d}/></svg>);
  expect(container.querySelector('path')!.hasAttribute('pathLength')).toBe(false);
});
test('a replaced route gets its own bounded reveal, pending links retain their dashes', () => {
  vi.useFakeTimers();
  const {container, rerender} = render(<svg><MapConnection pending={false} animate d={d}/></svg>);
  act(() => { vi.advanceTimersByTime(500); });
  rerender(<svg><MapConnection pending animate d="M 0 0 L 200 0" strokeDasharray="3 5"/></svg>);
  expect(container.querySelector('path')!.getAttribute('stroke-dasharray')).toBe('3 5');
  expect(container.querySelector('path')!.hasAttribute('pathLength')).toBe(false);
  rerender(<svg><MapConnection pending={false} animate d="M 0 0 L 200 0"/></svg>);
  expect(container.querySelector('.map-connection-reveal')).not.toBeNull();
  act(() => { vi.advanceTimersByTime(500); });
  expect(container.querySelector('.map-connection-reveal')).toBeNull();
});
