/*
 * DRIFT CONTROL — nginx redirects must not downgrade https to http.
 *
 * Card bef2f3e7: `location = / { return 302 /dashboard/; }` answered a browser
 * that arrived on https with `Location: http://<host>/dashboard/`. nginx
 * absolutizes a relative Location using its OWN `$scheme`, and inside the
 * container behind the TLS-terminating proxy that scheme is http. The repair is
 * `absolute_redirect off;` at SERVER scope, so every `return 30x /path` in the
 * file emits a relative `Location: /path` and the browser keeps the scheme and
 * host it arrived on.
 *
 * Three things this test pins, against the real file on disk (no mock):
 *
 *  (a) `absolute_redirect off;` is present at server scope — directly inside
 *      `server { … }`, NOT merely inside some location. Three locations
 *      already carried a location-level copy before the card, and the root
 *      redirect was the one that did not; a test that accepted "anywhere in the
 *      file" or "anywhere inside server{}" would have been green on the defect.
 *  (b) every `return 301|302` target is a same-origin path (`/…`, and NOT
 *      protocol-relative `//host/…`): no scheme, no host, so nothing in this
 *      file can pin a redirect to http:// or send it off-origin.
 *  (c) the redirect locations still exist — the fix is a directive, not a
 *      change to any target or code.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NGINX_CONF = join(HERE, '../nginx.conf');

/** The file with `#` comments stripped, so a commented-out directive cannot satisfy anything below. */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

/**
 * Directives that sit DIRECTLY inside the `server { … }` block (brace depth 1
 * relative to the server block), one per element, semicolon-terminated.
 * Location bodies are depth 2 and are excluded on purpose — see (a) above.
 */
function serverScopeDirectives(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inServer = false;
  let buf = '';
  for (const ch of source) {
    if (ch === '{') {
      const head = buf.trim();
      buf = '';
      if (depth === 0 && /^server$/.test(head)) inServer = true;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      buf = '';
      if (depth === 0) inServer = false;
      continue;
    }
    if (ch === ';') {
      if (inServer && depth === 1) out.push(buf.trim().replace(/\s+/g, ' '));
      buf = '';
      continue;
    }
    buf += ch;
  }
  return out;
}

/** Every `location <match> {` header in the file, in order, normalised to one space. */
function locationHeaders(source: string): string[] {
  const re = /location\s+([^{]+?)\s*\{/g;
  const out: string[] = [];
  let m = re.exec(source);
  while (m !== null) {
    out.push(m[1].trim().replace(/\s+/g, ' '));
    m = re.exec(source);
  }
  return out;
}

const EXPECTED_REDIRECT_LOCATIONS = ['= /', '= /about', '= /settings', '/settings/', '= /dashboard'];

describe('frontend/nginx.conf keeps the request scheme on redirects (card bef2f3e7)', () => {
  const raw = readFileSync(NGINX_CONF, 'utf8').replace(/\r\n/g, '\n');
  const conf = stripComments(raw);

  it('(a) declares absolute_redirect off at server scope, not merely inside a location', () => {
    const directives = serverScopeDirectives(conf);
    expect(directives.length).toBeGreaterThan(0);
    expect(directives).toContain('absolute_redirect off');
  });

  it('(b) every return 301/302 target is a same-origin path — no scheme, no host, not protocol-relative', () => {
    const returns = [...conf.matchAll(/\breturn\s+30[12]\s+(\S+)\s*;/g)].map((m) => m[1]);
    expect(returns.length).toBeGreaterThan(0);
    for (const target of returns) {
      expect(target, `redirect target ${target}`).toMatch(/^\//);
      expect(target, `redirect target ${target}`).not.toMatch(/^\/\//);
      expect(target, `redirect target ${target}`).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
    }
  });

  it('(c) the redirect locations still exist', () => {
    const headers = locationHeaders(conf);
    for (const expected of EXPECTED_REDIRECT_LOCATIONS) {
      expect(headers, `location ${expected}`).toContain(expected);
    }
  });
});
