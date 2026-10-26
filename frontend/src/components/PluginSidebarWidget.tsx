import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PluginInfo } from '../types/plugin';
import { attachPluginBridge, trustedPluginMessage } from '../utils/pluginBridge';

/**
 * `ui.sidebar_widget` is `{path, height, grow?}` with height bounded 48..240
 * (docs/contracts/plugin-host-v1.md). The bound is enforced HERE rather than
 * trusted from the manifest the loader read: a declared 999 would push the
 * sidebar's navigation off the rail, and a declared 0 would leave an invisible
 * frame holding a live bridge poll.
 */
export const SIDEBAR_WIDGET_MIN_HEIGHT = 48;
export const SIDEBAR_WIDGET_MAX_HEIGHT = 240;
/**
 * Owner ruling E438(1): the HOST ceiling for a widget that opts in with
 * `grow: true`. Such a widget takes the content height its own frame reports,
 * so a long list shows in full and the sidebar column scrolls as a whole
 * instead of the frame scrolling inside itself; a report above this ceiling is
 * clamped to it, never trusted. 1600 px holds well over the 12 accounts the
 * Usage Limits widget lays out in 565 px.
 */
export const SIDEBAR_WIDGET_GROW_CEILING = 1600;

export function clampSidebarWidgetHeight(height: unknown): number {
  const value = Math.round(Number(height));
  if (!Number.isFinite(value)) return SIDEBAR_WIDGET_MIN_HEIGHT;
  return Math.min(SIDEBAR_WIDGET_MAX_HEIGHT, Math.max(SIDEBAR_WIDGET_MIN_HEIGHT, value));
}

/**
 * `title` is the frame's ACCESSIBLE NAME, and the caller supplies it: the
 * visible label of the block the widget sits in (owner ruling E64). It used to
 * be derived from the plugin id ("<plugin-id> status"), which is a registry key,
 * not a name a person reading the sidebar would recognise.
 */
export function PluginSidebarWidget({plugin, title, section = false}:{plugin:PluginInfo; title:string; section?:boolean}) {
  const base = import.meta.env.VITE_API_BASE_URL || '/api';
  if (!plugin.sidebar_widget) return null;
  const src = base + plugin.api_base + plugin.sidebar_widget.path;
  const declared = clampSidebarWidgetHeight(plugin.sidebar_widget.height);
  // Only an explicit `true` opts in; without it the declared height is the ceiling, as before E438.
  const grow = plugin.sidebar_widget.grow === true;
  const ceiling = grow ? SIDEBAR_WIDGET_GROW_CEILING : declared;
  // A different document/declaration must never inherit the previous widget's size.
  return <AdaptiveSidebarWidget key={JSON.stringify([plugin.name, src, declared, ceiling, section])}
    name={plugin.name} title={title} base={base} src={src} declared={declared} ceiling={ceiling} section={section} />;
}

/**
 * Owner ruling E465: the colour scheme the frame's own document declares, read for the frame element.
 *
 * Chromium paints an OPAQUE backdrop (the dark canvas, rgb(18, 18, 18), for a dark document) behind an iframe
 * whose document's colour scheme differs from the iframe ELEMENT's. A plugin page that declares
 * `color-scheme: dark` inside a host element left at `normal` therefore sat on a darker panel than the
 * sidebar it was meant to show through. The frame is same-origin (`allow-same-origin`), so the host
 * reads the declared value and gives the element the SAME one; equal schemes leave the backdrop
 * transparent. The declaration is the stylesheet's `color-scheme` or, when that is `normal`, the page's
 * `<meta name="color-scheme">`. Anything unreadable or not a plain list of scheme keywords is `normal`, the
 * value a document that declares nothing has.
 */
const SCHEME_KEYWORDS = /^(normal|(only )?(light|dark|[a-z-]+)( (light|dark|[a-z-]+))*)$/;
export function readFrameColorScheme(frame: HTMLIFrameElement | null): string {
  try {
    const doc = frame?.contentDocument;
    const root = doc?.documentElement;
    const view = doc?.defaultView;
    if (!doc || !root || !view) return 'normal';
    const keywords = (raw: string | null | undefined) => {
      const value = (raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
      return value.length <= 64 && SCHEME_KEYWORDS.test(value) ? value : 'normal';
    };
    const declared = keywords(view.getComputedStyle(root).getPropertyValue('color-scheme'));
    if (declared !== 'normal') return declared;
    // `<meta name="color-scheme">` is the other way a page declares it, and the computed style does not show it.
    const meta = Array.from(doc.getElementsByTagName('meta')).find(m => m.getAttribute('name')?.toLowerCase() === 'color-scheme');
    return keywords(meta?.getAttribute('content'));
  } catch {
    return 'normal';
  }
}

function AdaptiveSidebarWidget({name, title, base, src, declared, ceiling, section}: {
  name: string; title: string; base: string; src: string; declared: number; ceiling: number; section: boolean;
}) {
  const [height, setHeight] = useState(declared);
  // Section frames only: the element's colour scheme follows the document's, so the frame paints no backdrop.
  const [scheme, setScheme] = useState('normal');
  const iframe = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const node = iframe.current;
    if (!node) return;
    const stopBridge = attachPluginBridge(node, name, base);
    const resize = (event: MessageEvent) => {
      if (!trustedPluginMessage(event, node) || event.data?.type !== 'iframeResize') return;
      const requested = event.data.height;
      if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return;
      setHeight(Math.min(ceiling, Math.max(SIDEBAR_WIDGET_MIN_HEIGHT, Math.ceil(requested))));
      if (section) setScheme(readFrameColorScheme(node));
    };
    window.addEventListener('message', resize);
    return () => {
      window.removeEventListener('message', resize);
      stopBridge();
    };
  }, [name, base, ceiling, section]);
  const onLoad = () => {
    setHeight(declared);
    if (section) setScheme(readFrameColorScheme(iframe.current));
  };
  const style: CSSProperties = section
    ? {width:'100%', height, border:0, display:'block', background:'transparent', colorScheme:scheme}
    : {width:'100%', height, border:0, display:'block'};
  return <iframe ref={iframe} title={title} src={src}
    onLoad={onLoad}
    style={style}
    sandbox="allow-same-origin allow-scripts" />;
}
