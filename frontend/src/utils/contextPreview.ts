import { authenticatedFetch } from './auth';

export type ContextKind = 'task' | 'phase' | 'project' | 'skill' | 'report';
export type ContextOperation = 'brief' | 'record' | 'resources' | 'skill-content';
export interface ContextPayload { text: string; endpoint: string; etag: string | null }
export const contextOperations = (kind: ContextKind): ContextOperation[] =>
  kind === 'skill' ? ['record', 'skill-content'] :
  kind === 'report' ? ['record'] :
  kind === 'project' ? ['brief', 'resources', 'record'] : ['brief', 'record'];
export const operationLabels: Record<ContextOperation, string> = {
  brief: 'Compiled brief',
  record: 'Record',
  resources: 'Project resources',
  'skill-content': 'Published skill content',
};
// Unicode scalar count, without allocating an array proportional to the text.
export function estimateContextTokens(text: string): number {
  let characters = 0;
  for (const _character of text) characters++;
  return Math.ceil(characters / 4);
}
export async function loadContext(
  kind: ContextKind, id: string, operation: ContextOperation, signal: AbortSignal,
): Promise<ContextPayload> {
  if (!contextOperations(kind).includes(operation)) throw new Error('Unsupported context operation.');
  const base = (import.meta.env.VITE_API_BASE_URL || '/api') + '/' + kind + 's/' + encodeURIComponent(id);
  const request = async (endpoint: string, method = 'GET') => {
    const response = await authenticatedFetch(endpoint, {
      method, signal, cache: 'no-store',
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
    });
    const envelope = await response.json();
    if (!response.ok || envelope?.success === false)
      throw new Error(envelope?.message || envelope?.error || 'HTTP ' + response.status);
    return { envelope, etag: response.headers?.get('etag') ?? null };
  };
  let endpoint = base;
  if (operation === 'brief') endpoint += '/brief';
  if (operation === 'resources') endpoint += '/context';
  if (operation === 'skill-content') {
    const { envelope } = await request(base);
    const version = envelope.skill?.current_published_version_id;
    if (typeof version !== 'string' || !version)
      throw new Error('This skill has no published version. Its record is available in the other view.');
    endpoint += '/versions/' + encodeURIComponent(version) + '/content';
  }
  const { envelope, etag } = await request(endpoint, operation === 'brief' ? 'POST' : 'GET');
  if (operation === 'brief' && typeof envelope.brief !== 'string')
    throw new Error('The response did not contain a brief.');
  // Same JSON indentation as MCP detailed; retain every field, including
  // omission metadata and existing untrusted-data fences. Never summarise.
  return { text: operation === 'brief' ? envelope.brief : JSON.stringify(envelope, null, 2), endpoint, etag };
}
