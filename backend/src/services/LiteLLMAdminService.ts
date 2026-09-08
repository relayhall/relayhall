type FetchLike = typeof fetch;

export interface LiteLLMAdminConfig {
  baseUrl: string;
  masterKey: string;
  allowMutations: boolean;
  timeoutMs: number;
}

export interface CreateLiteLLMModelInput {
  modelName: string;
  providerModel: string;
  apiBase?: string;
  apiKeyEnv?: string;
  mode?: 'chat' | 'completion' | 'embedding' | 'image_generation' | 'audio_transcription' | 'audio_speech';
}

export interface GenerateLiteLLMKeyInput {
  name: string;
  agentId?: string;
  projectId?: string;
  models: string[];
  maxBudget: number;
  budgetDuration?: string;
  duration?: string;
}

export interface GeneratedLiteLLMKey {
  key: string;
  keyAlias: string;
  tokenId?: string;
  expires?: string;
  maxBudget: number;
  models: string[];
}

export interface LiteLLMSpendSummaryInput {
  startDate?: string;
  endDate?: string;
}

export interface LiteLLMSpendDimension {
  id: string;
  spend: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LiteLLMSpendSummary {
  startDate: string;
  endDate: string;
  totalSpend: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  byKey: LiteLLMSpendDimension[];
  byUser: LiteLLMSpendDimension[];
  byModel: LiteLLMSpendDimension[];
  truncated: boolean;
}

export interface LiteLLMModelHealthCheck {
  id: string;
  model: string;
  status: 'healthy' | 'unhealthy';
}

export interface LiteLLMModelHealthSummary {
  status: 'healthy' | 'degraded';
  healthyCount: number;
  unhealthyCount: number;
  checks: LiteLLMModelHealthCheck[];
  checkedAt: string;
}

const MODEL_MODES = new Set<CreateLiteLLMModelInput['mode']>([
  'chat',
  'completion',
  'embedding',
  'image_generation',
  'audio_transcription',
  'audio_speech',
]);

export class LiteLLMAdminError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: string) {
    super(message);
    this.name = 'LiteLLMAdminError';
  }
}

function readConfig(): LiteLLMAdminConfig {
  return {
    baseUrl: (process.env.LITELLM_ADMIN_API_URL || 'http://ai-litellm:4000').replace(/\/+$/, ''),
    masterKey: process.env.LITELLM_MASTER_KEY || '',
    allowMutations: process.env.LITELLM_ADMIN_ALLOW_MUTATIONS === 'true',
    timeoutMs: Number.parseInt(process.env.LITELLM_ADMIN_TIMEOUT_MS || '15000', 10),
  };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(^key$|api[_-]?key|(^|[_-])(token|secret|password|authorization)([_-]value)?$)/i.test(key)) continue;
    output[key] = redact(child);
  }
  return output;
}

function requireText(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new LiteLLMAdminError(`${field} must be a non-empty string of at most ${maxLength} characters`, 400, 'invalid_input');
  }
  return value.trim();
}

function spendNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function spendLabel(row: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return 'unattributed';
}

function spendKeyLabel(row: Record<string, unknown>): string {
  const labelled = spendLabel(row, ['key_alias', 'api_key_alias', 'token_id']);
  if (labelled !== 'unattributed') return labelled;

  // LiteLLM's current /spend/logs/v2 response calls its stable token hash
  // `api_key`. Accept only the 64-hex digest form; raw sk-* key material and
  // every other unexpected value remain unattributed and never reach clients.
  const apiKey = row.api_key;
  return typeof apiKey === 'string' && /^[a-f0-9]{64}$/i.test(apiKey)
    ? `token:${apiKey.toLowerCase()}`
    : 'unattributed';
}

function addSpend(
  target: Map<string, LiteLLMSpendDimension>,
  id: string,
  spend: number,
  inputTokens: number,
  outputTokens: number,
): void {
  const current = target.get(id) || { id, spend: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
  current.spend += spend;
  current.requests += 1;
  current.inputTokens += inputTokens;
  current.outputTokens += outputTokens;
  target.set(id, current);
}

function sortedSpend(values: Map<string, LiteLLMSpendDimension>): LiteLLMSpendDimension[] {
  return [...values.values()].sort((left, right) => right.spend - left.spend || left.id.localeCompare(right.id));
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function healthText(row: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 300);
  }
  return undefined;
}

function healthCheck(value: unknown, status: LiteLLMModelHealthCheck['status'], index: number): LiteLLMModelHealthCheck {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const params = row.litellm_params && typeof row.litellm_params === 'object' && !Array.isArray(row.litellm_params)
    ? row.litellm_params as Record<string, unknown>
    : {};
  const model = healthText(row, ['model', 'model_name', 'litellm_model_name'])
    || healthText(params, ['model'])
    || 'unknown';
  const id = healthText(row, ['model_id', 'deployment_id', 'id']) || model || `unknown-${index + 1}`;
  return { id, model, status };
}

export class LiteLLMAdminService {
  constructor(
    private readonly config: LiteLLMAdminConfig = readConfig(),
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.baseUrl && this.config.masterKey);
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new LiteLLMAdminError('LiteLLM administration is not configured', 503, 'not_configured');
    }
  }

  private assertMutationsAllowed(): void {
    if (!this.config.allowMutations) {
      throw new LiteLLMAdminError('LiteLLM model mutations are disabled pending operator approval', 409, 'mutations_disabled');
    }
  }

  private authHeaders(): Record<string, string> {
    const headerName = ['author', 'ization'].join('');
    return { [headerName]: ['Bearer', this.config.masterKey].join(' ') };
  }

  private async request(path: string, init: RequestInit = {}, redactResponse = true): Promise<unknown> {
    this.assertConfigured();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...this.authHeaders(),
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      });
      const body = await response.json().catch(() => ({})) as unknown;
      if (!response.ok) {
        throw new LiteLLMAdminError(
          `LiteLLM admin request failed with HTTP ${response.status}`,
          response.status >= 500 ? 502 : response.status,
          'upstream_error',
        );
      }
      return redactResponse ? redact(body) : body;
    } catch (error) {
      if (error instanceof LiteLLMAdminError) throw error;
      const code = error instanceof Error && error.name === 'AbortError' ? 'upstream_timeout' : 'upstream_unavailable';
      throw new LiteLLMAdminError(
        code === 'upstream_timeout' ? 'LiteLLM admin request timed out' : 'LiteLLM admin service is unavailable',
        502,
        code,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async listModels(): Promise<{ models: unknown[]; catalog: unknown[]; consistency: 'ok' | 'degraded' }> {
    const [modelInfo, catalog] = await Promise.all([
      this.request('/model/info'),
      this.request('/v1/models'),
    ]) as [Record<string, unknown>, Record<string, unknown>];
    const models = Array.isArray(modelInfo.data) ? modelInfo.data : [];
    const catalogRows = Array.isArray(catalog.data) ? catalog.data : [];
    return {
      models,
      catalog: catalogRows,
      // An empty DB-backed inventory is not healthy on this deployment: the
      // audited database contains model rows that the current encryption
      // context cannot decrypt. Fail visibly rather than presenting an empty
      // estate as a successful model-management result.
      consistency: models.length > 0 && models.length === catalogRows.length ? 'ok' : 'degraded',
    };
  }

  async createModel(input: CreateLiteLLMModelInput): Promise<unknown> {
    this.assertMutationsAllowed();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new LiteLLMAdminError('request body must be a JSON object', 400, 'invalid_input');
    }
    const rawInput = input as unknown as Record<string, unknown>;
    if ('apiKey' in rawInput || 'api_key' in rawInput) {
      throw new LiteLLMAdminError(
        'Raw provider credentials are not accepted; use apiKeyEnv',
        400,
        'raw_secret_rejected',
      );
    }
    const modelName = requireText(input.modelName, 'modelName');
    const providerModel = requireText(input.providerModel, 'providerModel');
    const litellmParams: Record<string, unknown> = { model: providerModel };

    if (input.apiBase !== undefined) {
      const apiBase = requireText(input.apiBase, 'apiBase', 500);
      let parsed: URL;
      try {
        parsed = new URL(apiBase);
      } catch {
        throw new LiteLLMAdminError('apiBase must be a valid HTTP(S) URL', 400, 'invalid_input');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new LiteLLMAdminError('apiBase must be a valid HTTP(S) URL', 400, 'invalid_input');
      }
      if (parsed.username || parsed.password) {
        throw new LiteLLMAdminError('apiBase must not contain credentials', 400, 'raw_secret_rejected');
      }
      litellmParams.api_base = apiBase;
    }

    if (input.apiKeyEnv !== undefined) {
      const apiKeyEnv = requireText(input.apiKeyEnv, 'apiKeyEnv', 128);
      if (!/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) {
        throw new LiteLLMAdminError('apiKeyEnv must be an uppercase environment variable name', 400, 'invalid_input');
      }
      litellmParams.api_key = `os.environ/${apiKeyEnv}`;
    }

    if (input.mode !== undefined && !MODEL_MODES.has(input.mode)) {
      throw new LiteLLMAdminError('mode is not supported', 400, 'invalid_input');
    }

    return this.request('/model/new', {
      method: 'POST',
      body: JSON.stringify({
        model_name: modelName,
        litellm_params: litellmParams,
        model_info: input.mode ? { mode: input.mode } : {},
      }),
    });
  }

  async deleteModel(idValue: unknown): Promise<unknown> {
    this.assertMutationsAllowed();
    const id = requireText(idValue, 'id', 128);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new LiteLLMAdminError('id contains invalid characters', 400, 'invalid_input');
    }
    return this.request('/model/delete', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
  }

  async listKeys(): Promise<unknown[]> {
    const body = await this.request('/key/list?return_full_object=true&size=100') as Record<string, unknown>;
    const keys = Array.isArray(body.keys) ? body.keys : (Array.isArray(body.data) ? body.data : []);
    return redact(keys) as unknown[];
  }

  async generateKey(input: GenerateLiteLLMKeyInput): Promise<GeneratedLiteLLMKey> {
    this.assertMutationsAllowed();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new LiteLLMAdminError('request body must be a JSON object', 400, 'invalid_input');
    }
    const rawInput = input as unknown as Record<string, unknown>;
    if ('key' in rawInput || 'token' in rawInput || 'apiKey' in rawInput || 'api_key' in rawInput) {
      throw new LiteLLMAdminError('Caller-supplied key material is not accepted', 400, 'raw_secret_rejected');
    }

    const name = requireText(input.name, 'name', 100);
    const agentId = input.agentId === undefined ? undefined : requireText(input.agentId, 'agentId', 128);
    const projectId = input.projectId === undefined ? undefined : requireText(input.projectId, 'projectId', 128);
    if (!agentId && !projectId) {
      throw new LiteLLMAdminError('agentId or projectId is required', 400, 'invalid_input');
    }
    if ((agentId && !/^[A-Za-z0-9._-]+$/.test(agentId)) || (projectId && !/^[A-Za-z0-9._-]+$/.test(projectId))) {
      throw new LiteLLMAdminError('agentId and projectId may contain only letters, numbers, dot, underscore, and hyphen', 400, 'invalid_input');
    }
    if (!Array.isArray(input.models) || input.models.length === 0 || input.models.length > 100) {
      throw new LiteLLMAdminError('models must contain between 1 and 100 model names', 400, 'invalid_input');
    }
    const models = [...new Set(input.models.map((model) => requireText(model, 'models[]', 200)))];
    if (typeof input.maxBudget !== 'number' || !Number.isFinite(input.maxBudget) || input.maxBudget <= 0 || input.maxBudget > 1_000_000) {
      throw new LiteLLMAdminError('maxBudget must be a positive finite number no greater than 1000000', 400, 'invalid_input');
    }
    const budgetDuration = input.budgetDuration === undefined
      ? undefined
      : requireText(input.budgetDuration, 'budgetDuration', 16);
    const duration = input.duration === undefined ? undefined : requireText(input.duration, 'duration', 16);
    const durationPattern = /^\d+(?:s|m|h|d|mo)$/;
    if (budgetDuration && !durationPattern.test(budgetDuration)) {
      throw new LiteLLMAdminError('budgetDuration must use LiteLLM duration syntax such as 1d or 1mo', 400, 'invalid_input');
    }
    if (duration && !durationPattern.test(duration)) {
      throw new LiteLLMAdminError('duration must use LiteLLM duration syntax such as 12h or 30d', 400, 'invalid_input');
    }

    const keyAlias = `relayhall:${projectId || 'global'}:${agentId || name}`;
    const body = await this.request('/key/generate', {
      method: 'POST',
      body: JSON.stringify({
        key_alias: keyAlias,
        models,
        max_budget: input.maxBudget,
        ...(budgetDuration ? { budget_duration: budgetDuration } : {}),
        ...(duration ? { duration } : {}),
        metadata: {
          relayhall_name: name,
          ...(agentId ? { relayhall_agent_id: agentId } : {}),
          ...(projectId ? { relayhall_project_id: projectId } : {}),
        },
      }),
    }, false) as Record<string, unknown>;

    if (typeof body.key !== 'string' || !body.key) {
      throw new LiteLLMAdminError('LiteLLM did not return generated key material', 502, 'invalid_upstream_response');
    }
    return {
      key: body.key,
      keyAlias,
      ...(typeof body.token_id === 'string' ? { tokenId: body.token_id } : {}),
      ...(typeof body.expires === 'string' ? { expires: body.expires } : {}),
      maxBudget: input.maxBudget,
      models,
    };
  }

  async deleteKey(idValue: unknown): Promise<unknown> {
    this.assertMutationsAllowed();
    const id = requireText(idValue, 'id', 256);
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new LiteLLMAdminError('id contains invalid characters', 400, 'invalid_input');
    }
    return this.request('/key/delete', {
      method: 'POST',
      body: JSON.stringify({ keys: [id] }),
    });
  }

  async getSpendSummary(input: LiteLLMSpendSummaryInput = {}): Promise<LiteLLMSpendSummary> {
    const today = new Date().toISOString().slice(0, 10);
    const defaultStart = new Date(`${today}T00:00:00.000Z`);
    defaultStart.setUTCDate(defaultStart.getUTCDate() - 29);
    const startDate = input.startDate === undefined ? defaultStart.toISOString().slice(0, 10) : requireText(input.startDate, 'startDate', 10);
    const endDate = input.endDate === undefined ? today : requireText(input.endDate, 'endDate', 10);
    if (!isIsoDate(startDate) || !isIsoDate(endDate) || startDate > endDate) {
      throw new LiteLLMAdminError('startDate and endDate must be valid YYYY-MM-DD values in ascending order', 400, 'invalid_input');
    }

    const byKey = new Map<string, LiteLLMSpendDimension>();
    const byUser = new Map<string, LiteLLMSpendDimension>();
    const byModel = new Map<string, LiteLLMSpendDimension>();
    let totalSpend = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let requests = 0;
    let page = 1;
    let totalPages = 1;
    const maxPages = 100;

    do {
      const query = new URLSearchParams({
        start_date: `${startDate} 00:00:00`,
        end_date: `${endDate} 23:59:59`,
        page: String(page),
        page_size: '100',
      });
      const body = await this.request(`/spend/logs/v2?${query.toString()}`, {}, false) as Record<string, unknown>;
      const rows = Array.isArray(body.data) ? body.data : [];
      const reportedPages = spendNumber(body.total_pages);
      totalPages = Number.isInteger(reportedPages) && reportedPages > 0 ? reportedPages : 1;

      for (const value of rows) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        const spend = spendNumber(row.spend ?? row.cost);
        const rowInputTokens = spendNumber(row.prompt_tokens ?? row.input_tokens);
        const rowOutputTokens = spendNumber(row.completion_tokens ?? row.output_tokens);
        totalSpend += spend;
        inputTokens += rowInputTokens;
        outputTokens += rowOutputTokens;
        requests += 1;
        addSpend(byKey, spendKeyLabel(row), spend, rowInputTokens, rowOutputTokens);
        addSpend(byUser, spendLabel(row, ['user_id', 'internal_user_id', 'end_user', 'user']), spend, rowInputTokens, rowOutputTokens);
        addSpend(byModel, spendLabel(row, ['model', 'model_name']), spend, rowInputTokens, rowOutputTokens);
      }
      page += 1;
    } while (page <= totalPages && page <= maxPages);

    return {
      startDate,
      endDate,
      totalSpend,
      requests,
      inputTokens,
      outputTokens,
      byKey: sortedSpend(byKey),
      byUser: sortedSpend(byUser),
      byModel: sortedSpend(byModel),
      truncated: totalPages > maxPages,
    };
  }

  async getModelHealth(): Promise<LiteLLMModelHealthSummary> {
    const body = await this.request('/health', {}, false);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new LiteLLMAdminError('LiteLLM returned an invalid health response', 502, 'invalid_upstream_response');
    }
    const result = body as Record<string, unknown>;
    const healthy = Array.isArray(result.healthy_endpoints) ? result.healthy_endpoints : [];
    const unhealthy = Array.isArray(result.unhealthy_endpoints) ? result.unhealthy_endpoints : [];
    const checks = [
      ...healthy.map((value, index) => healthCheck(value, 'healthy', index)),
      ...unhealthy.map((value, index) => healthCheck(value, 'unhealthy', healthy.length + index)),
    ];

    return {
      status: unhealthy.length === 0 ? 'healthy' : 'degraded',
      healthyCount: healthy.length,
      unhealthyCount: unhealthy.length,
      checks,
      checkedAt: new Date().toISOString(),
    };
  }
}

export const liteLLMAdminService = new LiteLLMAdminService();
