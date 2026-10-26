/**
 * timelineRouteObligations.test.ts — C1 route-level obligations (review
 * edf44910 F4): visibility parity with /stream, typed 400s for invalid
 * filter/cursor, degradation surfaced in the response envelope, and the
 * reports route obligations (UUID validation, authorization narrowing
 * before pagination and again before serialization). House idiom: structural pins over the route source, in the
 * same spirit as notesAttribution.test.ts — the functional behavior is
 * pinned by the unifiedTimeline suite over the production functions.
 */
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(SRC, p), "utf-8");

function timelineHandler(): string {
  const routes = read("routes/tasks.ts");
  const start = routes.indexOf("router.get('/:id/timeline'");
  expect(start).toBeGreaterThan(-1);
  return routes.slice(start, routes.indexOf("\nrouter.", start + 10));
}

describe("GET /tasks/:id/timeline route obligations", () => {
  it("visibility parity: the timeline reads the stream through the SAME governed call as GET /:id/stream", () => {
    const routes = read("routes/tasks.ts");
    const streamStart = routes.indexOf("router.get('/:id/stream'");
    const streamBody = routes.slice(streamStart, routes.indexOf("\nrouter.", streamStart + 10));
    const shared = "taskElementService.listStream(";
    expect(streamBody).toContain(shared);
    const body = timelineHandler();
    expect(body).toContain(shared);
    // both pass the server-derived actor, never body/header input
    expect(body).toContain("taskElementActor(req)");
    expect(streamBody).toContain("taskElementActor(req)");
    expect(body).not.toContain("req.body");
    // and the timeline path must NOT run its own stream SQL
    expect(body).not.toContain("task_stream_entries");
  });

  it("invalid filter and invalid cursor get typed 400s before any source read", () => {
    const body = timelineHandler();
    expect(body).toContain("INVALID_FILTER");
    expect(body).toContain("INVALID_CURSOR");
    const filterIdx = body.indexOf("INVALID_FILTER");
    const cursorIdx = body.indexOf("INVALID_CURSOR");
    const firstRead = body.indexOf("listStream");
    expect(filterIdx).toBeGreaterThan(-1);
    expect(cursorIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeLessThan(firstRead);
    expect(cursorIdx).toBeLessThan(firstRead);
    // the cursor gate uses the semantic decoder, not a shape check
    expect(body).toContain("decodeCursor(before)");
  });

  it("per-source degradation is caught per source and surfaced in the envelope", () => {
    const body = timelineHandler();
    // each governed read is individually caught…
    expect((body.match(/catch \(err\)/g) || []).length).toBeGreaterThanOrEqual(2);
    // …and the response carries the honesty fields
    expect(body).toContain("sourcesUnavailable: result.sourcesUnavailable");
    expect(body).toContain("nextCursor: result.nextCursor");
  });

  it("the retired frozen ledger is not read anywhere in the tasks routes", () => {
    const routes = read("routes/tasks.ts");
    expect(routes).not.toContain("task_timeline_events");
    expect(routes).not.toContain("TaskTimelineService");
  });
});

describe("GET /reports taskId route obligations", () => {
  it("validates the full UUID with a typed 400 and threads taskId to the manager", () => {
    const routes = read("routes/reports.ts");
    const start = routes.indexOf("router.get('/'");
    const body = routes.slice(start, routes.indexOf("\nrouter.", start + 10));
    expect(body).toContain("INVALID_TASK_ID");
    expect(body).toMatch(/taskId.*full task UUID/);
    expect(body).toContain("taskId,");
  });

  it("shared authorization narrows pagination candidates and rechecks fetched content before serialization", () => {
    // Pagination counts only visible candidates through the shared policy.
    // Fetched full rows are checked again before serialization because their
    // visibility/content may change after the candidate/count decision.
    const routes = read("routes/reports.ts");
    const start = routes.indexOf("router.get('/'");
    const body = routes.slice(start, routes.indexOf("\nrouter.", start + 10));
    const listIdx = body.indexOf("reportManager.list(");
    const candidateFilter = "(rows) => filterVisibleReports(req as AuthRequest, rows)";
    const finalFilter = "const reports = await filterVisibleReports(req as AuthRequest, result.reports)";
    const candidateIdx = body.indexOf(candidateFilter);
    const finalIdx = body.indexOf(finalFilter);
    const responseIdx = body.indexOf("res.json({", listIdx);
    expect(listIdx).toBeGreaterThan(-1);
    expect(candidateIdx).toBeGreaterThan(listIdx);
    expect(finalIdx).toBeGreaterThan(candidateIdx);
    expect(responseIdx).toBeGreaterThan(finalIdx);

    const visibility = read("services/ReportVisibility.ts");
    for (const name of ["filterAuthorizedResources", "filterTaskScopedPromotions", "filterPromotedReports"]) {
      expect(`ReportVisibility composes ${name}: ${visibility.includes(name)}`)
        .toBe(`ReportVisibility composes ${name}: true`);
    }
    const composed = visibility.slice(visibility.indexOf("export async function filterVisibleReports"));
    expect(composed.indexOf("filterAuthorizedResources"))
      .toBeLessThan(composed.indexOf("filterVisiblePromotions"));

    // Forward the visible count/page decision, not a page-length total or
    // constant hasMore. Concurrent final-row omissions can shorten this page.
    const response = body.slice(responseIdx, body.indexOf("});", responseIdx));
    expect(response).toContain("reports,");
    expect(response).toContain("total: result.total");
    expect(response).toContain("hasMore: result.hasMore");
  });
});
