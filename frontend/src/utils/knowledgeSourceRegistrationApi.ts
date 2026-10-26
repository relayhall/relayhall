import { authenticatedFetch } from './auth';

/**
 * Two-way registration of a knowledge source, the core half (card 08792425,
 * member N6; the default-store design's choice C7). The board decides
 * everything: these calls carry no authority. The registration is a login-
 * session act for root or an administrator, with a single-use step-up bound to
 * (knowledge.source.register, the bundle's certificate fingerprint), checked
 * again on the server.
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

export const KNOWLEDGE_SOURCE_REGISTER_STEP_UP_ACTION = 'knowledge.source.register';
export const REGISTRATION_BUNDLE_SCHEMA = 'rh.knowledge-source.registration/1';

export interface RegistrationState {
  schemaVersion: string;
  service: { id: string; slug: string; name: string; status: string; currentDescriptorVersion: number | null };
  endpoints: { query: string | null; get: string | null; write: string | null; allowedNetworks: string[] };
  fingerprint: { sha256: string; display: string; confirmation: 'checked' | 'typed'; confirmedBy: string; confirmedAt: string };
  channel: {
    credentialReference: string | null;
    environmentVariable: string;
    resolves: boolean;
    dial: 'refused' | 'ready';
    refusal: string | null;
  };
  operatorSteps: Array<{ id: string; done: boolean; text: string }>;
  lifecycleExport: { configured: boolean; keyRecorded: boolean };
  assertionKeysConfigured: boolean;
  grantsForApproval: {
    scope: string;
    targetType: string;
    change: { rules: Array<{ resourceType: string; selectorForm: string; selectorIds: string[]; verbs: string[] }> };
    decidedOn: string;
    direct?: { surface: string; granteeType: string; resourceType: string; resourceId: string; verb: string };
  };
}

export interface ReturnBundle {
  schema: string;
  serviceId: string;
  audience: string;
  issuer: string;
  certificateSha256: string;
  credentialReference: string | null;
  assertionKeys: { keys: Array<Record<string, string>> };
  lifecycleKey: { kid: string; jwk: Record<string, string> } | null;
}

/** What the page reads from a pasted or uploaded bundle before anything is sent. */
export interface BundlePreview {
  bundle: Record<string, unknown>;
  name: string;
  endpoint: string;
  fingerprint: string;
  fingerprintDisplay: string;
  protocolVersion: unknown;
}

export class RegistrationRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly field?: string, public readonly stepUp?: { methods?: Array<'password' | 'sso'> }) {
    super(message);
    this.name = 'RegistrationRequestError';
  }
}

/** The fingerprint as the board normalizes it: 64 lower-case hex digits, or null. */
export function normalizeFingerprint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const text = value.trim().replace(/^sha256\s*(fingerprint)?\s*[:=]\s*/i, '');
  const compact = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){31}$/.test(text) ? text.replace(/:/g, '') : text;
  return /^[0-9a-fA-F]{64}$/.test(compact) ? compact.toLowerCase() : null;
}

/** The fingerprint as a person compares it with a console: upper-case colon-separated pairs. */
export function displayFingerprint(sha256: string): string {
  return (sha256.toUpperCase().match(/.{2}/g) ?? []).join(':');
}

/** Read a pasted bundle. Returns the preview, or a sentence saying what is wrong with it. */
export function previewBundle(text: string): { ok: true; preview: BundlePreview } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'The bundle is not valid JSON. Paste the whole bundle the installer printed.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'The bundle must be a JSON object.' };
  }
  const bundle = parsed as Record<string, unknown>;
  if (bundle.schema !== REGISTRATION_BUNDLE_SCHEMA) {
    return { ok: false, message: `This is not a registration bundle (its schema must be ${REGISTRATION_BUNDLE_SCHEMA}).` };
  }
  const fingerprint = normalizeFingerprint(bundle.certificateSha256);
  if (!fingerprint) return { ok: false, message: 'The bundle carries no readable certificate fingerprint.' };
  const descriptor = bundle.descriptor as { knowledgeSource?: { protocol_version?: unknown } } | undefined;
  return {
    ok: true,
    preview: {
      bundle,
      name: typeof bundle.name === 'string' ? bundle.name : '',
      endpoint: typeof bundle.endpoint === 'string' ? bundle.endpoint : '',
      fingerprint,
      fingerprintDisplay: displayFingerprint(fingerprint),
      protocolVersion: descriptor?.knowledgeSource?.protocol_version,
    },
  };
}

async function answer(response: Response): Promise<any> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RegistrationRequestError(
      response.status,
      typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`,
      typeof body?.message === 'string' ? body.message : 'The board refused the request.',
      typeof body?.field === 'string' ? body.field : undefined,
      body?.stepUp && typeof body.stepUp === 'object' ? body.stepUp : undefined,
    );
  }
  return body;
}

export async function fetchRegistrations(): Promise<RegistrationState[]> {
  const body = await answer(await authenticatedFetch(`${API_BASE}/knowledge-source-registrations`));
  return Array.isArray(body?.registrations) ? body.registrations as RegistrationState[] : [];
}

export async function fetchReturnBundle(serviceId: string): Promise<ReturnBundle> {
  return await answer(await authenticatedFetch(`${API_BASE}/knowledge-source-registrations/${encodeURIComponent(serviceId)}/return-bundle`)) as ReturnBundle;
}

export async function registerKnowledgeSource(input: {
  bundle: Record<string, unknown>;
  confirmedFingerprint: string;
  allowedNetworks: string[];
  stepUpToken: string;
}): Promise<{ registration: RegistrationState; returnBundle: ReturnBundle | null }> {
  const body = await answer(await authenticatedFetch(`${API_BASE}/knowledge-source-registrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bundle: input.bundle,
      confirmedFingerprint: input.confirmedFingerprint,
      confirmation: 'checked',
      ...(input.allowedNetworks.length > 0 ? { allowedNetworks: input.allowedNetworks } : {}),
      stepUpToken: input.stepUpToken,
    }),
  }));
  return { registration: body.registration as RegistrationState, returnBundle: (body.returnBundle ?? null) as ReturnBundle | null };
}
