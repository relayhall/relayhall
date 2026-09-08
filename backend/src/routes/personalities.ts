import { logCaughtFailure } from '../utils/secretSafeLog';
import { ConflictFault } from '../utils/httpErrors';
// personalities.ts - REST API for Personalities
import { Router, Response } from 'express';
import { personalityService } from '../services/PersonalityService';
import { AuthRequest } from '../middleware/auth';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { resolveIssuerAuthority } from '../utils/credentialAuthority';
import { filterAuthorizedResources } from '../middleware/sharedAuthorization';

const router = Router();

function requireManageAuthority(req: AuthRequest, res: Response): boolean {
  const authority = resolveIssuerAuthority({
    scopes: req.scopes,
    role: resolveActorRole({
      handle: req.userId || '',
      principalRole: req.principal?.role ?? null,
      sessionRole: req.sessionRole ?? null,
    }),
  });
  if (!authority.canManage) {
    res.status(403).json({ success: false, error: 'Forbidden', message: authority.reason || 'Not permitted' });
    return false;
  }
  return true;
}

/**
 * GET /personalities — list live personalities.
 *   ?category=<cat>       filter by category
 *   ?includeRetired=true  also include soft-deleted (retired duplicate) rows
 *
 * Each row carries provenance (`built-in`, `managed`, `git`, or `legacy-db`) and
 * a nullable `retired_at` timestamp.
 * Retired rows are excluded by default so integrity tooling (`relayhall doctor`)
 * sees exactly one live personality per name/slug.
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const category = req.query.category as string | undefined;
    const includeRetired = req.query.includeRetired === 'true' || req.query.includeRetired === '1';
    const listedTypes = await personalityService.list(category, includeRetired);
    const types = await filterAuthorizedResources(
      req,
      'read',
      listedTypes,
      (personality) => ({ type: 'personality', id: personality.id }),
    );
    // Derive categories only from rows the caller may see; a global category
    // query would leak the existence of private Personalities.
    const categories = [...new Set(types.map((personality) => personality.category).filter(Boolean))].sort();
    res.json({ success: true, personalities: types, categories });
  } catch (err) {
    const errorId = logCaughtFailure('[personalities] list error:', err);
    res.status(500).json({ success: false, code: 'PERSONALITIES_READ_FAILED', error: 'Failed to fetch personalities', errorId });
  }
});

/** GET /personalities/:id — full detail including content */
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    // Support lookup by UUID or slug
    const isUUID = /^[0-9a-f-]{36}$/.test(id);
    const type = isUUID
      ? await personalityService.getById(id)
      : await personalityService.getBySlug(id);

    if (!type) {
      res.status(404).json({ success: false, error: 'Personality not found' });
      return;
    }

    const [sessions, tasks] = await Promise.all([
      personalityService.getLinkedSessions(type.id),
      personalityService.getLinkedTasks(type.id),
    ]);

    res.json({ success: true, personality: type, linkedSessions: sessions, linkedTasks: tasks });
  } catch (err) {
    const errorId = logCaughtFailure('[personalities] get error:', err);
    res.status(500).json({ success: false, code: 'PERSONALITY_READ_FAILED', error: 'Failed to fetch personality', errorId });
  }
});

// POST /personalities/sync (the optional local-repository import) was removed
// 2026-08-09 by owner ruling: personalities are board-native — built-in seeds plus
// managed rows created over REST/CLI/MCP/GUI. External collections are imported
// by an agent reviewing them and creating managed rows through those surfaces.
// A stray call to the old path now matches the /personalities family scope
// rule (personalities:write) and answers 404 — no handler exists.

/** POST /personalities — create a board-managed personality. */
router.post('/', async (req: AuthRequest, res: Response) => {
  if (!requireManageAuthority(req, res)) return;
  const slug = typeof req.body?.slug === 'string' ? req.body.slug.trim().toLowerCase() : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !name) {
    res.status(400).json({ success: false, error: 'A name and kebab-case slug are required' });
    return;
  }
  try {
    const created = await personalityService.create({
      slug,
      name,
      description: typeof req.body?.description === 'string' ? req.body.description.trim() : null,
      category: typeof req.body?.category === 'string' ? req.body.category.trim() || null : null,
      color: typeof req.body?.color === 'string' ? req.body.color.trim() || null : null,
      content: typeof req.body?.content === 'string' ? req.body.content : null,
    });
    if (!created) {
      res.status(409).json({ success: false, error: 'A personality with that slug already exists' });
      return;
    }
    res.status(201).json({ success: true, personality: created });
  } catch (err) {
    const errorId = logCaughtFailure('[personalities] create error:', err);
    res.status(500).json({ success: false, code: 'PERSONALITY_CREATE_FAILED', error: 'Failed to create personality', errorId });
  }
});

/** PATCH /personalities/:id — update a board-managed personality. */
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  if (!requireManageAuthority(req, res)) return;
  try {
    const existing = await personalityService.getById(req.params.id);
    if (!existing || existing.retired_at) {
      res.status(404).json({ success: false, error: 'Active personality not found' });
      return;
    }
    if (existing.source !== 'managed') {
      res.status(409).json({ success: false, error: 'Built-in and imported personalities are read-only; create a managed personality instead' });
      return;
    }
    if (req.body?.name !== undefined && (typeof req.body.name !== 'string' || !req.body.name.trim())) {
      res.status(400).json({ success: false, error: 'Personality name cannot be empty' });
      return;
    }
    const updated = await personalityService.update(req.params.id, {
      name: typeof req.body?.name === 'string' ? req.body.name.trim() : undefined,
      description: typeof req.body?.description === 'string' ? req.body.description.trim() : undefined,
      category: typeof req.body?.category === 'string' ? req.body.category.trim() || null : undefined,
      color: typeof req.body?.color === 'string' ? req.body.color.trim() || null : undefined,
      content: typeof req.body?.content === 'string' ? req.body.content : undefined,
    });
    if (!updated) {
      res.status(404).json({ success: false, error: 'Active personality not found' });
      return;
    }
    res.json({ success: true, personality: updated });
  } catch (err) {
    const errorId = logCaughtFailure('[personalities] update error:', err);
    res.status(500).json({ success: false, code: 'PERSONALITY_UPDATE_FAILED', error: 'Failed to update personality', errorId });
  }
});

/** DELETE /personalities/:id — soft-retire a personality; history remains intact. */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  if (!requireManageAuthority(req, res)) return;
  try {
    const retired = await personalityService.retire(
      req.params.id,
      typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined,
    );
    if (!retired) {
      res.status(404).json({ success: false, error: 'Active personality not found' });
      return;
    }
    res.json({ success: true, personality: retired });
  } catch (err) {
    if (err instanceof ConflictFault) {
      res.status(err.status).json({ success: false, code: err.code, error: err.message });
      return;
    }
    const errorId = logCaughtFailure('[Personalities API] Error retiring personality:', err);
    res.status(500).json({ success: false, code: 'PERSONALITY_RETIRE_FAILED', error: 'The personality could not be retired', errorId });
  }
});

export default router;
