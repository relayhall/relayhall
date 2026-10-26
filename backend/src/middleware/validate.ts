import { Request, Response, NextFunction, RequestHandler, RequestParamHandler } from 'express';
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

/**
 * Is `value` longer than `max` CHARACTERS? A character is a code point, the way
 * PostgreSQL measures a `varchar(n)` column and the way the Task and Phase
 * routes count. `String.length` counts UTF-16 units and overstates every
 * character outside the Basic Multilingual Plane (an emoji is two), so a title
 * the column holds was refused. A string never has more code points than units,
 * so one that is short in units is short in characters and is not iterated.
 */
function exceedsCharacters(value: string, max: number): boolean {
  if (value.length <= max) return false;
  let count = 0;
  for (const _ of value) {
    count += 1;
    if (count > max) return true;
  }
  return false;
}

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
    if (rule.maxLen !== undefined && typeof value === 'string' && exceedsCharacters(value, rule.maxLen)) {
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

/**
 * Cards 9cdc6b27 and bc847bd0 (owner ruling E159, "refuse names"): a path id a
 * handler hands to a uuid-typed read must be a full UUID, or PostgreSQL's cast
 * failure (22P02) surfaces as a 5xx. A malformed one is refused by name, with
 * 400 and the family's INVALID_<OBJECT>_ID, before anything reads it. An
 * uppercase UUID passes unchanged, an unknown UUID still answers from its read,
 * and no name is ever resolved to an id here.
 */
export function isFullUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The refusal, in the house envelope: 400 `code`, "<noun> id must be a full UUID". */
export function refuseMalformedPathId(res: Response, code: string, noun: string, suggestion?: string): void {
  sendApiError(res, 400, code, `${noun} id must be a full UUID`, suggestion);
}

/**
 * The same guard as a `router.param` callback, for a family whose every route
 * carrying the parameter already sits behind its authority check (the route
 * ceiling runs before a router's param callbacks, so a caller without
 * authority keeps its 403).
 */
export function pathUuidParam(code: string, noun: string, suggestion?: string): RequestParamHandler {
  return (_req: Request, res: Response, next: NextFunction, value: string): void => {
    if (!isFullUuid(value)) {
      refuseMalformedPathId(res, code, noun, suggestion);
      return;
    }
    next();
  };
}
