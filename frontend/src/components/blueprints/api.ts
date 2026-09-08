import { authenticatedFetch } from '../../utils/auth';
export const BLUEPRINT_API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
export class BlueprintRequestError extends Error {
  constructor(message: string, public code: string, public field?: string, public uncertain = false) { super(message); }
}
export async function blueprintRequest<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await authenticatedFetch(`${BLUEPRINT_API_BASE}${path}`, options); }
  catch { throw new BlueprintRequestError('The connection ended before a response was received. Retry the same request.', 'CONNECTION_UNCERTAIN', undefined, true); }
  let body;
  try { body = await response.json(); }
  catch { throw new BlueprintRequestError('A complete response was not received. Retry the same request.', 'RESPONSE_UNCERTAIN', undefined, true); }
  if (!response.ok || body.success === false) {
    throw new BlueprintRequestError(typeof body.error === 'string' ? body.error : 'The operation could not be completed.',
      typeof body.code === 'string' ? body.code : 'OPERATION_REFUSED', typeof body.field === 'string' ? body.field : undefined, response.status >= 500);
  }
  return body as T;
}
export const blueprintJson = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export function blueprintError(error: unknown): BlueprintRequestError {
  return error instanceof BlueprintRequestError ? error : new BlueprintRequestError('The operation could not be completed.', 'OPERATION_REFUSED');
}
