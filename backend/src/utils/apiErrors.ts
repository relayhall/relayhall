import { Response } from 'express';
import { logCaughtFailure } from './secretSafeLog';

/**
 * Standard API error envelope (task 3c7da35b).
 * Keeps the legacy top-level `error` + `code` fields for backward
 * compatibility and adds `message` + `suggestion` for humans and agents.
 */
export interface ApiErrorBody {
  success: false;
  error: string;      // legacy: short error string (same as message)
  code: string;       // machine-readable, SCREAMING_SNAKE
  message: string;    // human-readable description
  suggestion?: string; // what the caller should do about it
  details?: unknown;  // e.g. field-level validation errors
}

export function sendApiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  suggestion?: string,
  details?: unknown,
): Response {
  const body: ApiErrorBody = { success: false, error: message, code, message };
  if (suggestion) body.suggestion = suggestion;
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

/**
 * Postgres raises 22001 (string_data_right_truncation) when a value exceeds a
 * varchar width. Left uncaught it reaches the client as a bare 500 carrying a
 * raw database message. Route validation names the fields we know about; this
 * is the safety net for every other bounded column.
 * Note 22001 does not identify the column, so the caller supplies the context.
 */
export function isStringTooLongError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '22001';
}

/**
 * Send a 400 for an over-length value. `context` names the resource so the
 * caller knows where to look, e.g. 'report'.
 */
export function sendStringTooLongError(res: Response, context: string, err: unknown): Response {
  // The driver's own message is a caught value (it can carry the offending
  // row) and never reaches the caller — the fixed message plus the OpenAPI
  // field limits are the actionable content (card 49399562).
  const errorId = logCaughtFailure(`[api] over-length ${context} value:`, err);
  return sendApiError(
    res, 400, 'VALUE_TOO_LONG',
    `A ${context} field is longer than the column allows`,
    'Shorten the offending field and retry. See /openapi.json for field limits.',
    { errorId },
  );
}

/** Express error-handling middleware — normalizes uncaught route errors. */
export function apiErrorHandler(
  err: unknown,
  _req: import('express').Request,
  res: Response,
  next: import('express').NextFunction,
): void {
  if (res.headersSent) { next(err); return; }
  // Through the secret-safe sink like every other caught value; the caller
  // gets the correlating errorId, never the message (card 49399562).
  const errorId = logCaughtFailure('[api] unhandled route error:', err);
  sendApiError(
    res, 500, 'INTERNAL_ERROR',
    'Unexpected server error',
    'Retry once; if it persists check backend logs (docker logs relayhall-backend).',
    { errorId },
  );
}
