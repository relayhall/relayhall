import { Response } from 'express';

const REPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidReportId(id: string): boolean {
  return REPORT_ID_RE.test(id);
}

/**
 * 8-char prefixes are CLI-only sugar; the API requires full UUIDs. Without this
 * guard, malformed ids reached Postgres and surfaced as HTTP 500 with a leaked
 * driver error ("invalid input syntax for type uuid").
 */
export function rejectInvalidReportIdParam(id: string, res: Response): boolean {
  if (isValidReportId(id)) {
    return false;
  }

  res.status(400).json({
    success: false,
    error: 'Invalid report id (full UUID required; 8-char prefixes are CLI-only)',
    code: 'INVALID_REPORT_ID',
  });
  return true;
}
