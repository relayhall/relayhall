import { Validator } from '@cfworker/json-schema';
/**
 * mcpSubtaskApprovalContract.test.ts — task f075e779.
 *
 * `relayhall_subtask_set` with status `completed` is a Verifier verdict. It
 * must reach the stable approve route (assigned-Verifier gate) rather than the
 * generic status PATCH (global automation role derived from the handle). Explicit owner/Main completion uses the owner-aware PATCH without a read
 * prerequisite. Other states keep the generic PATCH unchanged. The tool's own handler is
 * called; only the board transport seam is replaced so the exact request it
 * issues — and how it treats a refusal — can be read.
 */
jest.mock('../mcp/rest', () => ({
  ...jest.requireActual('../mcp/rest'),
  board: jest.fn(async () => ({ success: true })),
}));

import { toolByName } from '../mcp/registry';
import { board } from '../mcp/rest';
import { McpToolError } from '../mcp/shape';

const TASK = '11111111-1111-4111-8111-111111111111';
const CTX = { authorization: 'Bearer rh_dev_keyid01.secretsecretsecretsecret', toolName: 'relayhall_subtask_set' };
const boardMock = board as jest.Mock;

async function subtaskSet(args: Record<string, unknown>): Promise<string> {
  const tool = toolByName('relayhall_subtask_set');
  if (!tool) throw new Error('relayhall_subtask_set is not registered');
  return tool.handler(args, CTX);
}

afterEach(() => { boardMock.mockReset(); boardMock.mockImplementation(async () => ({ success: true })); });

describe('relayhall_subtask_set completion routes through the stable approve verb', () => {
  it('completed issues exactly one POST approve with the caller context and scope', async () => {
    const answer = await subtaskSet({ task: TASK, subtaskId: '7', status: 'completed' });
    expect(boardMock).toHaveBeenCalledTimes(1);
    const [ctx, call] = boardMock.mock.calls[0];
    expect(ctx).toBe(CTX);
    expect(call).toEqual({
      method: 'POST',
      path: `/tasks/${TASK}/subtasks/by-id/7/approve`,
      body: {},
      requiredScope: 'tasks:write',
    });
    expect(answer).toBe('Task 11111111 subtask [7] → completed');
  });

  it('completed forwards note/reason exactly as reviewNote/blockedReason', async () => {
    await subtaskSet({ task: TASK, subtaskId: '7', status: 'completed', note: 'verified against spec', reason: 'none' });
    expect(boardMock).toHaveBeenCalledTimes(1);
    expect(boardMock.mock.calls[0][1].body).toEqual({ reviewNote: 'verified against spec', blockedReason: 'none' });
  });

  it('a non-string note is forwarded as-is for the route to refuse, never stringified', async () => {
    await subtaskSet({ task: TASK, subtaskId: '7', status: 'completed', note: 42 });
    expect(boardMock.mock.calls[0][1].body).toEqual({ reviewNote: 42 });
  });

  it.each(['empty', 'in-progress', 'review', 'stuck', 'skipped'])('%s keeps the original generic PATCH', async (status) => {
    await subtaskSet({ task: TASK, subtaskId: '7', status, note: 'n', reason: 'r' });
    expect(boardMock).toHaveBeenCalledTimes(1);
    const [ctx, call] = boardMock.mock.calls[0];
    expect(ctx).toBe(CTX);
    expect(call).toEqual({
      method: 'PATCH',
      path: `/tasks/${TASK}/subtasks/by-id/7/status`,
      body: { status, reviewNote: 'n', blockedReason: 'r' },
      requiredScope: 'tasks:write',
    });
  });

  it('a refused approve surfaces unchanged: no PATCH fallback, no replay', async () => {
    const refusal = new McpToolError('relayhall_subtask_set: 403 Only an independent Verifier identity can approve subtasks.');
    boardMock.mockRejectedValueOnce(refusal);
    await expect(subtaskSet({ task: TASK, subtaskId: '7', status: 'completed' })).rejects.toBe(refusal);
    expect(boardMock).toHaveBeenCalledTimes(1);
    expect(boardMock.mock.calls[0][1]).toMatchObject({ method: 'POST', path: `/tasks/${TASK}/subtasks/by-id/7/approve` });
  });

  it('a non-refusal error (e.g. Review not reached) also passes through after one call', async () => {
    const failure = new Error('A subtask can only be completed from review (current status: in-progress)');
    boardMock.mockRejectedValueOnce(failure);
    await expect(subtaskSet({ task: TASK, subtaskId: '7', status: 'completed' })).rejects.toBe(failure);
    expect(boardMock).toHaveBeenCalledTimes(1);
  });
});


describe('explicit owner/Main completion intent', () => {
  it('uses one owner-aware PATCH without requiring tasks:read', async () => {
    await subtaskSet({ task: TASK, subtaskId: '7', status: 'completed', completionMode: 'owner', note: 'work done', reason: 'owner disposition' });
    expect(boardMock).toHaveBeenCalledTimes(1);
    expect(boardMock).toHaveBeenCalledWith(CTX, {
      method: 'PATCH', path: `/tasks/${TASK}/subtasks/by-id/7/status`,
      body: { status: 'completed', reviewNote: 'work done', blockedReason: 'owner disposition', completionMode: 'owner' }, requiredScope: 'tasks:write',
    });
  });
  it('explicit verifier mode keeps the assigned-Verifier route', async () => {
    await subtaskSet({ task: TASK, subtaskId: '7', status: 'completed', completionMode: 'verifier' });
    expect(boardMock).toHaveBeenCalledTimes(1);
    expect(boardMock.mock.calls[0][1]).toMatchObject({ method: 'POST', path: `/tasks/${TASK}/subtasks/by-id/7/approve` });
  });
  it('owner denial is propagated without retrying as Verifier', async () => {
    const denied = new McpToolError('403 actual account control is required');
    boardMock.mockRejectedValueOnce(denied);
    await expect(subtaskSet({ task: TASK, subtaskId: '7', status: 'completed', completionMode: 'owner' })).rejects.toBe(denied);
    expect(boardMock).toHaveBeenCalledTimes(1);
  });
  it('rejects completion intent on other states before any request', async () => {
    await expect(subtaskSet({ task: TASK, subtaskId: '7', status: 'review', completionMode: 'owner' })).rejects.toThrow('only valid');
    expect(boardMock).not.toHaveBeenCalled();
  });
});

describe('advertised stable-id domain agrees with REST validation', () => {
  const { Validator } = require('@cfworker/json-schema');
  const { isValidSubtaskId } = require('../utils/taskIds');
  const schema = toolByName('relayhall_subtask_set')!.inputSchema;
  const validator = new Validator(schema);
  const { buildOpenApiSpec } = require('../openapi/spec');
  const restSchema = buildOpenApiSpec().paths['/tasks/{id}/subtasks/by-id/{subtaskId}/status'].patch.parameters[0].schema;
  const restValidator = new Validator(restSchema);
  it.each(['0', '1', '2147483647', '0002147483647', '0000', '2147483648', '999999999999', '9'.repeat(1000), '-1', '1.5', '1e2', '1\n', '', 'nope', 7, null])('schema and runtime agree on %s', (subtaskId) => {
    const result = validator.validate({ task: TASK, subtaskId, status: 'completed' });
    expect(result.valid).toBe(isValidSubtaskId(subtaskId));
    expect(restValidator.validate(subtaskId).valid).toBe(result.valid);
    expect(result.valid).toBe(typeof subtaskId === 'string' && ['0', '1', '2147483647', '0002147483647', '0000'].includes(subtaskId));
  });
  it('all numeric prefixes near the upper boundary match integer arithmetic', () => {
    for (const n of [...Array.from({ length: 100 }, (_, i) => 2147483600 + i), ...Array.from({ length: 1000 }, (_, i) => (i * 2654435761) % 4294967296)]) {
      expect(validator.validate({ task: TASK, subtaskId: String(n), status: 'completed' }).valid).toBe(n <= 2147483647);
    }
  });
});


describe('MCP archived Task restoration', () => {
  const restore = (args: Record<string, unknown>) => toolByName('relayhall_task_restore')!.handler(args, CTX);
  it('uses one dedicated restore request, leaving the prior state to the server', async () => {
    boardMock.mockResolvedValueOnce({ success: true, restoredTo: 'completed', derivedFrom: 'history' });
    expect(JSON.parse(await restore({ task: TASK }))).toMatchObject({ restoredTo: 'completed', derivedFrom: 'history' });
    expect(boardMock).toHaveBeenCalledTimes(1);
    expect(boardMock).toHaveBeenCalledWith(CTX, { method: 'POST', path: `/tasks/${TASK}/unarchive`, body: {}, requiredScope: 'tasks:write' });
  });
  it('refuses caller-selected status before any request', async () => {
    await expect(restore({ task: TASK, status: 'completed' })).rejects.toThrow();
    expect(boardMock).not.toHaveBeenCalled();
  });
  it('propagates restoration denial without a status PATCH fallback', async () => {
    const denial = new McpToolError('403 restoration authority required');
    boardMock.mockRejectedValueOnce(denial);
    await expect(restore({ task: TASK })).rejects.toBe(denial);
    expect(boardMock).toHaveBeenCalledTimes(1);
  });
});


describe('owner/Main completed Task creation transport', () => {
  it('advertises completed creation and forwards one guarded request with the original retry key', async () => {
    const tool = toolByName('relayhall_task_create')!;
    const args = {title:'Recorded completed work', status:'completed', idempotencyKey:'completed-create-retry-key'};
    expect(new Validator(tool.inputSchema).validate(args).valid).toBe(true);
    boardMock.mockResolvedValueOnce({task:{id:TASK,title:args.title,status:'completed'}});
    await tool.handler(args, CTX);
    expect(boardMock).toHaveBeenCalledTimes(1);
    expect(boardMock).toHaveBeenCalledWith(CTX, {method:'POST',path:'/tasks',
      body:{title:args.title,status:'completed'},headers:{'Idempotency-Key':args.idempotencyKey},requiredScope:'tasks:write'});
  });
  it('retains server refusal without changing status or retrying', async () => {
    const refused = new McpToolError('403 restricted delegate cannot create completed work');
    boardMock.mockRejectedValueOnce(refused);
    await expect(toolByName('relayhall_task_create')!.handler({title:'Restricted',status:'completed',idempotencyKey:'completed-create-refusal-key'},CTX)).rejects.toBe(refused);
    expect(boardMock).toHaveBeenCalledTimes(1);
    expect(boardMock.mock.calls[0][1].body.status).toBe('completed');
  });
});
