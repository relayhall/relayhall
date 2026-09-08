/**
 * Every path that mutates tasks.notes must leave an attributed history row.
 *
 * This property was claimed twice and false twice: first the indentation was
 * described as tamper-proofing (it is not), then the history guarantee was
 * added but missed two of the four writable paths — including
 * POST /tasks/:id/notes, the endpoint this task added for writing notes.
 * The pin below is deliberately written as an enumeration of WRITE PATHS
 * rather than of the one path that was being thought about at the time.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf-8');

describe('notes write paths are attributed', () => {
  it('POST /tasks/:id/notes records history alongside its direct SQL write', () => {
    const routes = read('routes/tasks.ts');
    const handler = routes.slice(routes.indexOf("router.post('/:id/notes'"));
    const body = handler.slice(0, handler.indexOf('\nrouter.'));
    // It writes by raw SQL, so it does not inherit updateTask's recording.
    expect(body).toContain('UPDATE tasks SET notes');
    expect(body).toContain('taskHistoryService.recordChange');
    expect(body).toContain("'notes'");
  });

  it('the updateTask guard compares the value actually written, not the caller field', () => {
    // archiveReason reaches notes via statusUpdates.notes; a guard on
    // updates.notes alone silently skipped it.
    const db = read('services/TaskManagerDB.ts');
    expect(db).toContain('const writtenNotes =');
    expect(db).toContain('statusUpdates.notes !== undefined ? statusUpdates.notes : updates.notes');
    expect(db).not.toMatch(/if \(updates\.notes !== undefined && updates\.notes !== oldNotes\)/);
  });

  it('archiveTask threads an actor through to the history row', () => {
    const db = read('services/TaskManagerDB.ts');
    const start = db.indexOf('  async archiveTask(');
    const body = db.slice(start, db.indexOf('\n  async ', start + 10));
    expect(body).toContain('actor?: TaskActor');
    expect(body).toMatch(/archiveReason: options\.reason,\s*\}, actor\)/);
    const routes = read('routes/tasks.ts');
    expect(routes).toContain('archiveTask(req.params.id, { reason }, requestActor(req))');
  });

  it('the actor is server-derived on every notes path — never from the body', () => {
    const routes = read('routes/tasks.ts');
    const actorFn = routes.slice(routes.indexOf('function requestActor'));
    const body = actorFn.slice(0, actorFn.indexOf('\n}') + 2);
    expect(body).toContain('authReq.principal');
    expect(body).toContain('authReq.userId');
    // A body- or header-sourced actor would make the row spoofable.
    expect(body).not.toContain('req.body');
    expect(body).not.toContain('req.headers');
  });
});

describe('disable is a kill switch on every auth path', () => {
  it('rejects a disabled principal on both JWT branches, not only rh_ keys', () => {
    const auth = read('middleware/auth.ts');
    // v2 branch, legacy-handle branch, and the session stub.
    const statusChecks = auth.match(/principal\.status !== 'active'/g) || [];
    expect(statusChecks.length).toBeGreaterThanOrEqual(3);
  });

  it('will not let the API disable the owner identity (R11)', () => {
    const principals = read('routes/principals.ts');
    expect(principals).toContain("target.handle === 'dashboard_user' && status === 'disabled'");
    expect(principals).toContain("target.handle === 'system' && status === 'disabled'");
  });
});
