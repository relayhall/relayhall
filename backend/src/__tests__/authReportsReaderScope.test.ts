// Pre-migration substrate mock: every principal lookup fails with undefined_table; legacy behaviour must stay byte-identical on that path.
jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn().mockRejectedValue(Object.assign(new Error('relation "principals" does not exist'), { code: '42P01' })),
  },
}));

describe('reports reader credential scope', () => {
  beforeEach(() => { jest.resetModules(); process.env.JWT_SECRET = 'test-secret'; process.env.RELAYHALL_REPORTS_READ_API_KEY = 'reports-read-secret'; });
  async function invoke(path: string, method: string, baseUrl = '', key = 'reports-read-secret') {
    const { authMiddleware } = await import('../middleware/auth'); const req: any = { baseUrl, path, method, headers: { 'x-reports-read-key': key } }; let status = 200; let next = false;
    const res: any = { status: (s: number) => { status = s; return res; }, json: () => res }; await authMiddleware(req, res, () => { next = true; }); return { status, next, userId: req.userId };
  }
  const RID = '11111111-1111-4111-8111-111111111111';
  it('accepts GET on reports list and item', async () => {
    expect(await invoke('/', 'GET', '/reports')).toMatchObject({ status: 200, next: true, userId: 'reports_reader' });
    expect(await invoke(`/${RID}`, 'GET', '/reports')).toMatchObject({ status: 200, next: true, userId: 'reports_reader' });
  });
  it('rejects non-GET methods with the key', async () => {
    expect(await invoke('/', 'POST', '/reports')).toMatchObject({ status: 403, next: false });
    expect(await invoke(`/${RID}`, 'PATCH', '/reports')).toMatchObject({ status: 403, next: false });
    expect(await invoke(`/${RID}`, 'DELETE', '/reports')).toMatchObject({ status: 403, next: false });
    expect(await invoke(`/${RID}`, 'PUT', '/reports')).toMatchObject({ status: 403, next: false });
  });
  it('rejects out-of-scope paths with the key', async () => {
    expect(await invoke('/', 'GET', '/tasks')).toMatchObject({ status: 403, next: false });
    expect(await invoke('/', 'GET', '/webhooks')).toMatchObject({ status: 403, next: false });
  });
  it('rejects the retired journal paths — the journal:read grant left with the Journal plugin', async () => {
    // P1.3 ruling A7: reports_reader used to carry journal:read for the
    // knowledge-fabric connector. The grant was trimmed in code (no new
    // migration; the dormant seed rows keep their stored scopes) and every
    // journal path must now fail closed for this key.
    expect(await invoke('/', 'GET', '/journal')).toMatchObject({ status: 403, next: false });
    expect(await invoke('/latest', 'GET', '/journal')).toMatchObject({ status: 403, next: false });
    expect(await invoke(`/${RID}`, 'GET', '/journal')).toMatchObject({ status: 403, next: false });
  });
  it('rejects a wrong key value on a scoped path', async () => {
    expect(await invoke('/', 'GET', '/reports', 'wrong-key')).toMatchObject({ status: 403, next: false });
  });
});
