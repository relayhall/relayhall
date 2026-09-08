/**
 * RH-AZ.PROJ-a (card b363a38c) — the 085 apparatus, transplanted to the Task.
 *
 * This file is the FIDELITY check: migration 117 must carry the same five
 * pieces 085 carries (bare column, append-only ledger table, attributed
 * trigger, append-only guard, dedicated admin route), and the query seam that
 * feeds the point evaluator must actually SELECT the columns the mapping
 * consumes — a mapping that reads a column no query selects is a rule that
 * silently evaluates to "not restricted".
 *
 * The RUNTIME behaviour of the trigger (an unattributed write RAISEs, the
 * ledger table refuses UPDATE and DELETE) needs a real PostgreSQL and is
 * proved in the live drill recorded in the evidence report, not here.
 */
import fs from 'fs';
import path from 'path';

const source = (relative: string) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

describe('explicit Task restricted-access contract (owner ruling 44ee41f2, migration 117)', () => {
  const sql = source('migrations/117_task_restricted_access.sql');

  it('adds the column BARE on the hot table, exactly as 063 prescribes', () => {
    expect(sql).toMatch(/ALTER TABLE tasks\s+ADD COLUMN IF NOT EXISTS restricted_access BOOLEAN NOT NULL DEFAULT FALSE/);
    // A hot table takes no CHECK/FK in the same breath; 063's shape is a bare
    // add, and anything else would have to arrive NOT VALID + VALIDATE.
    expect(sql).not.toMatch(/ALTER TABLE tasks[\s\S]{0,400}ADD CONSTRAINT/);
  });

  it('ledgers every attributed policy change and refuses an unattributed one', () => {
    expect(sql).toContain('task_access_events');
    expect(sql).toContain('tasks_restricted_access_ledger');
    expect(sql).toContain("current_setting('relayhall.task_access_actor'");
    expect(sql).toContain("current_setting('relayhall.task_access_reason'");
    expect(sql).toContain('require attributed audit context');
    expect(sql).toMatch(/BEFORE UPDATE OF restricted_access ON tasks/);
  });

  it('makes the ledger append-only in the database, not by convention', () => {
    expect(sql).toContain('task_access_events_append_only');
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON task_access_events/);
    expect(sql).toContain("RAISE EXCEPTION 'task_access_events is append-only'");
  });

  it('refreshes the table comment the way 085 did', () => {
    expect(sql).toContain('COMMENT ON TABLE tasks IS');
    expect(sql).toContain('COMMENT ON TABLE task_access_events IS');
    expect(sql).toContain('COMMENT ON COLUMN tasks.restricted_access IS');
  });

  it('keeps the reason and the transition honest at the column level', () => {
    expect(sql).toContain('CHECK (length(trim(reason)) BETWEEN 3 AND 1000)');
    expect(sql).toContain('CHECK (previous_restricted <> restricted)');
  });

  it('keeps restriction out of ordinary edits and behind a dedicated admin route', () => {
    const route = source('routes/tasks.ts');
    const scopes = source('utils/scopeMap.ts');
    const service = source('services/TaskAccessService.ts');
    expect(route).toContain("router.patch('/:id/access'");
    expect(scopes).toMatch(/tasks\\\/\[\^\/\]\+\\\/access.*tasks:admin/);
    // The only writer sets BOTH audit GUCs; a second writer that forgot one
    // could not commit anyway, but the single-writer shape is the contract.
    expect(service).toContain("'relayhall.task_access_actor'");
    expect(service).toContain("'relayhall.task_access_reason'");
    const writers = route.match(/restricted_access/g) ?? [];
    expect(writers).toHaveLength(0);
  });

  it('uses the explicit columns, never grant presence, to suppress inheritance', () => {
    const evaluator = source('services/AuthorizationService.ts');
    const repository = source('services/AuthorizationRepository.ts');
    expect(evaluator).toContain('!resource.restrictedAccess');
    expect(evaluator).not.toContain('hasExactGrantSet');
    // The two `restrictedAccess` coordinates are pinned BY LITERAL in
    // taskProjectVisibilityInheritance.test.ts, and the Phase one is the
    // ratified 085 assertion in phaseRestrictedAccessContract.test.ts.
    // Repeating them as whole-file `toContain`s here only added another
    // place an unrelated occurrence could answer. The NEGATIVE assertions
    // stay: a negative cannot be satisfied by an unrelated substring, only
    // broken by one.
    expect(repository).not.toContain('has_exact_grant_set');
  });
});

describe('AZ.PROJ-a — the query seam that feeds the point mapping', () => {
  it('selects every column the Task mapping reads, and joins both ancestors', () => {
    const repository = source('services/AuthorizationRepository.ts');
    const pointQuery = repository.slice(
      repository.indexOf("case 'task':"),
      repository.indexOf("case 'project':"),
    );
    // Pinned as an EXACT projection, not as substrings. Reviews cf04a642
    // F3 and a8e380f1 F1 were one defect twice: a `toContain` scoped wide
    // enough that an unrelated occurrence answered it — first the JOIN
    // below, then the ratified Phase coordinate. An equality has no such
    // failure mode, so this is the shape that TERMINATES that regress
    // rather than a narrower substring. Whitespace is normalised because
    // SQL indentation is not the contract; the columns and their order are.
    const flatten = (text: string) => text.replace(/\s+/g, ' ').trim();
    const projection = flatten(pointQuery.slice(
      pointQuery.indexOf('SELECT t.id'), pointQuery.indexOf('FROM tasks t')));
    expect(projection).toBe(
      'SELECT t.id, t.owner_principal_id, t.creator_principal_id, t.visibility,'
      + ' t.project_id, t.restricted_access,'
      + ' ph.restricted_access AS phase_restricted_access,'
      + ' p.visibility AS project_visibility, p.status AS project_status,'
      + " to_jsonb(t)->>'shepherd_principal_id' AS shepherd_principal_id,"
      + " to_jsonb(t)->>'verifier_principal_id' AS verifier_principal_id",
    );
    const from = flatten(pointQuery.slice(
      pointQuery.indexOf('FROM tasks t'), pointQuery.indexOf('WHERE t.id')));
    expect(from).toBe(
      'FROM tasks t LEFT JOIN phases ph ON ph.id = t.phase_id'
      + ' LEFT JOIN projects p ON p.id = t.project_id',
    );
  });
});
