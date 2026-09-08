/**
 * Card `510cd72c` — `relayhall_task_recover` can perform a recovery.
 *
 * ── THE DEFECT ──
 *
 * The tool advertised `task`, `reason` and `assignTo` and forwarded exactly
 * those. `POST /tasks/:id/recover` REQUIRES a non-null `executionProfile` and
 * answers `REASSIGNMENT_REQUIRED` without one, and it never reads `assignTo`.
 * So EVERY schema-valid call through the named tool was refused before it
 * began: the advertised operation could not be performed from the MCP surface
 * at all, and a caller naming a reassignment target had that target silently
 * dropped. ANNEX A `dd3aaa9e` §6A's leg that calls `task_recover` twice over
 * `/mcp` was DECLARED NOT DRILLED for this reason.
 *
 * ── WHY THIS SUITE GOES THROUGH THE SEAM RATHER THAN AROUND IT ──
 *
 * A test that read `MCP_TOOLS` and asserted `executionProfile` is in the
 * schema would pass on a tool whose HANDLER still dropped the argument — the
 * schema is documentation, not a gate (census C-1: nothing on this surface
 * validates a tool's inputSchema). So every drill below calls the tool's own
 * handler and lets it reach the REAL route: `board` → `dispatchInProcess` →
 * the same `routeRegistry` routers, the same `sharedAuthorizationMiddleware`
 * ceiling, the same `express.json()` parser and the same handler production
 * serves. What the route does with the body is what these tests read.
 *
 * ── WHAT IS STUBBED, AND WHY EXACTLY THOSE ──
 *
 * Only what needs a database, which is the bound `c4McpTransport` states for
 * the same ingress: the credential lookup, the point-authorization read, and —
 * in the success drill alone — the Connector registry read and the recovery
 * write itself. Every refusal drill below stubs NOTHING past authentication:
 * `REASSIGNMENT_REQUIRED`, `PROFILE_INVOKE_REQUIRED`, `FIELD_RETIRED` and
 * `INVALID_WARRANT_ID` are all produced by the shipped route before it touches
 * a row, so they are measured against the real thing and not a double.
 */
import { toolByName } from '../mcp/registry';
import { principalService, type Principal, type PrincipalCredential } from '../services/PrincipalService';
import { authorizationRepository } from '../services/AuthorizationRepository';
import * as executionProfile from '../utils/executionProfile';
import { taskManagerDB as taskManager } from '../services/TaskManagerDB';
import { loadMutatedModule } from './support/moduleMutation';

const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';
const TASK = '33333333-3333-4333-8333-333333333333';
const SERVICE = '44444444-4444-4444-8444-444444444444';
const WARRANT = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'rh_dev_keyid01.secretsecretsecretsecret';
const CTX = { authorization: `Bearer ${TOKEN}`, toolName: 'relayhall_task_recover' };

/** A well-formed profile: the shape `resolveExecutionProfileWrite` accepts. */
const PROFILE = { serviceId: SERVICE, descriptorVersion: 1, options: { model: 'x' } };

function principalRow(): Principal {
  return {
    id: PRINCIPAL_ID, kind: 'service', handle: 'shepherd_one', displayName: 'Shepherd One',
    status: 'active', role: 'orchestrator', boundTaskId: null, purpose: null, legacyIdentity: false,
    ownExpression: null, sourceTag: null, harness: null, personalityId: null,
    parentPrincipalId: null, lastSeenAt: null, metadata: {},
  };
}

function credentialRow(scopes: string[]): PrincipalCredential {
  return {
    id: '22222222-2222-4222-8222-222222222222', principalId: PRINCIPAL_ID,
    credentialType: 'api_key', keyId: 'keyid01', scopes,
    expiresAt: null, revokedAt: null, transport: 'mcp', graceUntil: null, metadata: {},
  };
}

/** Authenticate as an mcp-pinned Connector holding `scopes`. */
function authenticateWith(scopes: string[]): void {
  jest.spyOn(principalService, 'authenticatePrincipalKey')
    .mockResolvedValue({ principal: principalRow(), credential: credentialRow(scopes) });
}

/** Call the tool exactly as the MCP dispatcher does. */
async function recover(args: Record<string, unknown>): Promise<string> {
  const tool = toolByName('relayhall_task_recover');
  if (!tool) throw new Error('relayhall_task_recover is not registered');
  return tool.handler(args, CTX);
}

/** The tool's refusal text, or a marker if it did not refuse. */
async function refusalOf(args: Record<string, unknown>): Promise<string> {
  try {
    await recover(args);
    return 'NOT_REFUSED';
  } catch (err) {
    return (err as Error).message;
  }
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(principalService, 'bumpLastSeen').mockImplementation(() => undefined as never);
  // The point predicate authorizes `shepherd` on this Task. Its answer needs a
  // database; that it is CONSULTED at all is the ceiling's own contract and is
  // drilled where the ceiling lives, not here.
  jest.spyOn(authorizationRepository, 'authorizePoint')
    .mockResolvedValue({ exists: true, allowed: true } as never);
  authenticateWith(['tasks:write', 'services:invoke']);
});

describe('the tool advertises what the route requires', () => {
  const tool = toolByName('relayhall_task_recover');
  const schema = tool?.inputSchema as {
    required: string[];
    properties: Record<string, unknown>;
  };

  it('requires executionProfile, because the route does', () => {
    expect(schema.required).toEqual(['task', 'executionProfile']);
  });

  it('carries the optional executionWarrantId the route consumes beside it', () => {
    expect(Object.keys(schema.properties).sort())
      .toEqual(['executionProfile', 'executionWarrantId', 'reason', 'task']);
  });

  it('no longer advertises assignTo, which the route has never read', () => {
    // Advertising an argument the route ignores is worse than not offering it:
    // a caller naming a reassignment target got a recovery that reassigned
    // somewhere else, with no error. Removing it breaks no working call —
    // every call that sent it was refused for the missing profile anyway.
    expect(schema.properties).not.toHaveProperty('assignTo');
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'routes', 'tasks.ts'), 'utf8',
    ) as string;
    const handler = source.slice(source.indexOf("router.post('/:id/recover'"));
    const body = handler.slice(0, handler.indexOf('\nrouter.'));
    expect(body).not.toContain('assignTo');
  });

  it('reads the SAME execution-profile schema relayhall_task_create does', () => {
    // One contract, described once. Two copies would drift and the copy a
    // model happened to read would be the wrong one.
    const create = toolByName('relayhall_task_create')?.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties.executionProfile).toBe(create.properties.executionProfile);
  });
});

describe('the argument reaches the route, and the route acts on it', () => {
  it('WITHOUT a profile the route refuses — the defect, reproduced through the tool', async () => {
    // This is what EVERY schema-valid call to this tool did before the card.
    const message = await refusalOf({ task: TASK, reason: 'meltdown' });
    expect(message).toContain('REASSIGNMENT_REQUIRED');
    expect(message).toContain('executionProfile');
  });

  it('WITH a profile the route gets past that check and authorizes the profile', async () => {
    // A caller who may write Tasks but may not choose what executes is refused
    // by `resolveExecutionProfileWrite` BEFORE any Service lookup. Reaching
    // that refusal is proof the profile crossed the seam and was acted on: a
    // tool that dropped the argument could never produce this answer.
    authenticateWith(['tasks:write']);
    const message = await refusalOf({ task: TASK, executionProfile: PROFILE });
    expect(message).toContain('PROFILE_INVOKE_REQUIRED');
  });

  it('the route validates the profile VALUE the tool forwarded, not an empty shell', async () => {
    // The retired mode/harness shape is refused by name. A handler that
    // forwarded `{}` — or nothing — could not reach this branch.
    const message = await refusalOf({
      task: TASK,
      executionProfile: { mode: 'agent', harness: 'claude', accessProfile: 'x' },
    });
    expect(message).toContain('FIELD_RETIRED');
  });

  it('executionWarrantId crosses too, and is validated as a Warrant UUID', async () => {
    const message = await refusalOf({
      task: TASK, executionProfile: PROFILE, executionWarrantId: 'not-a-uuid',
    });
    expect(message).toContain('INVALID_WARRANT_ID');
  });

  it('rejects an argument the tool does not offer rather than dropping it silently', async () => {
    // `assignTo` is the specific one this card removed. A caller still sending
    // it learns so, instead of watching the board reassign somewhere else.
    const message = await refusalOf({ task: TASK, executionProfile: PROFILE, assignTo: PRINCIPAL_ID });
    expect(message).toMatch(/assignTo/);
  });
});

describe('a recovery actually happens', () => {
  /**
   * The one drill that needs the write to succeed. The Connector registry read
   * and the recovery write are stubbed because both need a database; the
   * ARGUMENT PATH between the tool and them is the shipped one, and what
   * `recoverTask` receives is what this test reads.
   */
  function stubTheDatabaseLeaves(): jest.SpyInstance {
    jest.spyOn(executionProfile, 'validateConnectorProfile')
      .mockResolvedValue({ serviceId: SERVICE, descriptorVersion: 1, options: { model: 'x' } } as never);
    jest.spyOn(taskManager, 'getTask').mockResolvedValue({ id: TASK, title: 'melted' } as never);
    return jest.spyOn(taskManager, 'recoverTask')
      .mockResolvedValue({ outcome: 'recovered', releasedLeases: 1, previousClaimant: PRINCIPAL_ID } as never);
  }

  it('succeeds with a profile, and hands the route the resolved assignment', async () => {
    const recoverTask = stubTheDatabaseLeaves();
    const answer = await recover({
      task: TASK, executionProfile: PROFILE, executionWarrantId: WARRANT, reason: 'meltdown',
    });
    expect(answer).toContain('Recovered Task');
    expect(answer).toContain('"outcome": "recovered"');
    expect(recoverTask).toHaveBeenCalledTimes(1);
    const [taskId, assignment] = recoverTask.mock.calls[0] as [string, Record<string, unknown>];
    expect(taskId).toBe(TASK);
    expect(assignment).toMatchObject({
      executionServiceId: SERVICE,
      executionDescriptorVersion: 1,
      executionWarrantId: WARRANT,
      reason: 'meltdown',
    });
  });

  it('the UPPER-CASE Warrant spelling reaches the route unchanged', async () => {
    // ANNEX A `dd3aaa9e` §6A's retry leg turns on the route seeing the SAME
    // Warrant in a different case. The tool must not normalise it on the way
    // past — the route's own guard is what decides, and it can only decide
    // about what it receives.
    const recoverTask = stubTheDatabaseLeaves();
    const upper = WARRANT.toUpperCase();
    await recover({ task: TASK, executionProfile: PROFILE, executionWarrantId: upper });
    const [, assignment] = recoverTask.mock.calls[0] as [string, Record<string, unknown>];
    expect(assignment.executionWarrantId).toBe(upper);
  });

  it('MUTATION: a handler that forwards everything BUT the profile cannot recover', async () => {
    // The control for every drill above, and it has to be a mutation rather
    // than a call that omits the argument: omitting it proves the ROUTE
    // refuses an absent profile, which was never in doubt. What needs proving
    // is that THIS handler's forwarding is what carries it. So the shipped
    // registry is loaded with the one `pick` narrowed — the state the tool
    // actually shipped in — and the same schema-valid call is made.
    stubTheDatabaseLeaves();
    const line =
      "      const envelope = await board(ctx, { method: 'POST', path: `/tasks/"
      + '${encodeURIComponent(taskId)}'
      + "/recover`, body: pick(args, ['reason', 'executionProfile', 'executionWarrantId']), "
      + "requiredScope: 'tasks:write' });";
    const mutant = loadMutatedModule<typeof import('../mcp/registry')>('mcp/registry.ts', [{
      find: line,
      replace: line.replace(
        "['reason', 'executionProfile', 'executionWarrantId']", "['reason']",
      ),
    }]);
    const mutated = mutant.toolByName('relayhall_task_recover');
    let message = 'NOT_REFUSED';
    try {
      await mutated!.handler({ task: TASK, executionProfile: PROFILE }, CTX);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('REASSIGNMENT_REQUIRED');
    // …and the SHIPPED handler, given the identical call, recovers.
    expect(await recover({ task: TASK, executionProfile: PROFILE })).toContain('Recovered Task');
  });
});
