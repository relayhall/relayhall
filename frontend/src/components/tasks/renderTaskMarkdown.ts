import { marked } from 'marked';
import { sanitizeRenderedHtml } from '../../utils/renderMarkdown';
import { isBrowserNavigableUrl } from './taskDetailSections';

const DASHBOARD_BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

function buildDashboardHref(path: string): string {
  if (!path) return DASHBOARD_BASE || '/';
  if (/^(?:https?:)?\/\//.test(path)) return path;
  if (path.startsWith('/')) return `${DASHBOARD_BASE}${path}`;
  return `${DASHBOARD_BASE}/${path}`;
}

export function renderTaskMarkdown(markdown: string): string {
  if (!markdown) return '';
  const html = marked.parse(markdown, { breaks: true, gfm: true }) as string;
  const rewritten = html.replace(/<a\s+href="([^"]+)"([^>]*)>/g, (_match, href: string, attrs: string) => {
    if (isBrowserNavigableUrl(href)) return `<a href="${buildDashboardHref(href)}"${attrs}>`;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return `<a href="#"${attrs}>`;
    return `<a href="#" data-file-link="${href}"${attrs}>`;
  });
  // Load-bearing stored-XSS floor: nothing may transform the HTML after this.
  return sanitizeRenderedHtml(rewritten);
}
