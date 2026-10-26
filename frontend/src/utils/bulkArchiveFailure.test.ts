import { it, expect } from 'vitest';
import { describeBulkArchiveFailures as describe, bulkArchiveOutcome, bulkArchiveOutcomeLabel, copyBulkArchiveOutcomes } from './bulkArchiveFailure';
const ids = Array.from({ length: 8 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`);
it('eight references do not repeat the reason or enter the toast', () => {
 const text = describe(ids.map(errorId => ({ code: 'FORBIDDEN', errorId })));
 expect(text).toBe('Lifecycle authority does not permit archival: 8');
 expect(text.length).toBeLessThan(100);
});
it('mixed hostile JSON fields use fixed reasons without coercion', () => {
 expect(describe([{ code: '__proto__', errorId: 'SECRET' }, { code: { toString: null } }, { code: 'NOT_COMPLETED' }]))
  .toBe('Archive failed: 2; Task is no longer completed: 1');
});
it('complete requested identities and safe references remain in copy output', () => {
 const rows = ids.map((id, i) => bulkArchiveOutcome(id, { archived: i === 0, code: 'FORBIDDEN', errorId: id }));
 const text = copyBulkArchiveOutcomes(rows);
 expect(text.split('\n')).toHaveLength(8);
 for (const id of ids) expect(text).toContain(id);
 expect(text).toContain('Archived\tARCHIVED'); expect(text).toContain('Not archived\tFORBIDDEN');
});
it.each([{}, [], null, 1, true, 'SECRET'])('unsafe reference %j never enters outcome', errorId => {
 expect(bulkArchiveOutcome(ids[0], { code: 'unknown', errorId })).toEqual({ id: ids[0], archived: false, confirmed: false, code: 'ERROR', references: [] });
});
it('all known reasons still produce a bounded summary', () => {
 const text = describe(['FORBIDDEN','LIFECYCLE_POLICY_DENIED','ASSIGNMENT_REFERENCE_BUSY','TASK_REVIEW_EVIDENCE_BUSY','NOT_FOUND','NOT_COMPLETED','ERROR','BULK_ARCHIVE_FAILED','REQUEST_FAILED'].map(code => ({code})));
 expect(text.length).toBeLessThan(200); expect(text).toContain('6 other failures');
});
it('lost response never claims absence of archival', () => {
 const row = bulkArchiveOutcome(ids[0], {code: 'REQUEST_FAILED'});
 expect(bulkArchiveOutcomeLabel(row)).toBe('Outcome not confirmed');
 expect(copyBulkArchiveOutcomes([row])).toContain('Outcome not confirmed');
});
it.each([undefined, null, 'false', 0, true])('only explicit negative archived false is a denial: %j', archived => {
 const row = bulkArchiveOutcome(ids[0], {code: 'FORBIDDEN', archived});
 expect(bulkArchiveOutcomeLabel(row)).toBe(archived === true ? 'Archived' : 'Outcome not confirmed');
});
it('already archived remains the actual supported success outcome', () => {
 const row = bulkArchiveOutcome(ids[0], {archived: true, code: 'ALREADY_ARCHIVED'});
 expect(row.code).toBe('ALREADY_ARCHIVED'); expect(bulkArchiveOutcomeLabel(row)).toBe('Already archived');
 expect(copyBulkArchiveOutcomes([row])).toContain('Already archived\tALREADY_ARCHIVED');
});
it('uncertain duplicate outcome retains every safe diagnostic reference', () => {
 const row = bulkArchiveOutcome(ids[0], {code: 'REQUEST_FAILED'}, [ids[1], ids[2], ids[1], {secret: 'SECRET'}]);
 expect(row.references).toEqual([ids[1], ids[2]]);
 expect(bulkArchiveOutcomeLabel(row)).toBe('Outcome not confirmed');
 const text = copyBulkArchiveOutcomes([row]); expect(text).toContain(ids[1]); expect(text).toContain(ids[2]); expect(text).not.toContain('SECRET');
});
