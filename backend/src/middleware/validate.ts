import { Request, Response, NextFunction, RequestHandler } from 'express';
import { sendApiError } from '../utils/apiErrors';

/**
 * Minimal dependency-free request-body validation (task 3c7da35b).
 * Field rules cover what RelayHall's API actually needs; errors are
 * field-level and actionable.
 */
export interface FieldRule {
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  maxLen?: number;
  enum?: readonly string[];
  /** for arrays: validate every element is a non-empty string */
  itemsType?: 'string';
  pattern?: RegExp;
  patternHint?: string;
}

export type BodySchema = Record<string, FieldRule>;

export interface FieldError { field: string; problem: string }

export function checkBody(
  body: unknown,
  schema: BodySchema,
  opts: { allowUnknown?: boolean } = {},
): FieldError[] {
  const errors: FieldError[] = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return [{ field: '(body)', problem: 'request body must be a JSON object' }];
  }
  const obj = body as Record<string, unknown>;

  for (const [field, rule] of Object.entries(schema)) {
    const value = obj[field];
    if (value === undefined || value === null) {
      if (rule.required) errors.push({ field, problem: 'is required' });
      continue;
    }
    if (rule.type === 'array') {
      if (!Array.isArray(value)) { errors.push({ field, problem: 'must be an array' }); continue; }
      if (rule.itemsType === 'string' && value.some(v => typeof v !== 'string' || v === '')) {
        errors.push({ field, problem: 'must contain only non-empty strings' });
      }
    } else if (rule.type && typeof value !== rule.type) {
      errors.push({ field, problem: `must be a ${rule.type}` });
      continue;
    }
    if (rule.maxLen !== undefined && typeof value === 'string' && value.length > rule.maxLen) {
      errors.push({ field, problem: `must be at most ${rule.maxLen} characters` });
    }
    if (rule.enum && typeof value === 'string' && !rule.enum.includes(value)) {
      errors.push({ field, problem: `must be one of: ${rule.enum.join(', ')}` });
    }
    if (rule.pattern && typeof value === 'string' && !rule.pattern.test(value)) {
      errors.push({ field, problem: rule.patternHint || 'has an invalid format' });
    }
  }

  if (!opts.allowUnknown) {
    for (const key of Object.keys(obj)) {
      if (!(key in schema)) errors.push({ field: key, problem: 'is not a recognized field' });
    }
  }
  return errors;
}

export function validateBody(schema: BodySchema, opts: { allowUnknown?: boolean } = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const errors = checkBody(req.body, schema, opts);
    if (errors.length === 0) { next(); return; }
    sendApiError(
      res, 400, 'VALIDATION_FAILED',
      `Request body failed validation (${errors.length} problem${errors.length === 1 ? '' : 's'})`,
      'Fix the listed fields and retry. See /openapi.json for the endpoint schema.',
      errors,
    );
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
