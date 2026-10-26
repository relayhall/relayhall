import { lockDependencyGraph } from '../db/dependencyGraph';
import type { CreationTransaction } from '../db/creationTransaction';

test('outer transaction without preparation fails before any late lock or graph read', async () => {
  const client = { query: jest.fn() } as any;
  await expect(lockDependencyGraph(client, { client } as CreationTransaction)).rejects.toThrow('prepared creation transaction');
  expect(client.query).not.toHaveBeenCalled();
});
test('prepared outer transaction retains its first lock without another SELECT or lock', async () => {
  const client = { query: jest.fn() } as any;
  await lockDependencyGraph(client, { client, dependencyGraphLocked: true } as CreationTransaction);
  expect(client.query).not.toHaveBeenCalled();
});
