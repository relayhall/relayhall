// mapReportLinkage.test.ts — the Map must read the RATIFIED report-to-task
// linkage (design 3cdf6e65 §4.2, card C1), not reports.source_task_id.
//
// Found by an adversarial pass over the A7a round-2 repairs, not by a review.
// queryLinkedReports filtered on source_task_id; measured on DEV, 3 of 3
// reports carry task_ids and ZERO carry source_task_id, so the §3 report pills
// were dead code that could never render. The same DEV data yields 5
// (report, task) pairs, two of the reports citing two tasks each — which is
// exactly the many-valued case §3 draws a dashed edge for and a single-valued
// column can never express.
//
// Written in the shape of reportsTaskIdFilter.test.ts, which pins the same
// closed additive filter for GET /reports?taskId=.
import { pool } from '../db/connection';
import { taskManagerDB } from '../services/TaskManagerDB';

const TASK_A = '11111111-1111-4111-8111-111111111111';
const TASK_B = '22222222-2222-4222-8222-222222222222';

describe('Map report linkage (§4.2 ratified linkage, §3 pills)', () => {
  afterEach(() => jest.restoreAllMocks());

  test('queries BOTH arms — task_ids containment and task_references kind=report', async () => {
    const spy = jest.spyOn(pool, 'query').mockResolvedValue({ rows: [] } as never);
    await taskManagerDB.queryLinkedReports([TASK_A]);

    const sql = String(spy.mock.calls[0][0]);
    // Containment arm.
    expect(sql).toContain('unnest(r.task_ids)');
    // Reference arm.
    expect(sql).toContain('task_references');
    expect(sql).toContain("tr.kind = 'report'");
    expect(sql).toContain('tr.target_id = r.id');
    // A report matching through BOTH arms must not be returned twice.
    expect(sql).toContain('DISTINCT');
    // Deleted reports never surface on the Map.
    expect(sql).toContain('r.deleted_at IS NULL');
    // The retired single-valued column must NOT come back.
    expect(sql).not.toContain('source_task_id');
    // Read-only, like every other graph read.
    for (const call of spy.mock.calls) {
      expect(String(call[0])).not.toMatch(/\b(insert|update|delete|truncate|alter)\b/i);
    }
  });

  test('returns one row per (report, task) pair, so a Report can cite several Tasks', async () => {
    // Shape recorded from the real DEV rows: report fc67ad8e cites two tasks.
    jest.spyOn(pool, 'query').mockResolvedValue({
      rows: [
        { id: 'report-1', task_id: TASK_A, title: 'Cites two' },
        { id: 'report-1', task_id: TASK_B, title: 'Cites two' },
      ],
    } as never);

    const rows = await taskManagerDB.queryLinkedReports([TASK_A, TASK_B]);
    expect(rows).toEqual([
      { id: 'report-1', taskId: TASK_A, title: 'Cites two' },
      { id: 'report-1', taskId: TASK_B, title: 'Cites two' },
    ]);
  });

  test('an empty id set does no query at all', async () => {
    const spy = jest.spyOn(pool, 'query').mockResolvedValue({ rows: [] } as never);
    expect(await taskManagerDB.queryLinkedReports([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
