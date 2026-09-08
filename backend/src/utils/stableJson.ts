/**
 * Canonical JSON serialization with recursively sorted object keys.
 *
 * Moved here from `services/ProjectResourceService.ts` (card fb06c930, design
 * record bf8928ee v5 §3.4) so the 067 replacement contract and the generic
 * retry middleware hash requests through ONE implementation. The behaviour is
 * byte-identical to the function it replaces; `ProjectResourceService` imports
 * it back.
 *
 * 067 feeds it VALIDATED input, so there `{}` and `{ agentVisibility: 'default' }`
 * are one request. The generic middleware runs before validation and feeds it
 * the raw `{ params, body }`, so there an omitted field and an explicitly
 * defaulted one are two requests — documented in `docs/mcp.md`.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(',')}}`;
  }
  throw new Error('Canonical request serialization received a non-JSON value');
}

export default stableJson;
