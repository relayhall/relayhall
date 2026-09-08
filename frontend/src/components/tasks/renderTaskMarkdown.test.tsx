// @vitest-environment jsdom
/**
 * Stored-XSS pins for the task-detail markdown renderer (task da1209f5;
 * same safety-floor class as review a2b2f742 F2). Task descriptions are
 * stored agent-writable content, so renderTaskMarkdown's output must end
 * with the shared DOMPurify pass — with the file-link rewrite still working.
 */
import { describe, expect, test } from 'vitest';

import { renderTaskMarkdown } from './renderTaskMarkdown';

describe('renderTaskMarkdown sanitization', () => {
  test('event-handler, script and javascript:-URL payloads are stripped', () => {
    const html = renderTaskMarkdown(
      '# Heading\n\n<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n\n[bad](javascript:alert(3))\n\n**benign bold**',
    );
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    // Benign Markdown still renders.
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>benign bold</strong>');
  });

  test('the file-link rewrite survives sanitization (data-file-link preserved)', () => {
    const html = renderTaskMarkdown('[spec](docs/spec.md)');
    expect(html).toContain('data-file-link="docs/spec.md"');
    expect(html).toContain('href="#"');
  });

  test('navigable http links stay ordinary anchors', () => {
    const html = renderTaskMarkdown('[site](https://example.test/page)');
    expect(html).toContain('href="https://example.test/page"');
    expect(html).not.toContain('data-file-link');
  });

  test('a javascript: href cannot ride through the file-link rewrite', () => {
    // Not browser-navigable -> rewritten to href="#" + data-file-link; even
    // if a future rewrite change let it through, the sanitizer runs LAST.
    const html = renderTaskMarkdown('[x](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('javascript:alert');
  });

  test('empty input renders empty output', () => {
    expect(renderTaskMarkdown('')).toBe('');
  });
});
