/**
 * Appearance asset store and public serving (RH-DESIGN.6 §7).
 *
 * The properties under test are the ones §7 states as acceptance criteria, not
 * the ones that happen to be easy: only the ACTIVE row is reachable without
 * authentication, stored bytes are the stripped re-serialization rather than the
 * upload, the swap is atomic, and the response carries `nosniff` with the exact
 * stored MIME.
 */
import express from 'express';
import http from 'http';

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock('../db/connection', () => ({
  pool: {
    query: (...args: any[]) => mockQuery(...args),
    connect: async () => ({ query: (...args: any[]) => mockClientQuery(...args), release: mockRelease }),
  },
}));

import appearanceRoutes from '../routes/appearance';
import { AppearanceService } from '../services/AppearanceService';
import { AssetRejected } from '../utils/imageSafety';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function png(width = 64, height = 64, extra: Buffer[] = []): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', header),
    ...extra,
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000000',
    kind: 'logo',
    bytes: Buffer.from([1, 2, 3, 4]),
    mime: 'image/png',
    width: 64,
    height: 64,
    byte_size: 4,
    sha256: 'c0ffee',
    active: true,
    created_at: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

// A real server on an ephemeral port, matching the house route-test pattern
// (grantsRoutes.test.ts): the response headers under test are set by Express and
// by Node's HTTP layer, and a fake request/response object would let a wrong
// header pass by never having been written.
let server: http.Server;
let baseUrl: string;

beforeAll((done) => {
  const instance = express();
  instance.use('/appearance', appearanceRoutes);
  server = instance.listen(0, () => {
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}${path}`, { method: 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    request.on('error', reject);
    request.end();
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockClientQuery.mockReset();
  mockRelease.mockReset();
});

const ACTIVE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STALE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('the asset URL is content-addressed (review 0cd2ee83, F2)', () => {
  it('redirects the kind URL to the active sha, and is itself never cached', async () => {
    // The blocking finding: `immutable, max-age=31536000` sat on a URL keyed
    // only by KIND, so replacing a logo left caches serving the old bytes for a
    // year with no way to invalidate them. An ETag cannot repair that — an
    // immutable response is never revalidated. The discovery URL now carries
    // no-store and points at the content-addressed one.
    mockQuery.mockResolvedValue({ rows: [assetRow({ sha256: ACTIVE_SHA })] });
    const response = await get('/appearance/assets/logo');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`/api/appearance/assets/logo/${ACTIVE_SHA}`);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('replacing the asset changes the URL', async () => {
    mockQuery.mockResolvedValue({ rows: [assetRow({ sha256: ACTIVE_SHA })] });
    const before = (await get('/appearance/assets/logo')).headers.location;
    mockQuery.mockResolvedValue({ rows: [assetRow({ sha256: STALE_SHA })] });
    const after = (await get('/appearance/assets/logo')).headers.location;
    expect(before).not.toBe(after);
  });

  it('a sha that is not the active one reaches nothing', async () => {
    // Covers a stale client AND the §7 rule that superseded bytes are
    // unreachable without authentication: the answer is identical for
    // "superseded", "nothing set" and "never existed", so the public surface
    // discloses no history.
    mockQuery.mockResolvedValue({ rows: [assetRow({ sha256: ACTIVE_SHA })] });
    const stale = await get(`/appearance/assets/logo/${STALE_SHA}`);
    expect(stale.status).toBe(404);
    expect(stale.text).not.toContain('superseded');

    mockQuery.mockResolvedValue({ rows: [] });
    const missing = await get(`/appearance/assets/logo/${ACTIVE_SHA}`);
    expect(missing.status).toBe(404);
    expect(missing.text).toBe(stale.text);
  });

  it('rejects a malformed sha before it reaches the database', async () => {
    for (const bad of ['not-a-sha', '../../etc/passwd', 'A'.repeat(64), 'abc']) {
      const response = await get(`/appearance/assets/logo/${encodeURIComponent(bad)}`);
      expect(response.status).toBe(404);
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('GET /appearance/assets/:kind/:sha', () => {
  it('serves the active asset with the exact stored MIME and nosniff', async () => {
    mockQuery.mockResolvedValue({ rows: [assetRow({ sha256: ACTIVE_SHA })] });
    const response = await get(`/appearance/assets/logo/${ACTIVE_SHA}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers.etag).toBe(`"${ACTIVE_SHA}"`);
    // Immutable ONLY here, where the URL is bound to the content.
    expect(response.headers['cache-control']).toContain('immutable');
  });

  it('constrains the query to the ACTIVE row — a superseded asset is unreachable', async () => {
    // §7 acceptance: an unauthenticated fetch of a superseded version is 403/404.
    // The structural guarantee is that the public path cannot NAME a row at all,
    // so the predicate has to be in the query rather than in a filter afterwards.
    mockQuery.mockResolvedValue({ rows: [assetRow({ sha256: ACTIVE_SHA })] });
    await get(`/appearance/assets/logo/${ACTIVE_SHA}`);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/AND\s+active/i);
    expect(params).toEqual(['logo']);
  });

  it('404s an unknown kind without disclosing which kinds exist', async () => {
    const response = await get('/appearance/assets/not-a-kind');
    expect(response.status).toBe(404);
    expect(response.text).not.toMatch(/logo|favicon|mark/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('404s a kind with nothing set, so the frontend falls back to the built-in', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const response = await get('/appearance/assets/favicon');
    expect(response.status).toBe(404);
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    mockQuery.mockResolvedValue({ rows: [assetRow({ sha256: ACTIVE_SHA })] });
    const response = await get(`/appearance/assets/logo/${ACTIVE_SHA}`,
                              { 'If-None-Match': `"${ACTIVE_SHA}"` });
    expect(response.status).toBe(304);
    expect(response.text).toBe('');
  });

  it('never serializes a caught exception into the response', async () => {
    // Postgres puts the OFFENDING ROW into `detail` on constraint violations,
    // and this route is public. The safety floor, restated as a test.
    const hostile: any = new Error('duplicate key');
    hostile.detail = 'Key (kind)=(logo) already exists.';
    mockQuery.mockRejectedValue(hostile);

    const response = await get(`/appearance/assets/logo/${ACTIVE_SHA}`);
    expect(response.status).toBe(500);
    expect(response.text).not.toContain('duplicate key');
    expect(response.text).not.toContain('already exists');
  });
});

describe('the unauthenticated surface stays exactly these two routes', () => {
  it('exposes only the discovery redirect and the content-addressed read', () => {
    // This router is mounted WITHOUT authMiddleware, because deployment identity
    // is public pre-login by design (§5.4). That makes it a trap for the next
    // person: an authenticated Appearance route added to this file would inherit
    // no authentication at all. The pin turns that into a failing test rather
    // than a silent hole, so RH-UI.4's remaining surfaces have to be mounted
    // deliberately somewhere that authenticates. It is an exact list, so
    // GROWING the public surface is as loud as changing it.
    const layers = (appearanceRoutes as any).stack.filter((layer: any) => layer.route);
    const routes = layers.map((layer: any) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort(),
    }));
    expect(routes).toEqual([
      { path: '/assets/:kind', methods: ['get'] },
      { path: '/assets/:kind/:sha', methods: ['get'] },
    ]);
  });
});

describe('AppearanceService.putAsset', () => {
  it('stores the STRIPPED bytes, never the upload as received', async () => {
    const uploaded = png(64, 64, [chunk('tEXt', Buffer.from('Author\0Someone', 'latin1'))]);
    expect(uploaded.includes(Buffer.from('Someone'))).toBe(true);

    mockClientQuery.mockImplementation(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO appearance_assets/i.test(sql)) {
        return { rows: [assetRow({ bytes: params[1], byte_size: params[1].length })] };
      }
      if (/INSERT INTO appearance_versions/i.test(sql)) {
        return { rows: [{
          id: 'version-1', version_no: 1, snapshot: {}, asset_refs: { logo: 'asset-1' },
          reason: 'save', created_at: '2026-08-12T00:00:00.000Z', created_by: null,
        }] };
      }
      return { rows: [] };
    });

    await new AppearanceService().putAsset('logo', uploaded, null);

    const insert = mockClientQuery.mock.calls.find(([sql]) =>
      /INSERT INTO appearance_assets/i.test(sql)
    )!;
    const storedBytes: Buffer = insert[1][1];
    expect(storedBytes.includes(Buffer.from('Someone'))).toBe(false);
    expect(storedBytes.includes(Buffer.from('tEXt'))).toBe(false);
    expect(storedBytes.equals(uploaded)).toBe(false);
    // The recorded size describes the STORED bytes, not the upload.
    expect(insert[1][5]).toBe(storedBytes.length);
  });

  it('supersedes the previous asset inside one transaction', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (/INSERT INTO appearance_assets/i.test(sql)) return { rows: [assetRow()] };
      if (/INSERT INTO appearance_versions/i.test(sql)) return { rows: [{
        id: 'version-1', version_no: 1, snapshot: {}, asset_refs: { logo: 'asset-1' },
        reason: 'save', created_at: '2026-08-12T00:00:00.000Z', created_by: null,
      }] };
      return { rows: [] };
    });

    await new AppearanceService().putAsset('logo', png(), null);

    const statements = mockClientQuery.mock.calls.map(([sql]) => String(sql).trim().split('\n')[0]);
    expect(statements[0]).toMatch(/^BEGIN$/);
    expect(statements.some((s) => /UPDATE appearance_assets SET active = FALSE/i.test(s))).toBe(true);
    expect(statements.some((s) => /INSERT INTO appearance_versions/i.test(s))).toBe(true);
    expect(statements[statements.length - 1]).toMatch(/^COMMIT$/);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('refuses a hostile upload before it opens a transaction', async () => {
    // A rejected file should never have held a connection: the cheap check runs
    // first, so an upload flood of forbidden formats costs no pool capacity.
    await expect(
      new AppearanceService().putAsset('logo', Buffer.from('<svg onload="x"/>'), null)
    ).rejects.toBeInstanceOf(AssetRejected);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('rolls back and releases when the insert fails', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (/INSERT INTO appearance_assets/i.test(sql)) throw new Error('constraint');
      return { rows: [] };
    });

    await expect(new AppearanceService().putAsset('logo', png(), null)).rejects.toThrow('constraint');
    const statements = mockClientQuery.mock.calls.map(([sql]) => String(sql).trim());
    expect(statements).toContain('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('applies the favicon slot rules through the same path', async () => {
    await expect(
      new AppearanceService().putAsset('favicon', png(64, 32), null)
    ).rejects.toMatchObject({ reason: 'FAVICON_NOT_SQUARE' });
  });
});
