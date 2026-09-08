// Sanitized Markdown rendering (review a2b2f742 F2).
//
// Stored board content is data, never trusted markup: `marked` preserves raw
// HTML verbatim, so every dangerouslySetInnerHTML sink fed from it must pass
// through DOMPurify first or pasted/imported content can execute in every
// reader's dashboard (the auth token is JS-readable). USE_PROFILES html keeps
// ordinary formatting (headings, tables, links, code) while stripping
// scripts, event-handler attributes and javascript:-class URL schemes.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * The one sanitization pass every stored-content HTML sink must end with.
 * Exported separately (task da1209f5) so callers that post-process the
 * rendered markup — like TaskDetailModal's file-link rewrite — can run their
 * transforms BEFORE this pass: nothing may run after the sanitizer.
 * data-* attributes survive (DOMPurify default), so data-file-link is kept.
 */
export function sanitizeRenderedHtml(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

export function renderMarkdownSafe(text: string): string {
  marked.setOptions({ breaks: true, gfm: true });
  const html = marked.parse(text) as string;
  return sanitizeRenderedHtml(html);
}
