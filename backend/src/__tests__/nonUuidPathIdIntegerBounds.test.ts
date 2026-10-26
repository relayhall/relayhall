/** E159: service-side guards remain independently testable even when a route
 * rejects first. The failure doubles identify any attempted database read. */
import { pool } from '../db/connection';
import { serviceRegistry } from '../services/ServiceRegistry';
import { appearanceService } from '../services/AppearanceService';
import { charterService } from '../services/CharterService';

const ID = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
beforeEach(() => {
  jest.restoreAllMocks();
  const failure = Object.assign(new Error('int4 overflow reached database'), { code: '22003' });
  jest.spyOn(pool, 'query').mockRejectedValue(failure as never);
  jest.spyOn(pool, 'connect').mockRejectedValue(failure as never);
});
afterAll(() => jest.restoreAllMocks());

describe.each([
  ['descriptor read', 'INVALID_QUERY_VALUE', (n: number) => serviceRegistry.getDescriptorVersion(ID, n)],
  ['descriptor retire', 'INVALID_QUERY_VALUE', (n: number) => serviceRegistry.retireDescriptorVersion(ID, n, null)],
  ['appearance revert', 'INVALID_VERSION', (n: number) => appearanceService.revert(n, null)],
  ['charter read', 'INVALID_QUERY_VALUE', (n: number) => charterService.getVersion(ID, n)],
] as const)('%s integer bound', (_name, code, invoke) => {
  it.each([2147483648, 99999999999])('refuses %p before query or connect', async (n) => {
    await expect(invoke(n)).rejects.toMatchObject({ code });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
