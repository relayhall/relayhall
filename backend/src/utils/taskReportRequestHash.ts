import crypto from 'crypto';

/**
 * The logical request hash of one Task Report save: what
 * task_report_operations.request_hash stores, what a 2xx save returns as
 * operation.requestHash, and what GET /tasks/{id}/report-operations/{key}
 * takes as ?requestHash. The save path and the same-key replay refusal
 * (card e5240c73) both compute it here, so they cannot drift apart.
 */
export function taskReportRequestHash(input: {
  title?: unknown; content?: unknown; summary?: unknown; reportId?: unknown; expectedContentHash?: unknown;
}): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    title: input.title, content: input.content, summary: input.summary ?? null,
    reportId: input.reportId ?? null, expectedContentHash: input.expectedContentHash ?? null,
  }), 'utf8').digest('hex');
}
