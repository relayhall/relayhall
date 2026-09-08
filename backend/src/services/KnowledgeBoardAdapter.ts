/**
 * KnowledgeBoardAdapter.ts — RH-KW1 candidate C (card `0b4b779b`).
 *
 * §9's reserved board pseudo-source: the RelayHall board answering knowledge
 * queries about its OWN rows, in-process, with no channel, no assertion and
 * no outbound socket.
 *
 * ── THE ONE RULE THIS FILE EXISTS TO KEEP ──
 *
 * §9: "Its adapter authorizes IN-QUERY, not filter-after-page: it composes
 * the shipped object-family scope (`reports:read`/`tasks:read`/`skills:read`,
 * `skills:use` for full skill content — §5.1) AND the shared-predicate WHERE
 * fragment into the query itself, so the page is drawn from authorized rows,
 * `limitPerSource` means what it says, and per-source counts leak nothing
 * about unreadable rows."
 *
 * Every SELECT below therefore carries the authorization in its own WHERE and
 * applies `LIMIT` only AFTER it. Nothing here reads a page and then filters
 * it: that shape is the hazard `routes/reports.ts:241-244` warns about in its
 * own comment, and acceptance item 11's count-oracle clause drills it.
 *
 * ── WHICH SHIPPED PREDICATE, AND WHY IT IS NOT THE ONE THE DESIGN NAMED ──
 *
 * §9's parenthetical names `AccessProfileService.activeProfileCondition()`.
 * That function is real and does emit the exact/all-of-type/all-except
 * selector SQL — but it is ONE ARM of the shipped read predicate, not the
 * predicate (breakdown `abc71ffb` finding **F2**). The seam every shipped
 * list read funnels into is `AuthorizationService.sqlCondition`, reached here
 * through `authorizedListScope` → `AuthorizationRepository.listScope`, which
 * is the same call `TaskManagerDB` uses for its paginated Task list. An
 * adapter composing only the profile arm would be strictly NARROWER than the
 * shipped read path — a caller authorized by a grant, by ownership, by
 * authorship or by object visibility would see nothing from the board — and
 * acceptance 11's POSITIVE controls would fail. This is a declared substrate
 * refinement, recorded in the breakdown and restated in the evidence report;
 * it does not amend §9, whose binding requirement is "it composes … the
 * shared-predicate WHERE fragment … into the query itself".
 *
 * ── THE TWO FILTERS `sqlCondition` DOES NOT EXPRESS (finding F3) ──
 *
 * The shipped `GET /reports` runs `filterAuthorizedResources` and then TWO
 * more post-SQL filters. An adapter composing only `sqlCondition` would
 * OVER-disclose reports relative to the shipped list — the exact failure
 * acceptance 11's first clause forbids. Both are re-expressed here as in-query
 * `EXISTS` fragments, and `kw1KnowledgeBoardSource.test.ts` drills each one
 * with a positive and a negative control:
 *
 *   1. `filterTaskScopedPromotions` (`routes/reports.ts:40-56`) — an
 *      auto-promoted report survives only if its SOURCE TASK is readable.
 *      Note the shipped shape drops an auto-promoted report with a NULL
 *      `source_task_id`, and so does the fragment.
 *   2. `TaskElementService.filterPromotedReports` (`:638-662`) — an
 *      auto-promoted report from an `assigned-only` outpost survives only if
 *      the caller is claimant, shepherd or verifier on `task_assignments` for
 *      that Task. Its root bypass is the `root` SCOPE, exactly as
 *      `promotedReportActor` (`routes/reports.ts:24-38`) computes it — never
 *      the role.
 *
 * ── WHAT IS NOT AUTHORIZATION AND MUST NOT BE MISTAKEN FOR IT ──
 *
 * The board's content is still UNTRUSTED CONTENT in model position and is
 * fenced by the same §7.6 mechanism as any source's (§9, last paragraph).
 * This file produces core-owned VALUES; the fencing happens where results are
 * rendered, and `ref` never leaves core except sealed in a handle (§8.1).
 */
import type { AuthRequest } from '../middleware/auth';
import { authorizedListScope, actorFromRequest } from '../middleware/sharedAuthorization';
import { pool } from '../db/connection';
import { scopesSatisfy, ROOT_SCOPE, type Scope } from '../utils/scopeMap';
import type { KnowledgeContentKind } from '../utils/serviceDescriptor';

/**
 * The board's DECLARED compartment vocabulary, core-authored in migration 116
 * and re-stated here as the code's own view of the same three names.
 *
 * These two statements must agree, and a test proves it against the row
 * rather than against this constant: `kw1KnowledgeBoardSource.test.ts` reads
 * the descriptor from the database and compares. A constant that only agrees
 * with itself is the class of control this project has been bitten by.
 */
export const BOARD_COMPARTMENTS = ['reports', 'tasks', 'skills'] as const;
export type BoardCompartment = (typeof BOARD_COMPARTMENTS)[number];

/** The class each compartment declares, mirroring the descriptor's `classes`. */
export const BOARD_COMPARTMENT_KIND: Readonly<Record<BoardCompartment, KnowledgeContentKind>> = {
  reports: 'docs',
  tasks: 'docs',
  skills: 'code',
};

/** The object-family scope §5.1 composes for each compartment. */
export const BOARD_COMPARTMENT_SCOPE: Readonly<Record<BoardCompartment, Scope>> = {
  reports: 'reports:read',
  tasks: 'tasks:read',
  skills: 'skills:read',
};

/**
 * §5.1: "`skills:use` for full skill content". A caller with `skills:read`
 * may see a skill listed and described; the SKILL.md body is a get, and the
 * get asks for the second scope.
 */
export const BOARD_SKILL_CONTENT_SCOPE: Scope = 'skills:use';

/** One §7.2-shaped result, with core-owned values in every field. */
export interface BoardResult {
  ref: string;
  title: string;
  snippet: string;
  contentKind: KnowledgeContentKind;
  compartment: BoardCompartment;
  score: number;
  updatedAt?: string;
  parentRef?: string;
}

export interface BoardSearchInput {
  q: string;
  /** The request's `kinds` — the §5.5 (d) arm, applied per compartment. */
  kinds: readonly KnowledgeContentKind[];
  /** `limitPerSource`, applied in-query AFTER the authorization. */
  limit: number;
}

/**
 * What the board answered, and whether it had more to say.
 *
 * `truncated` exists because of round-1 finding P3: the board is ONE source
 * and `limitPerSource` is a per-SOURCE cap, but the adapter used to spend the
 * whole limit on each of its three compartments and concatenate — a limit of
 * one returned three results. The cap is now a budget that decrements across
 * the families, and when a family still had rows the budget could not pay for,
 * the board says so the same way an over-limit external source does.
 */
export interface BoardSearchOutcome {
  results: BoardResult[];
  truncated: boolean;
}

/** `report:<uuid>` / `task:<uuid>` / `skill:<uuid>` — core-authored, never source-authored. */
const REF_PATTERN = /^(report|task|skill):([0-9a-f-]{36})$/;

const COMPARTMENT_BY_REF_KIND: Readonly<Record<string, BoardCompartment>> = {
  report: 'reports',
  task: 'tasks',
  skill: 'skills',
};

/**
 * ILIKE with the caller's own wildcards neutralised.
 *
 * `q` is caller text. Left alone, `%` would turn a narrow query into "match
 * everything", which is not an injection (the value is a parameter) but IS a
 * way to enumerate a corpus with one character. The escape is the shipped
 * `ESCAPE` clause, not a hand-rolled sanitiser.
 */
function likePattern(q: string): string {
  return `%${q.replace(/([\\%_])/g, '\\$1')}%`;
}

/**
 * A CORE-COMPUTED score in [0,1] (§7.2: "`score` clamped to a core float in
 * [0,1]").
 *
 * Deliberately crude and deliberately core's: a title match outranks a body
 * match, and nothing else is claimed. §7.4 forbids cross-source normalization
 * anyway, so a cleverer number here would buy the board position it has not
 * earned.
 */
const TITLE_MATCH_SCORE = 0.9;
const BODY_MATCH_SCORE = 0.5;

function snippetOf(value: string | null | undefined): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 500 ? text.slice(0, 500) : text;
}

function isoOrUndefined(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Does the caller hold the object-family scope this compartment composes? */
export function boardCompartmentPermitted(
  scopes: string[] | null | undefined,
  compartment: BoardCompartment,
): boolean {
  return scopesSatisfy(scopes ?? null, BOARD_COMPARTMENT_SCOPE[compartment]);
}

/**
 * §11.11's count-oracle clause, restated as a rule this file obeys: NOTHING
 * here returns a count, a total, or a `hasMore`. Two corpora differing only
 * by rows the caller may not read produce byte-identical responses because
 * the unreadable rows never reach the page in the first place.
 */
export async function searchBoard(
  req: AuthRequest,
  input: BoardSearchInput,
): Promise<BoardSearchOutcome> {
  const actor = req.authorizationActor ?? actorFromRequest(req);
  const scopes = actor.scopes ?? null;
  const kinds = new Set(input.kinds);
  const results: BoardResult[] = [];
  let truncated = false;

  for (const compartment of BOARD_COMPARTMENTS) {
    // The remaining budget. Once it is spent the board stops asking: a
    // compartment that would have matched is a TRUNCATION, not an absence,
    // and the caller is told which source dropped rows rather than being
    // handed a set that quietly exceeds the cap it asked for.
    const remaining = input.limit - results.length;
    if (remaining <= 0) {
      truncated = truncated || await compartmentHasMatch(req, compartment, input, scopes, kinds);
      continue;
    }
    // §5.5 (d), applied per compartment: the board declares `docs` for
    // reports and tasks and `code` for skills, and a request that asked for
    // neither gets that compartment's rows from nobody.
    if (!kinds.has(BOARD_COMPARTMENT_KIND[compartment])) continue;
    // §5.1's composed SCOPE half. A caller holding `knowledge-contents:read`
    // and object grants but NOT `reports:read` gets nothing from the reports
    // group — acceptance item 11's third clause.
    if (!boardCompartmentPermitted(scopes, compartment)) continue;

    // One extra row is asked for, and never returned: it is how the adapter
    // learns that the budget — not the corpus — is what ended the list.
    const probe = { ...input, limit: remaining + 1 };
    const rows = compartment === 'reports'
      ? await searchReports(req, probe)
      : compartment === 'tasks'
        ? await searchTasks(req, probe)
        : await searchSkills(req, probe);
    if (rows.length > remaining) truncated = true;
    results.push(...rows.slice(0, remaining));
  }
  return { results, truncated };
}

/**
 * Would this compartment have matched, had there been budget?
 *
 * Asked only once the budget is spent, and only to decide `truncated`. It
 * runs the same authorized query with a limit of one, so it cannot see a row
 * the caller could not see.
 */
async function compartmentHasMatch(
  req: AuthRequest,
  compartment: BoardCompartment,
  input: BoardSearchInput,
  scopes: string[] | null,
  kinds: Set<KnowledgeContentKind>,
): Promise<boolean> {
  if (!kinds.has(BOARD_COMPARTMENT_KIND[compartment])) return false;
  if (!boardCompartmentPermitted(scopes, compartment)) return false;
  const probe = { ...input, limit: 1 };
  const rows = compartment === 'reports'
    ? await searchReports(req, probe)
    : compartment === 'tasks'
      ? await searchTasks(req, probe)
      : await searchSkills(req, probe);
  return rows.length > 0;
}

async function searchReports(req: AuthRequest, input: BoardSearchInput): Promise<BoardResult[]> {
  const actor = req.authorizationActor ?? actorFromRequest(req);
  const holdsRoot = scopesSatisfy(actor.scopes ?? null, ROOT_SCOPE);

  // $1 the pattern; the predicate's own parameters follow it.
  const params: unknown[] = [likePattern(input.q)];
  const reportScope = authorizedListScope(req, 'report', 'read');
  const reportCondition = reportScope.render(params.length + 1);
  params.push(...reportCondition.params);

  // F3 limb 2 — the source Task must itself be readable, decided by the SAME
  // predicate over the Task family rather than by a second rule.
  const taskScope = authorizedListScope(req, 'task', 'read');
  const taskCondition = taskScope.render(params.length + 1);
  params.push(...taskCondition.params);

  // F3 limb 3 — the `assigned-only` outpost intersection. `root` (the SCOPE,
  // as `promotedReportActor` computes it) bypasses; nothing else does.
  let assignedOnlySql = 'TRUE';
  if (!holdsRoot) {
    params.push(actor.principalId ?? null);
    const principalParam = `$${params.length}`;
    assignedOnlySql = `(
      NOT COALESCE(r.auto_promoted, FALSE)
      OR COALESCE(r.source_outpost_visibility_tier, '') <> 'assigned-only'
      OR (r.source_task_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM task_assignments ta
             WHERE ta.task_id = r.source_task_id
               AND ${principalParam}::uuid IN (ta.claimant_principal_id, ta.shepherd_principal_id, ta.verifier_principal_id)))
    )`;
  }

  params.push(input.limit);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT r.id, r.title, r.summary, r.content, r.updated_at,
           (r.title ILIKE $1 ESCAPE '\\') AS title_hit
      FROM ${reportScope.from}
     WHERE r.deleted_at IS NULL
       AND r.status <> 'deleted'
       AND (r.title ILIKE $1 ESCAPE '\\' OR r.summary ILIKE $1 ESCAPE '\\' OR r.content ILIKE $1 ESCAPE '\\')
       AND ${reportCondition.sql}
       AND (
         NOT COALESCE(r.auto_promoted, FALSE)
         OR (r.source_task_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM ${taskScope.from}
                WHERE t.id = r.source_task_id AND ${taskCondition.sql}))
       )
       AND ${assignedOnlySql}
     ORDER BY r.updated_at DESC NULLS LAST, r.id
     LIMIT ${limitParam}`;

  const result = await pool.query(sql, params);
  return result.rows.map((row) => ({
    ref: `report:${row.id}`,
    title: String(row.title ?? ''),
    snippet: snippetOf(row.summary ?? row.content),
    contentKind: BOARD_COMPARTMENT_KIND.reports,
    compartment: 'reports' as const,
    score: row.title_hit ? TITLE_MATCH_SCORE : BODY_MATCH_SCORE,
    ...(isoOrUndefined(row.updated_at) ? { updatedAt: isoOrUndefined(row.updated_at) } : {}),
  }));
}

async function searchTasks(req: AuthRequest, input: BoardSearchInput): Promise<BoardResult[]> {
  const params: unknown[] = [likePattern(input.q)];
  const scope = authorizedListScope(req, 'task', 'read');
  const condition = scope.render(params.length + 1);
  params.push(...condition.params);
  params.push(input.limit);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT t.id, t.title, t.description, t.updated_at, t.project_id,
           (t.title ILIKE $1 ESCAPE '\\') AS title_hit
      FROM ${scope.from}
     WHERE t.archived_at IS NULL
       AND (t.title ILIKE $1 ESCAPE '\\' OR COALESCE(t.description, '') ILIKE $1 ESCAPE '\\')
       AND ${condition.sql}
     ORDER BY t.updated_at DESC NULLS LAST, t.id
     LIMIT ${limitParam}`;

  const result = await pool.query(sql, params);
  return result.rows.map((row) => ({
    ref: `task:${row.id}`,
    title: String(row.title ?? ''),
    snippet: snippetOf(row.description),
    contentKind: BOARD_COMPARTMENT_KIND.tasks,
    compartment: 'tasks' as const,
    score: row.title_hit ? TITLE_MATCH_SCORE : BODY_MATCH_SCORE,
    ...(isoOrUndefined(row.updated_at) ? { updatedAt: isoOrUndefined(row.updated_at) } : {}),
    // §7.2's `parentRef`, core-authored: a Task's Project, when it has one.
    ...(row.project_id ? { parentRef: `project:${row.project_id}` } : {}),
  }));
}

async function searchSkills(req: AuthRequest, input: BoardSearchInput): Promise<BoardResult[]> {
  const params: unknown[] = [likePattern(input.q)];
  const scope = authorizedListScope(req, 'skill', 'read');
  const condition = scope.render(params.length + 1);
  params.push(...condition.params);
  params.push(input.limit);
  const limitParam = `$${params.length}`;

  // Only PUBLISHED versions are searchable content: an unpublished draft is
  // not a skill the estate offers, and `skills.current_published_version_id`
  // is the shipped statement of that.
  const sql = `
    SELECT s.id, s.name, s.updated_at, sv.description,
           (s.name ILIKE $1 ESCAPE '\\') AS title_hit
      FROM ${scope.from}
      JOIN skill_versions sv ON sv.id = s.current_published_version_id
     WHERE (s.name ILIKE $1 ESCAPE '\\' OR COALESCE(sv.description, '') ILIKE $1 ESCAPE '\\')
       AND ${condition.sql}
     ORDER BY s.updated_at DESC NULLS LAST, s.id
     LIMIT ${limitParam}`;

  const result = await pool.query(sql, params);
  return result.rows.map((row) => ({
    ref: `skill:${row.id}`,
    title: String(row.name ?? ''),
    snippet: snippetOf(row.description),
    contentKind: BOARD_COMPARTMENT_KIND.skills,
    compartment: 'skills' as const,
    score: row.title_hit ? TITLE_MATCH_SCORE : BODY_MATCH_SCORE,
    ...(isoOrUndefined(row.updated_at) ? { updatedAt: isoOrUndefined(row.updated_at) } : {}),
  }));
}

/** What a board get returns, or `null` — never a reason (§11.10). */
export interface BoardObject {
  content: string;
  compartment: BoardCompartment;
}

/**
 * §8.2's board branch: "At GET, §8.2's board branch RE-RUNS the same composed
 * authorization on the addressed object before reading."
 *
 * Re-runs, not remembers. The handle proves which object was addressed and
 * which compartment it was sealed under; it proves nothing about whether the
 * caller may still read it. So this asks the same two halves the search asked
 * — the composed scope and the in-query predicate — against the ONE addressed
 * row, and a caller who has since lost either gets `null`.
 *
 * `null` carries no reason for the same reason the search carries no count:
 * "A's own board handle after A loses read is refused" and "a board handle for
 * a report A may read, presented by B who may not" must be indistinguishable
 * to the caller, and both must be indistinguishable from a handle naming a row
 * that never existed.
 */
export async function readBoardObject(
  req: AuthRequest,
  ref: string,
  sealedCompartment: string,
): Promise<BoardObject | null> {
  const match = REF_PATTERN.exec(ref);
  if (!match) return null;
  const compartment = COMPARTMENT_BY_REF_KIND[match[1]];
  const id = match[2];
  // The compartment the handle was sealed with must be the compartment the
  // ref's own family declares. A handle whose two halves disagree addresses
  // nothing.
  if (!compartment || compartment !== sealedCompartment) return null;

  const actor = req.authorizationActor ?? actorFromRequest(req);
  const scopes = actor.scopes ?? null;
  if (!boardCompartmentPermitted(scopes, compartment)) return null;
  // §5.1's second skill scope: listing a skill is `skills:read`, reading its
  // SKILL.md is `skills:use`.
  if (compartment === 'skills' && !scopesSatisfy(scopes, BOARD_SKILL_CONTENT_SCOPE)) {
    return null;
  }

  if (compartment === 'reports') return readReport(req, id);
  if (compartment === 'tasks') return readTask(req, id);
  return readSkill(req, id);
}

async function readReport(req: AuthRequest, id: string): Promise<BoardObject | null> {
  const actor = req.authorizationActor ?? actorFromRequest(req);
  const holdsRoot = scopesSatisfy(actor.scopes ?? null, ROOT_SCOPE);

  const params: unknown[] = [id];
  const reportScope = authorizedListScope(req, 'report', 'read');
  const reportCondition = reportScope.render(params.length + 1);
  params.push(...reportCondition.params);
  const taskScope = authorizedListScope(req, 'task', 'read');
  const taskCondition = taskScope.render(params.length + 1);
  params.push(...taskCondition.params);

  let assignedOnlySql = 'TRUE';
  if (!holdsRoot) {
    params.push(actor.principalId ?? null);
    const principalParam = `$${params.length}`;
    assignedOnlySql = `(
      NOT COALESCE(r.auto_promoted, FALSE)
      OR COALESCE(r.source_outpost_visibility_tier, '') <> 'assigned-only'
      OR (r.source_task_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM task_assignments ta
             WHERE ta.task_id = r.source_task_id
               AND ${principalParam}::uuid IN (ta.claimant_principal_id, ta.shepherd_principal_id, ta.verifier_principal_id)))
    )`;
  }

  const result = await pool.query(
    `SELECT r.title, r.content
       FROM ${reportScope.from}
      WHERE r.id = $1::uuid
        AND r.deleted_at IS NULL
        AND ${reportCondition.sql}
        AND (
          NOT COALESCE(r.auto_promoted, FALSE)
          OR (r.source_task_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM ${taskScope.from}
                 WHERE t.id = r.source_task_id AND ${taskCondition.sql}))
        )
        AND ${assignedOnlySql}
      LIMIT 1`,
    params,
  );
  if (result.rows.length === 0) return null;
  return { content: String(result.rows[0].content ?? ''), compartment: 'reports' };
}

async function readTask(req: AuthRequest, id: string): Promise<BoardObject | null> {
  const params: unknown[] = [id];
  const scope = authorizedListScope(req, 'task', 'read');
  const condition = scope.render(params.length + 1);
  params.push(...condition.params);
  const result = await pool.query(
    `SELECT t.title, COALESCE(t.description, '') AS description
       FROM ${scope.from}
      WHERE t.id = $1::uuid AND ${condition.sql}
      LIMIT 1`,
    params,
  );
  if (result.rows.length === 0) return null;
  return { content: String(result.rows[0].description ?? ''), compartment: 'tasks' };
}

async function readSkill(req: AuthRequest, id: string): Promise<BoardObject | null> {
  const params: unknown[] = [id];
  const scope = authorizedListScope(req, 'skill', 'read');
  const condition = scope.render(params.length + 1);
  params.push(...condition.params);
  const result = await pool.query(
    `SELECT sv.skill_md
       FROM ${scope.from}
       JOIN skill_versions sv ON sv.id = s.current_published_version_id
      WHERE s.id = $1::uuid AND ${condition.sql}
      LIMIT 1`,
    params,
  );
  if (result.rows.length === 0) return null;
  return { content: String(result.rows[0].skill_md ?? ''), compartment: 'skills' };
}
