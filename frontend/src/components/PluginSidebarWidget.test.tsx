// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {StrictMode} from 'react';
import {act, cleanup, fireEvent, render} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import type {PluginInfo} from '../types/plugin';
import {PluginSidebarWidget, SIDEBAR_WIDGET_GROW_CEILING} from './PluginSidebarWidget';
const bridge = vi.hoisted(() => ({attach: vi.fn(() => vi.fn())}));
vi.mock('../utils/pluginBridge', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/pluginBridge')>(),
  attachPluginBridge: bridge.attach,
}));
afterEach(() => {cleanup(); vi.clearAllMocks();});
const plugin = (name = 'usage', height = 176, path = '/widget') => ({
  name, api_base: '/plugins/' + name, sidebar_widget: {path, height},
} as PluginInfo);
function send(frame: HTMLIFrameElement, height: unknown, overrides: MessageEventInit = {}) {
  act(() => {window.dispatchEvent(new MessageEvent('message', {
    origin: location.origin, source: frame.contentWindow, data: {type: 'iframeResize', height}, ...overrides,
  }));});
}
test('unchanged plugins keep manifest fallback; valid messages shrink and grow within declaration', () => {
  const {container} = render(<PluginSidebarWidget plugin={plugin()} title="Usage" />);
  const frame = container.querySelector('iframe')!;
  expect(frame.style.height).toBe('176px');
  for (const [requested, expected] of [[30,48],[158,158],[500,176],[65.1,66],[30,48]]) {
    send(frame, requested); expect(frame.style.height).toBe(expected + 'px');
  }
});
test('rejects invalid numbers, payloads, origins and source windows', () => {
  const {container} = render(<PluginSidebarWidget plugin={plugin()} title="Usage" />);
  const frame = container.querySelector('iframe')!;
  for (const value of ['80', null, undefined, {}, [], NaN, Infinity, -Infinity, 0, -1]) send(frame, value);
  send(frame,80,{origin:'https://evil.invalid'});
  send(frame,80,{source:window});
  send(frame,80,{data:{type:'other',height:80}});
  send(frame,80,{data:null});
  expect(frame.style.height).toBe('176px');
});
test('each iframe accepts only its own resize messages', () => {
  const {container} = render(<><PluginSidebarWidget plugin={plugin()} title="Usage" /><PluginSidebarWidget plugin={plugin('orb',160)} title="Usage" /></>);
  const [usage,orb] = Array.from(container.querySelectorAll('iframe'));
  send(usage,60); expect(usage.style.height).toBe('60px'); expect(orb.style.height).toBe('160px');
  send(orb,80); expect(usage.style.height).toBe('60px'); expect(orb.style.height).toBe('80px');
});
test('identity, URL and manifest changes reset fallback and detach old iframe', () => {
  const {container,rerender} = render(<PluginSidebarWidget plugin={plugin()} title="Usage" />);
  for (const next of [plugin('other'),plugin('other',176,'/next'),plugin('other',120,'/next')]) {
    const old = container.querySelector('iframe')!; send(old,60);
    const oldSource = old.contentWindow;
    rerender(<PluginSidebarWidget plugin={next} title="Usage" />);
    const current = container.querySelector('iframe')!;
    expect(current).not.toBe(old); expect(current.style.height).toBe(next.sidebar_widget!.height+'px');
    send(current,50,{source:oldSource}); expect(current.style.height).toBe(next.sidebar_widget!.height+'px');
  }
});
test('reload restores fallback then accepts the newly loaded content size', () => {
  const {container} = render(<PluginSidebarWidget plugin={plugin()} title="Usage" />);
  const frame=container.querySelector('iframe')!;
  send(frame,60); fireEvent.load(frame); expect(frame.style.height).toBe('176px');
  send(frame,80); expect(frame.style.height).toBe('80px');
});
test('StrictMode reattaches listeners and unmount releases every bridge subscription', () => {
  const {container,unmount} = render(<StrictMode><PluginSidebarWidget plugin={plugin()} title="Usage" /></StrictMode>);
  const frame=container.querySelector('iframe')!; send(frame,80); expect(frame.style.height).toBe('80px');
  unmount();
  for (const result of bridge.attach.mock.results) expect(result.value).toHaveBeenCalledTimes(1);
});
test('manifest bounds remain enforced even when the plugin requests more space', () => {
  const {container,rerender} = render(<PluginSidebarWidget plugin={plugin('usage',999)} title="Usage" />);
  let frame=container.querySelector('iframe')!; send(frame,1000); expect(frame.style.height).toBe('240px');
  rerender(<PluginSidebarWidget plugin={plugin('usage',0)} title="Usage" />);
  frame=container.querySelector('iframe')!; send(frame,100); expect(frame.style.height).toBe('48px');
  rerender(<PluginSidebarWidget plugin={{...plugin(),sidebar_widget:undefined}} title="Usage" />);
  expect(container.querySelector('iframe')).toBeNull();
});
// Owner ruling E438(1): `ui.sidebar_widget.grow` is an OPT-IN. A widget that
// declares it takes the content height its own frame reports, up to the host
// ceiling of 1600 px; every other widget keeps the declared-height clamp. The
// Usage Limits widget reports 204 px for 4 accounts, 249 for 5 and 565 for 12.
const growing = (height = 240, grow: unknown = true) => ({
  name: 'usage-limits', api_base: '/plugins/usage-limits', sidebar_widget: {path: '/widget', height, grow},
} as PluginInfo);
test('grow (E438): without the opt-in a 565 px report stays clamped at the declared height and 240', () => {
  for (const [widget, expected] of [[plugin('usage', 176), 176], [plugin('usage', 240), 240],
    [growing(240, false), 240], [growing(240, 'true'), 240], [growing(200, 1), 200], [growing(999, null), 240]] as const) {
    const {container, unmount} = render(<PluginSidebarWidget plugin={widget} title="Usage" />);
    const frame = container.querySelector('iframe')!;
    send(frame, 565); expect(frame.style.height).toBe(expected + 'px');
    send(frame, 1600); expect(frame.style.height).toBe(expected + 'px');
    unmount();
  }
});
test('grow (E438): an opted-in widget starts at its declared height and takes the content height it reports', () => {
  const {container} = render(<PluginSidebarWidget plugin={growing()} title="Usage limits" />);
  const frame = container.querySelector('iframe')!;
  expect(frame.style.height).toBe('240px');
  for (const [requested, expected] of [[204, 204], [249, 249], [565, 565], [564.2, 565], [30, 48], [1600, 1600]]) {
    send(frame, requested); expect(frame.style.height).toBe(expected + 'px');
  }
});
test('grow (E438): a report above the 1600 px host ceiling is clamped, never trusted', () => {
  expect(SIDEBAR_WIDGET_GROW_CEILING).toBe(1600);
  const {container} = render(<PluginSidebarWidget plugin={growing()} title="Usage limits" />);
  const frame = container.querySelector('iframe')!;
  for (const requested of [1601, 5000, 1e9, Number.MAX_VALUE]) {
    send(frame, 565); send(frame, requested); expect(frame.style.height).toBe('1600px');
  }
});
test('grow (E438): malformed and foreign reports are ignored', () => {
  const {container} = render(<><PluginSidebarWidget plugin={growing()} title="Usage limits" />
    <PluginSidebarWidget plugin={plugin('orb', 160)} title="Activity" /></>);
  const [frame, other] = Array.from(container.querySelectorAll('iframe'));
  for (const value of ['565', null, undefined, {}, [], NaN, Infinity, -Infinity, 0, -1]) send(frame, value);
  send(frame, 565, {origin: 'https://evil.invalid'});
  send(frame, 565, {source: window});
  send(frame, 565, {source: other.contentWindow});
  send(frame, 565, {data: {type: 'other', height: 565}});
  expect(frame.style.height).toBe('240px');
});
test('grow (E438): a reload returns to the declared height, then takes the new content height', () => {
  const {container} = render(<PluginSidebarWidget plugin={growing()} title="Usage limits" />);
  const frame = container.querySelector('iframe')!;
  send(frame, 565); fireEvent.load(frame); expect(frame.style.height).toBe('240px');
  send(frame, 249); expect(frame.style.height).toBe('249px');
});
test('grow (E438): changing the opt-in replaces the frame at its declared height', () => {
  const {container, rerender} = render(<PluginSidebarWidget plugin={growing()} title="Usage limits" />);
  const old = container.querySelector('iframe')!; send(old, 565);
  rerender(<PluginSidebarWidget plugin={growing(240, false)} title="Usage limits" />);
  const current = container.querySelector('iframe')!;
  expect(current).not.toBe(old); expect(current.style.height).toBe('240px');
  send(current, 565); expect(current.style.height).toBe('240px');
});
test('the frame is named by the title its caller gives (E64), not by the plugin id', () => {
  const {container} = render(<PluginSidebarWidget plugin={plugin('nim-orb')} title="Activity Status" />);
  expect(container.querySelector('iframe')!.getAttribute('title')).toBe('Activity Status');
});

// Owner ruling E465: a widget that opts into `frame: "section"` has NO background of its own, so the
// sidebar's shows through. Chromium paints an OPAQUE backdrop (the dark canvas, rgb(18, 18, 18)) behind an
// iframe whose document declares a colour scheme the iframe ELEMENT does not share, which is the
// darker panel the owner saw. The host therefore gives the frame a transparent background and keeps
// the element's colour scheme equal to the scheme its document declares. Only the section frame
// does this: every other widget keeps its exact inline style.
const sectioned = (height = 240) => ({
  name: 'usage-limits', api_base: '/plugins/usage-limits', sidebar_widget: {path: '/widget', height, grow: true, frame: 'section'},
} as PluginInfo);
const declareScheme = (frame: HTMLIFrameElement, value: string) => {
  // jsdom does not navigate the frame, so its document starts without a root element.
  const doc = frame.contentDocument!;
  const root = (doc.documentElement ?? doc.appendChild(doc.createElement('html'))) as HTMLElement;
  root.style.setProperty('color-scheme', value);
};
test('section frame (E465): the iframe paints no background and starts on the neutral colour scheme', () => {
  const {container} = render(<PluginSidebarWidget plugin={sectioned()} title="Usage limits" section />);
  const frame = container.querySelector('iframe')!;
  expect(frame.style.background).toBe('transparent');
  expect(frame.style.colorScheme).toBe('normal');
});
test.each([['dark'], ['light'], ['light dark'], ['dark light']])(
  'section frame (E465): the frame element takes the colour scheme its document declares (%s), on load and on every resize report', scheme => {
    const {container} = render(<PluginSidebarWidget plugin={sectioned()} title="Usage limits" section />);
    const frame = container.querySelector('iframe')!;
    declareScheme(frame, scheme); fireEvent.load(frame);
    expect(frame.style.colorScheme).toBe(scheme);
    declareScheme(frame, 'normal'); send(frame, 300);
    expect(frame.style.colorScheme).toBe('normal');
    declareScheme(frame, scheme); send(frame, 310);
    expect(frame.style.colorScheme).toBe(scheme);
    expect(frame.style.height).toBe('310px');
  });
test('section frame (E465): a document that declares nothing leaves the element on the neutral scheme', () => {
  const {container} = render(<PluginSidebarWidget plugin={sectioned()} title="Usage limits" section />);
  const frame = container.querySelector('iframe')!;
  fireEvent.load(frame);
  expect(frame.style.colorScheme).toBe('normal');
});
test.each([['dark', 'dark'], ['light dark', 'light dark'], ['  Dark ', 'dark'], ['<b>', 'normal'], ['dark; background: red', 'normal']])(
  'section frame (E465): a <meta name="color-scheme" content="%s"> counts when the stylesheet declares none', (content, expected) => {
    const {container} = render(<PluginSidebarWidget plugin={sectioned()} title="Usage limits" section />);
    const frame = container.querySelector('iframe')!;
    const doc = frame.contentDocument!;
    const root = doc.documentElement ?? doc.appendChild(doc.createElement('html'));
    const meta = doc.createElement('meta'); meta.setAttribute('name', 'Color-Scheme'); meta.setAttribute('content', content);
    root.appendChild(meta);
    fireEvent.load(frame);
    expect(frame.style.colorScheme).toBe(expected);
    // A scheme the stylesheet declares wins over the meta.
    declareScheme(frame, 'light'); fireEvent.load(frame);
    expect(frame.style.colorScheme).toBe('light');
  });
test('section frame (E465): an unreadable or malformed document scheme falls back to neutral, never throws', () => {
  const {container} = render(<PluginSidebarWidget plugin={sectioned()} title="Usage limits" section />);
  const frame = container.querySelector('iframe')!;
  declareScheme(frame, 'dark'); fireEvent.load(frame); expect(frame.style.colorScheme).toBe('dark');
  Object.defineProperty(frame, 'contentDocument', {configurable: true, get: () => {throw new Error('cross-origin');}});
  fireEvent.load(frame); expect(frame.style.colorScheme).toBe('normal');
  Object.defineProperty(frame, 'contentDocument', {configurable: true, get: () => null});
  send(frame, 120); expect(frame.style.colorScheme).toBe('normal');
});
test('section frame (E465): every other widget keeps its exact inline style, whatever its document declares', () => {
  const {container} = render(<><PluginSidebarWidget plugin={growing()} title="Usage limits" /><PluginSidebarWidget plugin={plugin()} title="Usage" /></>);
  for (const frame of Array.from(container.querySelectorAll('iframe'))) {
    declareScheme(frame, 'dark'); fireEvent.load(frame); send(frame, 100);
    expect(frame.getAttribute('style')).not.toMatch(/background|color-scheme/);
    expect(frame.style.background).toBe(''); expect(frame.style.colorScheme).toBe('');
  }
});
test('section frame (E465): changing the opt-in replaces the frame', () => {
  const {container, rerender} = render(<PluginSidebarWidget plugin={sectioned()} title="Usage limits" section />);
  const old = container.querySelector('iframe')!;
  rerender(<PluginSidebarWidget plugin={sectioned()} title="Usage limits" />);
  const current = container.querySelector('iframe')!;
  expect(current).not.toBe(old); expect(current.style.background).toBe('');
});
