/*
 * DRIFT CONTROL — the backend must see the browser's origin: scheme, host AND
 * port.
 *
 * The backend names its own address in the one-time onboarding pack
 * (`boardEndpoint`, the bootstrap line, every MCP URL, the CLI line). Unless a
 * deployment declares `RELAYHALL_PUBLIC_API_URL`, it builds that address from
 * the request (`backend/src/utils/onboardingPack.ts`, `boardEndpointFor`):
 * `X-Forwarded-Proto`, then `X-Forwarded-Host` or `Host`. This nginx sits
 * between the browser (or an outer TLS proxy) and the backend, so what it sends
 * IS the origin the pack names. Two lines were wrong for every install:
 *
 *  - `proxy_set_header Host $host;` — `$host` is the host name WITHOUT its port,
 *    so an install served at `http://localhost:8082` handed out
 *    `http://localhost/api`;
 *  - `proxy_set_header X-Forwarded-Proto $scheme;` — `$scheme` is this nginx's
 *    own scheme, always `http` inside the container, so behind a TLS proxy the
 *    pack said `http://` on an HTTPS port.
 *
 * The repair, pinned here against the real file (comments stripped):
 *
 *  (a) a top-level `map` gives `$relayhall_forwarded_proto`: `https` or `http`
 *      when an outer proxy declared that scheme first in `X-Forwarded-Proto`,
 *      else this nginx's own `$scheme` — so a direct request is unchanged, and
 *      no other text a client sends in that header is ever passed on;
 *  (b) a top-level `map` gives `$relayhall_forwarded_host`: the `Host` header
 *      exactly as it arrived (`$http_host`, port included), else `$host` when a
 *      client sent none;
 *  (c) EVERY proxied location sends `Host $relayhall_forwarded_host`, and none
 *      sends `Host $host` or `X-Forwarded-Host` (an outer proxy's own
 *      `X-Forwarded-Host` passes through untouched and still wins);
 *  (d) EVERY proxied location sends `X-Forwarded-Proto
 *      $relayhall_forwarded_proto`, and none sends `$scheme`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '../nginx.conf'), 'utf-8')
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .join('\n');

/** Top-level blocks (`map ... { ... }`, `server { ... }`) with their bodies. */
function topLevelBlocks(source: string): Array<{ head: string; body: string }> {
  const out: Array<{ head: string; body: string }> = [];
  let depth = 0;
  let head = '';
  let body = '';
  for (const ch of source) {
    if (ch === '{') {
      if (depth === 0) { head = body.trim().split(/[;}]/).pop()!.trim(); body = ''; } else body += ch;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) { out.push({ head, body }); body = ''; } else body += ch;
      continue;
    }
    body += ch;
  }
  return out;
}

/** Every `location` that proxies, with its directive body. */
function proxiedLocations(source: string): Array<{ match: string; body: string }> {
  const re = /location\s+([^{]+?)\s*\{([^{}]*)\}/g;
  const out: Array<{ match: string; body: string }> = [];
  let m = re.exec(source);
  while (m !== null) {
    if (/\bproxy_pass\b/.test(m[2])) out.push({ match: m[1].trim(), body: m[2] });
    m = re.exec(source);
  }
  return out;
}

function mapBody(name: string): string {
  const block = topLevelBlocks(SOURCE).find((b) => new RegExp(`^map\\s+\\S+\\s+\\$${name}$`).test(b.head));
  expect(block, `top-level map defining $${name}`).toBeDefined();
  return block!.body.replace(/\s+/g, ' ').trim();
}

describe('the forwarded scheme (a)', () => {
  it('is a top-level map over the incoming X-Forwarded-Proto, defaulting to this nginx scheme', () => {
    const head = topLevelBlocks(SOURCE).find((b) => /\$relayhall_forwarded_proto$/.test(b.head))!.head;
    expect(head).toMatch(/^map\s+\$http_x_forwarded_proto\s+\$relayhall_forwarded_proto$/);
    const body = mapBody('relayhall_forwarded_proto');
    expect(body).toContain('default $scheme;');
    expect(body).toContain('~*^https\\s*(,|$) https;');
    expect(body).toContain('~*^http\\s*(,|$) http;');
  });

  it('passes on only the two schemes, never the raw header', () => {
    const body = mapBody('relayhall_forwarded_proto');
    const values = body.split(';').map((entry) => entry.trim()).filter(Boolean)
      .map((entry) => entry.split(/\s+/).pop());
    expect(values.sort()).toEqual(['$scheme', 'http', 'https']);
  });
});

describe('the forwarded host (b)', () => {
  it('is a top-level map over the incoming Host header, port included, defaulting to $host', () => {
    const head = topLevelBlocks(SOURCE).find((b) => /\$relayhall_forwarded_host$/.test(b.head))!.head;
    expect(head).toMatch(/^map\s+\$http_host\s+\$relayhall_forwarded_host$/);
    const body = mapBody('relayhall_forwarded_host');
    expect(body).toContain('default $http_host;');
    expect(body).toContain('"" $host;');
  });
});

describe('every proxied location (c, d)', () => {
  const locations = proxiedLocations(SOURCE);

  it('the census finds the API and both WebSocket routes', () => {
    expect(locations.map((l) => l.match).sort()).toEqual(['/api/', '= /api/events/ws', '= /api/ws', '= /ws'].sort());
  });

  it.each(locations.map((l) => [l.match, l.body]))('%s sends Host with its port and the forwarded scheme', (_match, body) => {
    const headers = (body as string).match(/proxy_set_header\s+\S+\s+[^;]+;/g) ?? [];
    const named = (name: string) => headers.filter((h) => new RegExp(`^proxy_set_header\\s+${name}\\s`, 'i').test(h));
    expect(named('Host')).toEqual(['proxy_set_header Host $relayhall_forwarded_host;']);
    expect(named('X-Forwarded-Proto')).toEqual(['proxy_set_header X-Forwarded-Proto $relayhall_forwarded_proto;']);
    expect(named('X-Forwarded-Host')).toEqual([]);
  });

  it('no line anywhere forwards the port-less $host or this nginx scheme', () => {
    expect(SOURCE).not.toMatch(/proxy_set_header\s+Host\s+\$host\s*;/);
    expect(SOURCE).not.toMatch(/proxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;/);
  });
});

describe('the favicon', () => {
  it('/favicon.ico is served from the built assets, not logged as an error', () => {
    const block = SOURCE.match(/location\s*=\s*\/favicon\.ico\s*\{([^{}]*)\}/);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/\balias\s+\/usr\/share\/nginx\/html\/favicon\.ico\s*;/);
    expect(block![1]).toMatch(/\blog_not_found\s+off\s*;/);
  });
});
