export const REPORT_HANDOVER_SCHEMA_VERSION = 1 as const;
export const REPORT_HANDOVER_MAX_ITEMS_PER_FIELD = 50;
export const REPORT_HANDOVER_MAX_ITEM_LENGTH = 2000;
export const REPORT_HANDOVER_MAX_BYTES = 64 * 1024;

export const REPORT_HANDOVER_FIELDS = [
  'decisions',
  'assumptions',
  'alternatives_rejected',
  'unresolved_questions',
] as const;

export type ReportHandoverField = typeof REPORT_HANDOVER_FIELDS[number];

export interface ReportHandover {
  schema_version: typeof REPORT_HANDOVER_SCHEMA_VERSION;
  decisions: string[];
  assumptions: string[];
  alternatives_rejected: string[];
  unresolved_questions: string[];
}

export class ReportHandoverValidationError extends Error {
  readonly code = 'INVALID_REPORT_HANDOVER';

  constructor(message: string) {
    super(message);
    this.name = 'ReportHandoverValidationError';
  }
}

function normalizeItems(field: ReportHandoverField, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ReportHandoverValidationError(`handover.${field} must be an array of strings`);
  }
  if (value.length > REPORT_HANDOVER_MAX_ITEMS_PER_FIELD) {
    throw new ReportHandoverValidationError(
      `handover.${field} may contain at most ${REPORT_HANDOVER_MAX_ITEMS_PER_FIELD} items`,
    );
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new ReportHandoverValidationError(`handover.${field}[${index}] must be a string`);
    }
    const normalized = item.trim();
    if (!normalized) {
      throw new ReportHandoverValidationError(`handover.${field}[${index}] must not be blank`);
    }
    if (/\r|\n/.test(normalized)) {
      throw new ReportHandoverValidationError(`handover.${field}[${index}] must be a single-line string`);
    }
    if (normalized.length > REPORT_HANDOVER_MAX_ITEM_LENGTH) {
      throw new ReportHandoverValidationError(
        `handover.${field}[${index}] may contain at most ${REPORT_HANDOVER_MAX_ITEM_LENGTH} characters`,
      );
    }
    return normalized;
  });
}

/**
 * Validate and canonicalize the optional wire value. Omission is handled by
 * callers; explicit null clears the handover on PATCH. Object output always
 * has the complete v1 key set so REST, CLI, MCP, GUI and Brief consumers see
 * one stable representation.
 */
export function normalizeReportHandover(value: unknown): ReportHandover | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ReportHandoverValidationError('handover must be an object or null');
  }

  const input = value as Record<string, unknown>;
  const allowed = new Set<string>(['schema_version', ...REPORT_HANDOVER_FIELDS]);
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ReportHandoverValidationError(`handover contains unknown field '${unknown.sort()[0]}'`);
  }

  const schemaVersion = input.schema_version ?? REPORT_HANDOVER_SCHEMA_VERSION;
  if (schemaVersion !== REPORT_HANDOVER_SCHEMA_VERSION) {
    throw new ReportHandoverValidationError(
      `handover.schema_version must be ${REPORT_HANDOVER_SCHEMA_VERSION}`,
    );
  }

  const normalized: ReportHandover = {
    schema_version: REPORT_HANDOVER_SCHEMA_VERSION,
    decisions: normalizeItems('decisions', input.decisions),
    assumptions: normalizeItems('assumptions', input.assumptions),
    alternatives_rejected: normalizeItems('alternatives_rejected', input.alternatives_rejected),
    unresolved_questions: normalizeItems('unresolved_questions', input.unresolved_questions),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > REPORT_HANDOVER_MAX_BYTES) {
    throw new ReportHandoverValidationError(
      `handover canonical JSON may contain at most ${REPORT_HANDOVER_MAX_BYTES} bytes`,
    );
  }
  return normalized;
}
