// skills.ts - immutable Agent Skills registry REST contract.
import { Router, Request, Response } from 'express';
import {
  skillManager, SkillContractError, SkillProvenance, SkillVersionStatus,
} from '../services/SkillManager';
import { lifecyclePolicyDenialEnvelope } from '../services/LifecyclePolicyService';
import { AuthRequest } from '../middleware/auth';
import { isStringTooLongError, sendStringTooLongError, sendApiError } from '../utils/apiErrors';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { filterAuthorizedResources } from '../middleware/sharedAuthorization';

const router = Router();
const VERSION_FIELDS = [
  'skill_md', 'description', 'usage_instructions', 'category', 'config', 'tags',
  'provenance', 'source_uri',
];
const CREATE_FIELDS = ['name', ...VERSION_FIELDS, 'is_global'];
const QUERY_LIMITS = { category: 100, tag: 128, search: 256 } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVENANCE: SkillProvenance[] = ['human-authored', 'imported', 'agent-drafted'];

function actor(req: AuthRequest): string | undefined { return req.principal?.id; }
function canManage(req: AuthRequest): boolean {
  return req.scopes?.includes('root') === true
    || req.scopes?.includes('skills:write') === true
    || req.scopes?.includes('skills:admin') === true;
}
function readIfMatchRevision(req: Request, res: Response): string | null {
  const raw = req.headers['if-match'];
  if (raw === undefined) {
    sendApiError(res, 400, 'REVISION_REQUIRED', 'The last observed revision is required (If-Match)');
    return null;
  }
  if (typeof raw !== 'string') {
    sendApiError(res, 400, 'INVALID_REVISION_PRECONDITION', 'If-Match must be one strong UUID revision');
    return null;
  }
  const trimmed = raw.trim();
  const quoted = /^"([^"]*)"$/.exec(trimmed);
  const revision = quoted ? quoted[1] : trimmed;
  if (!revision || trimmed === '*' || /^W\//i.test(trimmed) || revision.includes(',') || !UUID_RE.test(revision)) {
    sendApiError(res, 400, 'INVALID_REVISION_PRECONDITION', 'If-Match must be one strong UUID revision');
    return null;
  }
  return revision;
}

function checkQueryKeys(req: Request, res: Response, allowed: string[]): boolean {
  for (const [key, value] of Object.entries(req.query)) {
    if (!allowed.includes(key)) {
      sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown query parameter '${key}'`);
      return false;
    }
    if (Array.isArray(value) || typeof value !== 'string' || value.length === 0) {
      sendApiError(res, 400, 'INVALID_QUERY_VALUE', `Query parameter '${key}' must be one non-empty string`);
      return false;
    }
    const limit = QUERY_LIMITS[key as keyof typeof QUERY_LIMITS];
    if (limit !== undefined && value.length > limit) {
      sendApiError(res, 400, 'QUERY_VALUE_TOO_LONG',
        `Query parameter '${key}' must be at most ${limit} characters`, undefined,
        { field: key, maxLength: limit });
      return false;
    }
  }
  return true;
}

function validateVersionBody(body: unknown, create: boolean): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'request body must be an object';
  const value = body as Record<string, unknown>;
  const allowed = create ? CREATE_FIELDS : VERSION_FIELDS;
  for (const key of Object.keys(value)) if (!allowed.includes(key)) return `Unknown field '${key}' in request body`;
  if (!create && Object.keys(value).length === 0) return 'request body must contain Version content or metadata';
  if (create && (typeof value.name !== 'string' || !value.name.trim())) return 'name is required';
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 64)) {
    return 'name must be a string of at most 64 characters';
  }
  if (value.skill_md !== undefined && (typeof value.skill_md !== 'string' || !value.skill_md)) {
    return 'skill_md must be a non-empty string';
  }
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 1024)) {
    return 'description must be a string of at most 1024 characters';
  }
  if (value.usage_instructions !== undefined
      && (typeof value.usage_instructions !== 'string' || value.usage_instructions.length > 524288)) {
    return 'usage_instructions must be a string of at most 524288 characters';
  }
  if (value.category !== undefined && (typeof value.category !== 'string' || value.category.length > 100)) {
    return 'category must be a string of at most 100 characters';
  }
  if (value.config !== undefined && (!value.config || typeof value.config !== 'object' || Array.isArray(value.config))) {
    return 'config must be a JSON object';
  }
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 64
      || value.tags.some(tag => typeof tag !== 'string' || !tag || tag.length > 100))) {
    return 'tags must contain at most 64 non-empty strings of at most 100 characters';
  }
  if (value.provenance !== undefined && !PROVENANCE.includes(value.provenance as SkillProvenance)) {
    return `provenance must be one of: ${PROVENANCE.join(', ')}`;
  }
  if (value.source_uri !== undefined && (typeof value.source_uri !== 'string' || !value.source_uri.trim()
      || value.source_uri.length > 2048)) return 'source_uri must be a non-blank string of at most 2048 characters';
  if (value.provenance === 'imported' && typeof value.source_uri !== 'string') {
    return 'imported provenance requires source_uri';
  }
  if (value.is_global !== undefined && typeof value.is_global !== 'boolean') return 'is_global must be a boolean';
  return null;
}

function validateNoteOnly(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) return 'request body must be an object';
  const value = body as Record<string, unknown>;
  for (const key of Object.keys(value)) if (key !== 'note') return `Unknown field '${key}' in request body`;
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 4000)) {
    return 'note must be a string of at most 4000 characters';
  }
  return null;
}

function sendSkillError(res: Response, error: unknown, context: string): void {
  const policy = lifecyclePolicyDenialEnvelope(error);
  if (policy) {
    sendApiError(res, policy.status, policy.code, policy.message, undefined, policy.details);
    return;
  }
  if (error instanceof SkillContractError) {
    sendApiError(res, error.status, error.code, error.message);
    return;
  }
  if (isStringTooLongError(error)) { sendStringTooLongError(res, 'skill', error); return; }
  const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
  if (code === '23505') { sendApiError(res, 409, 'SKILL_NAME_TAKEN', 'A Skill with that name already exists'); return; }
  if (code === '23514' || code === '55000') {
    // The constraint's own message is a driver value (it can carry row
    // content); the fixed message plus the correlating errorId are the
    // contract (card 49399562).
    const errorId = logCaughtFailure(`[Skills API] ${context} lifecycle conflict:`, error);
    sendApiError(res, 409, 'SKILL_LIFECYCLE_CONFLICT', 'Illegal Skill lifecycle change', undefined, { errorId });
    return;
  }
  const errorId = logCaughtFailure(`[Skills API] ${context} failed:`, error);
  sendApiError(res, 500, 'INTERNAL_ERROR', 'Unexpected server error', undefined, { errorId });
}

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, ['category', 'tag', 'search'])) return;
    const { category, tag, search } = req.query as Record<string, string | undefined>;
    const listedSkills = await skillManager.list({ category, tag, search }, canManage(req));
    const skills = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      listedSkills,
      (skill) => ({ type: 'skill', id: skill.id }),
    );
    res.json({ success: true, skills });
  } catch (error) {
    sendSkillError(res, error, 'list');
  }
});

router.get('/:id/versions', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    res.json({ success: true, versions: await skillManager.listVersions(req.params.id, canManage(req)) });
  } catch (error) { sendSkillError(res, error, 'list versions'); }
});

// Full immutable content is deliberately a skills:use disclosure surface.
//
// RH-P3.C4 (strategy §2.10 cache doctrine, ratified C3): the version-pinned
// DISPOSABLE skill cache revalidates at session start, and revalidation needs
// a 304 — an ETag a caller can never spend is not etag support. The digest is
// still computed and the authorization still runs BEFORE the comparison, so a
// caller who may not read this version gets its error, never a 304 that would
// confirm the content it holds is current.
router.get('/:id/versions/:version/content', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const version = await skillManager.getVersion(req.params.id, req.params.version, true, canManage(req));
    const etag = `"${version.content_sha256}"`;
    res.setHeader('ETag', etag);
    if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
      res.status(304).end();
      return;
    }
    res.json({ success: true, version });
  } catch (error) { sendSkillError(res, error, 'read full version'); }
});

/**
 * RFC 9110 §13.1.2, weak comparison. `*` matches any existing representation;
 * a list matches if any member equals the tag with its `W/` prefix ignored.
 */
function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return false;
  const candidates = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (candidates.includes('*')) return true;
  const strip = (value: string): string => (value.startsWith('W/') ? value.slice(2) : value);
  return candidates.some((candidate) => strip(candidate) === strip(etag));
}

router.get('/:id/versions/:version', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    res.json({ success: true, version: await skillManager.getVersion(
      req.params.id, req.params.version, false, canManage(req),
    ) });
  } catch (error) { sendSkillError(res, error, 'read version'); }
});

router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    res.json({ success: true, skill: await skillManager.getById(req.params.id, canManage(req)) });
  } catch (error) { sendSkillError(res, error, 'read'); }
});

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const invalid = validateVersionBody(req.body, true);
    if (invalid) { sendApiError(res, invalid.startsWith('Unknown') ? 400 : 422,
      invalid.startsWith('Unknown') ? 'UNKNOWN_FIELD' : 'INVALID_SKILL_VALUE', invalid); return; }
    const body = { ...req.body };
    if (body.provenance === undefined) body.provenance = req.principal?.kind === 'human' ? 'human-authored' : 'agent-drafted';
    const skill = await skillManager.create(body, actor(req));
    res.status(201).json({ success: true, skill });
  } catch (error) { sendSkillError(res, error, 'create'); }
});

router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const revision = readIfMatchRevision(req, res); if (revision === null) return;
    const invalid = validateVersionBody(req.body, false);
    if (invalid) { sendApiError(res, invalid.startsWith('Unknown') ? 400 : 422,
      invalid.startsWith('Unknown') ? 'UNKNOWN_FIELD' : 'INVALID_SKILL_VALUE', invalid); return; }
    const body = { ...req.body };
    if (body.provenance === undefined) body.provenance = req.principal?.kind === 'human' ? 'human-authored' : 'agent-drafted';
    const skill = await skillManager.update(req.params.id, body, revision, actor(req));
    res.status(201).json({ success: true, skill });
  } catch (error) { sendSkillError(res, error, 'create version'); }
});

function transitionRoute(status: SkillVersionStatus) {
  return async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (!checkQueryKeys(req, res, [])) return;
      const revision = readIfMatchRevision(req, res); if (revision === null) return;
      const invalid = validateNoteOnly(req.body);
      if (invalid) { sendApiError(res, invalid.startsWith('Unknown') ? 400 : 422,
        invalid.startsWith('Unknown') ? 'UNKNOWN_FIELD' : 'INVALID_SKILL_VALUE', invalid); return; }
      const version = await skillManager.transition(req.params.id, req.params.version, status,
        actor(req), req.body?.note, revision);
      res.json({ success: true, version });
    } catch (error) { sendSkillError(res, error, status); }
  };
}

router.post('/:id/versions/:version/submit-review', transitionRoute('review'));
router.post('/:id/versions/:version/reject', transitionRoute('draft'));
router.post('/:id/versions/:version/publish', transitionRoute('published'));
router.post('/:id/versions/:version/retire', transitionRoute('retired'));

router.patch('/:id/audience', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const revision = readIfMatchRevision(req, res); if (revision === null) return;
    if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.is_global !== 'boolean') {
      sendApiError(res, 422, 'INVALID_SKILL_VALUE', 'request body must contain only boolean is_global'); return;
    }
    res.json({ success: true, skill: await skillManager.setGlobal(req.params.id, req.body.is_global, revision) });
  } catch (error) { sendSkillError(res, error, 'audience'); }
});

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const revision = readIfMatchRevision(req, res); if (revision === null) return;
    if (Object.keys(req.body ?? {}).length) { sendApiError(res, 400, 'UNKNOWN_FIELD', 'DELETE takes no request body'); return; }
    await skillManager.delete(req.params.id, revision);
    res.json({ success: true, message: 'Skill catalog deleted' });
  } catch (error) { sendSkillError(res, error, 'delete'); }
});

export default router;
