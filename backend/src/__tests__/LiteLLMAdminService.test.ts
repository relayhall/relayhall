import { LiteLLMAdminError, LiteLLMAdminService } from '../services/LiteLLMAdminService';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const config = {
  baseUrl: 'http://litellm.test',
  masterKey: 'sk-admin-secret',
  allowMutations: true,
  timeoutMs: 1000,
};

describe('LiteLLMAdminService', () => {
  it('lists model sources, reports disagreement, and strips credential fields', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response({ data: [{ model_name: 'alpha', litellm_params: { api_key: 'must-not-leak', model: 'openai/a' } }] }))
      .mockResolvedValueOnce(response({ data: [] }));
    const service = new LiteLLMAdminService(config, fetchMock as typeof fetch);

    const result = await service.listModels();

    expect(result.consistency).toBe('degraded');
    expect(result.models).toEqual([{ model_name: 'alpha', litellm_params: { model: 'openai/a' } }]);
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers.authorization).toBe('Bearer sk-admin-secret');
    }
  });

  it('creates a DB-backed model using only an environment credential reference', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response({ model_id: 'model-1', api_key: 'masked-upstream' }));
    const service = new LiteLLMAdminService(config, fetchMock as typeof fetch);

    const result = await service.createModel({
      modelName: 'relayhall/alpha',
      providerModel: 'openai/gpt-test',
      apiBase: 'https://provider.example/v1',
      apiKeyEnv: 'PROVIDER_API_KEY',
      mode: 'chat',
    });

    const request = fetchMock.mock.calls[0];
    expect(request[0]).toBe('http://litellm.test/model/new');
    expect(JSON.parse(request[1].body)).toEqual({
      model_name: 'relayhall/alpha',
      litellm_params: {
        model: 'openai/gpt-test',
        api_base: 'https://provider.example/v1',
        api_key: 'os.environ/PROVIDER_API_KEY',
      },
      model_info: { mode: 'chat' },
    });
    expect(result).toEqual({ model_id: 'model-1' });
  });

  it('marks matching empty discovery sources degraded instead of hiding the audited decrypt failure', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response({ data: [] }))
      .mockResolvedValueOnce(response({ data: [] }));
    const service = new LiteLLMAdminService(config, fetchMock as typeof fetch);

    await expect(service.listModels()).resolves.toMatchObject({ consistency: 'degraded' });
  });

  it('fails closed without the explicit mutation gate', async () => {
    const fetchMock = jest.fn();
    const service = new LiteLLMAdminService({ ...config, allowMutations: false }, fetchMock as typeof fetch);

    await expect(service.createModel({ modelName: 'a', providerModel: 'openai/a' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'mutations_disabled' });
    await expect(service.deleteModel('model-1'))
      .rejects.toMatchObject({ statusCode: 409, code: 'mutations_disabled' });
    await expect(service.generateKey({ name: 'worker', agentId: 'agent-1', models: ['model-1'], maxBudget: 10 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'mutations_disabled' });
    await expect(service.deleteKey('hash-1'))
      .rejects.toMatchObject({ statusCode: 409, code: 'mutations_disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates environment references, URLs, and deletion IDs before calling upstream', async () => {
    const fetchMock = jest.fn();
    const service = new LiteLLMAdminService(config, fetchMock as typeof fetch);

    await expect(service.createModel({ modelName: 'a', providerModel: 'openai/a', apiKeyEnv: 'bad-key' }))
      .rejects.toBeInstanceOf(LiteLLMAdminError);
    await expect(service.createModel({ modelName: 'a', providerModel: 'openai/a', apiBase: 'file:///secret' }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(service.createModel({ modelName: 'a', providerModel: 'openai/a', apiBase: 'https://user:password@provider.example/v1' }))
      .rejects.toMatchObject({ code: 'raw_secret_rejected' });
    await expect(service.createModel(null as unknown as Parameters<LiteLLMAdminService['createModel']>[0]))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_input' });
    await expect(service.createModel('primitive' as unknown as Parameters<LiteLLMAdminService['createModel']>[0]))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_input' });
    await expect(service.createModel(42 as unknown as Parameters<LiteLLMAdminService['createModel']>[0]))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_input' });
    await expect(service.createModel([] as unknown as Parameters<LiteLLMAdminService['createModel']>[0]))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_input' });
    await expect(service.createModel({ modelName: 'a', providerModel: 'openai/a', apiKey: 'inline-secret' } as unknown as Parameters<LiteLLMAdminService['createModel']>[0]))
      .rejects.toMatchObject({ statusCode: 400, code: 'raw_secret_rejected' });
    await expect(service.createModel({ modelName: 'a', providerModel: 'openai/a', api_key: 'inline-secret' } as unknown as Parameters<LiteLLMAdminService['createModel']>[0]))
      .rejects.toMatchObject({ statusCode: 400, code: 'raw_secret_rejected' });
    await expect(service.createModel({ modelName: 'a', providerModel: 'openai/a', mode: 'arbitrary' as 'chat' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_input' });
    await expect(service.deleteModel('../model'))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps upstream response bodies to a sanitized error without leaking them', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response({ error: 'upstream failure details' }, 500));
    const service = new LiteLLMAdminService(config, fetchMock as typeof fetch);

    await expect(service.listModels()).rejects.toMatchObject({
      statusCode: 502,
      code: 'upstream_error',
      message: 'LiteLLM admin request failed with HTTP 500',
    });
  });

  it('generates an agent/project-scoped virtual key with model and spend limits', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response({
      key: 'generated-once',
      token_id: 'token-hash',
      expires: '2026-08-15T00:00:00Z',
    }));
    const service = new LiteLLMAdminService(config, fetchMock as typeof fetch);

    const result = await service.generateKey({
      name: 'research worker',
      agentId: 'agent-research',
      projectId: 'project-alpha',
      models: ['openai/gpt-test', 'openai/gpt-test'],
      maxBudget: 25,
      budgetDuration: '1mo',
      duration: '30d',
    });

    expect(result).toEqual({
      key: 'generated-once',
      keyAlias: 'relayhall:project-alpha:agent-research',
      tokenId: 'token-hash',
      expires: '2026-08-15T00:00:00Z',
      maxBudget: 25,
      models: ['openai/gpt-test'],
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      key_alias: 'relayhall:project-alpha:agent-research',
      models: ['openai/gpt-test'],
      max_budget: 25,
      budget_duration: '1mo',
      duration: '30d',
      metadata: {
        relayhall_name: 'research worker',
        relayhall_agent_id: 'agent-research',
        relayhall_project_id: 'project-alpha',
      },
    });
  });

  it('lists keys without leaking key material and deletes by a validated token id', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response({ keys: [{ token_id: 'hash-1', key: 'sensitive-value', key_alias: 'safe' }] }))
      .mockResolvedValueOnce(response({ deleted_keys: ['hash-1'] }));
    const service = new LiteLLMAdminService(config, fetchMock as typeof fetch);

    const keys = await service.listKeys();
    expect(keys).toEqual([{ token_id: 'hash-1', key_alias: 'safe' }]);
    expect(JSON.stringify(keys)).not.toContain('sensitive-value');
    expect(fetchMock.mock.calls[0][0]).toBe('http://litellm.test/key/list?return_full_object=true&size=100');
    await expect(service.deleteKey('hash-1')).resolves.toEqual({ deleted_keys: ['hash-1'] });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ keys: ['hash-1'] });
  });

  it('rejects unscoped, unbounded, primitive, and caller-secret key requests', async () => {
    const fetchMock = jest.fn();
    const service = new LiteLLMAdminService(config, fetchMock as typeof fetch);
    const base = { name: 'worker', agentId: 'agent-1', models: ['model-1'], maxBudget: 10 };

    await expect(service.generateKey({ ...base, agentId: undefined }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(service.generateKey({ ...base, maxBudget: 0 }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(service.generateKey({ ...base, models: [] }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(service.generateKey({ ...base, duration: 'forever' }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(service.generateKey({ ...base, agentId: 'agent/unsafe' }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(service.generateKey('primitive' as unknown as Parameters<LiteLLMAdminService['generateKey']>[0]))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(service.generateKey({ ...base, token: 'caller-value' } as unknown as Parameters<LiteLLMAdminService['generateKey']>[0]))
      .rejects.toMatchObject({ code: 'raw_secret_rejected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aggregates paginated spend by safe key alias, user, and model without exposing raw API keys', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response({
        data: [
          { key_alias: 'relayhall:p:a', api_key: 'must-not-leak', user_id: 'user-a', model: 'model-a', spend: 1.25, prompt_tokens: 10, completion_tokens: 5 },
          { key_alias: 'relayhall:p:a', user_id: 'user-b', model: 'model-a', spend: 0.75, prompt_tokens: 2, completion_tokens: 3 },
        ],
        total_pages: 2,
      }))
      .mockResolvedValueOnce(response({
        data: [{ token_id: 'hash-b', internal_user_id: 'user-a', model_name: 'model-b', cost: 2, input_tokens: 7, output_tokens: 4 }],
        total_pages: 2,
      }));
    const service = new LiteLLMAdminService(config, fetchMock as typeof fetch);

    const result = await service.getSpendSummary({ startDate: '2026-07-01', endDate: '2026-07-16' });

    expect(result).toMatchObject({ totalSpend: 4, requests: 3, inputTokens: 19, outputTokens: 12, truncated: false });
    expect(result.byKey).toEqual([
      { id: 'hash-b', spend: 2, requests: 1, inputTokens: 7, outputTokens: 4 },
      { id: 'relayhall:p:a', spend: 2, requests: 2, inputTokens: 12, outputTokens: 8 },
    ]);
    expect(result.byUser[0]).toEqual({ id: 'user-a', spend: 3.25, requests: 2, inputTokens: 17, outputTokens: 9 });
    expect(result.byModel).toEqual([
      { id: 'model-a', spend: 2, requests: 2, inputTokens: 12, outputTokens: 8 },
      { id: 'model-b', spend: 2, requests: 1, inputTokens: 7, outputTokens: 4 },
    ]);
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(fetchMock.mock.calls[0][0]).toContain('/spend/logs/v2?start_date=2026-07-01+00%3A00%3A00');
    expect(fetchMock.mock.calls[1][0]).toContain('page=2');
  });

  it('rejects malformed or descending spend date ranges before calling LiteLLM', async () => {
    const fetchMock = jest.fn();
    const service = new LiteLLMAdminService(config, fetchMock as typeof fetch);

    await expect(service.getSpendSummary({ startDate: '2026-7-1' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_input' });
    await expect(service.getSpendSummary({ startDate: '2026-07-17', endDate: '2026-07-16' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports the installed LiteLLM spend schema without exposing raw key material', async () => {
    const tokenHash = 'a'.repeat(64);
    const rawKey = 'sk-raw-secret-must-not-leak';
    const fetchMock = jest.fn().mockResolvedValue(response({
      data: [
        { api_key: tokenHash, user: 'live-user', model: 'live-model', spend: 1 },
        { api_key: rawKey, user: 'live-user', model: 'live-model', spend: 2 },
      ],
      total_pages: 1,
    }));
    const service = new LiteLLMAdminService(config, fetchMock as typeof fetch);

    const result = await service.getSpendSummary({ startDate: '2026-07-16', endDate: '2026-07-16' });

    expect(result.byKey).toEqual([
      { id: 'unattributed', spend: 2, requests: 1, inputTokens: 0, outputTokens: 0 },
      { id: `token:${tokenHash}`, spend: 1, requests: 1, inputTokens: 0, outputTokens: 0 },
    ]);
    expect(result.byUser).toEqual([
      { id: 'live-user', spend: 3, requests: 2, inputTokens: 0, outputTokens: 0 },
    ]);
    expect(JSON.stringify(result)).not.toContain(rawKey);
  });

  it('reports credential-safe health for each configured model endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response({
      healthy_count: 1,
      unhealthy_count: 1,
      healthy_endpoints: [{ model_id: 'deployment-a', model: 'provider/model-a', api_key: 'sk-secret' }],
      unhealthy_endpoints: [{
        deployment_id: 'deployment-b',
        litellm_params: { model: 'provider/model-b', api_key: 'sk-nested-secret' },
        error: 'request failed with sk-error-secret',
      }],
    }));
    const service = new LiteLLMAdminService(config, fetchMock as typeof fetch);

    const result = await service.getModelHealth();

    expect(result).toMatchObject({
      status: 'degraded',
      healthyCount: 1,
      unhealthyCount: 1,
      checks: [
        { id: 'deployment-a', model: 'provider/model-a', status: 'healthy' },
        { id: 'deployment-b', model: 'provider/model-b', status: 'unhealthy' },
      ],
    });
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(result)).not.toMatch(/sk-(secret|nested-secret|error-secret)/);
    expect(fetchMock.mock.calls[0][0]).toBe('http://litellm.test/health');
  });

  it('rejects a malformed LiteLLM health response', async () => {
    const service = new LiteLLMAdminService(config, jest.fn().mockResolvedValue(response([])) as typeof fetch);
    await expect(service.getModelHealth()).rejects.toMatchObject({
      statusCode: 502,
      code: 'invalid_upstream_response',
    });
  });
});
