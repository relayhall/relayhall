// reportsTaskIdFilter.test.ts — C1 (RH-UI.7, design 3cdf6e65 §4.2):
// GET /reports?taskId= closed additive filter — task_ids containment OR
// task_references kind=report linkage; read-only; camelCase param.
import { reportManager } from "../services/ReportManager";
import { pool } from "../db/connection";

const TASK = "11111111-1111-4111-8111-111111111111";

describe("reports taskId filter (§4.2)", () => {
  afterEach(() => jest.restoreAllMocks());

  test("list() adds the containment-or-reference condition with the UUID bound once per arm", async () => {
    const spy = jest.spyOn(pool, "query").mockResolvedValue({ rows: [{ total: '0' }] } as never);
    await reportManager.list({ taskId: TASK, limit: 10 });
    const calls = spy.mock.calls.map(c => String(c[0]));
    const listSql = calls.find(sql => /FROM reports r/i.test(sql)) || calls[0];
    expect(listSql).toContain("r.task_ids::text[] @>");
    expect(listSql).toContain("task_references tr");
    expect(listSql).toContain("tr.kind = 'report'");
    expect(listSql).toContain("tr.target_id = r.id");
    const params = spy.mock.calls.find(c => /FROM reports r/i.test(String(c[0])))?.[1] as unknown as any[];
    expect(params).toContain(TASK);
    for (const call of spy.mock.calls) {
      expect(String(call[0])).not.toMatch(/\b(insert|update|delete|truncate|alter)\b/i);
    }
    spy.mockRestore();
  });

  test("list() returns rows the filter matched — both arms reach the data query", async () => {
    const row = {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Linked report", content: "body", summary: null, tags: [],
      project_id: null, task_ids: [TASK], author: "system", origin: "api",
      visibility: "default", auto_promoted: false, handover: null,
      pinned: false, status: "active",
      created_at: "2026-08-14T00:00:00.000Z", updated_at: "2026-08-14T00:00:00.000Z",
      deleted_at: null,
    };
    const spy = jest.spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [{ total: "1" }] } as never)
      .mockResolvedValueOnce({ rows: [row] } as never);
    const result = await reportManager.list({ taskId: TASK, limit: 10 });
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].id).toBe(row.id);
    expect(result.reports[0].task_ids).toContain(TASK);
    // the data query carries the same containment-or-reference condition
    const dataSql = String(spy.mock.calls[1][0]);
    expect(dataSql).toContain("r.task_ids::text[] @>");
    expect(dataSql).toContain("tr.kind = 'report'");
    expect((spy.mock.calls[1][1] as unknown as any[])).toContain(TASK);
  });

  test("list() without taskId leaves the query untouched", async () => {
    const spy = jest.spyOn(pool, "query").mockResolvedValue({ rows: [{ total: '0' }] } as never);
    await reportManager.list({ limit: 10 });
    for (const call of spy.mock.calls) {
      expect(String(call[0])).not.toContain("task_references");
    }
    spy.mockRestore();
  });
});
