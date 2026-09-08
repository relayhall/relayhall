/** Authenticated Appearance surface. Reads are authenticated; writes and
 * historical bytes additionally require the root/owner sentinel. */
import { logCaughtFailure } from '../utils/secretSafeLog';
import { Router, Response } from 'express';
import Busboy from 'busboy';
import { AuthRequest } from '../middleware/auth';
import {
  appearanceService,
  AppearanceValidationError,
  AssetRejected,
  isAssetKind,
} from '../services/AppearanceService';
import { resolveIssuerAuthority } from '../utils/credentialAuthority';
import { resolveActorRole } from '../utils/taskAutomationRole';

const router = Router();
const MAX_UPLOAD_BYTES = 512 * 1024;

function requireRoot(req: AuthRequest, res: Response): boolean {
  const authority = resolveIssuerAuthority({
    scopes: req.scopes,
    role: resolveActorRole({
      handle: req.userId || '',
      principalRole: req.principal?.role ?? null,
      sessionRole: req.sessionRole ?? null,
    }),
  });
  if (!authority.canManage) {
    res.status(403).json({ error: 'Forbidden', message: authority.reason || 'Root authority is required' });
    return false;
  }
  return true;
}

function actorId(req: AuthRequest): string | null {
  return req.principal?.id ?? null;
}

function logFailure(operation: string, error: unknown): string {
  // The secret-safe sink derives the bounded category itself and returns
  // the correlating id for the caller-visible envelope (review 3db17273 r2).
  return logCaughtFailure(`[Appearance Admin] ${operation} failed:`, error);
}

function respondFailure(res: Response, operation: string, error: unknown): void {
  if (error instanceof AppearanceValidationError) {
    const status = error.code === 'VERSION_NOT_FOUND' ? 404 : 400;
    res.status(status).json({ error: status === 404 ? 'Not Found' : 'Bad Request', code: error.code, message: error.message });
    return;
  }
  if (error instanceof AssetRejected) {
    res.status(400).json({ error: 'Bad Request', code: error.reason, message: error.message });
    return;
  }
  const errorId = logFailure(operation, error);
  res.status(500).json({ error: 'Internal Server Error', code: 'APPEARANCE_ADMIN_FAILED', message: `Failed to ${operation} appearance`, errorId });
}

router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await appearanceService.get() });
  } catch (error) {
    respondFailure(res, 'read', error);
  }
});

router.get('/info', async (_req: AuthRequest, res: Response) => {
  // Set at route entry so success and every failure envelope are equally
  // non-cacheable; authenticated deployment information must never go stale.
  res.setHeader('Cache-Control', 'no-store');
  try {
    const appearance = await appearanceService.get();
    res.json({
      success: true,
      data: {
        displayName: appearance.overrides.displayName,
        description: appearance.effective.description,
        links: appearance.effective.links,
        teamMarkdown: appearance.effective.teamMarkdown,
      },
    });
  } catch (error) {
    respondFailure(res, 'read deployment information', error);
  }
});

router.put('/', async (req: AuthRequest, res: Response) => {
  if (!requireRoot(req, res)) return;
  try {
    res.json({ success: true, data: await appearanceService.save(req.body, actorId(req)) });
  } catch (error) {
    respondFailure(res, 'save', error);
  }
});

router.post('/reset', async (req: AuthRequest, res: Response) => {
  if (!requireRoot(req, res)) return;
  try {
    res.json({ success: true, data: await appearanceService.reset(actorId(req)) });
  } catch (error) {
    respondFailure(res, 'reset', error);
  }
});

router.get('/versions', async (req: AuthRequest, res: Response) => {
  if (!requireRoot(req, res)) return;
  try {
    const requested = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await appearanceService.listVersions(requested) });
  } catch (error) {
    respondFailure(res, 'list versions for', error);
  }
});

router.post('/versions/:versionNo/revert', async (req: AuthRequest, res: Response) => {
  if (!requireRoot(req, res)) return;
  try {
    const versionNo = Number(req.params.versionNo);
    res.json({ success: true, data: await appearanceService.revert(versionNo, actorId(req)) });
  } catch (error) {
    respondFailure(res, 'revert', error);
  }
});

router.post('/assets/:kind', (req: AuthRequest, res: Response) => {
  if (!requireRoot(req, res)) return;
  const kind = String(req.params.kind);
  if (!isAssetKind(kind)) {
    res.status(404).json({ error: 'Not Found', message: 'No such asset kind' });
    return;
  }
  if (!/^multipart\/form-data(?:;|$)/i.test(String(req.headers['content-type'] || ''))) {
    res.status(415).json({ error: 'Unsupported Media Type', code: 'MULTIPART_REQUIRED', message: 'Use multipart/form-data with one file field named asset' });
    return;
  }

  let parser: Busboy.Busboy;
  try {
    parser = Busboy({ headers: req.headers, limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_UPLOAD_BYTES } });
  } catch {
    res.status(400).json({ error: 'Bad Request', code: 'MALFORMED_MULTIPART', message: 'Malformed multipart upload' });
    return;
  }

  let fileSeen = false;
  let fileTooLarge = false;
  let invalidField = false;
  const chunks: Buffer[] = [];
  let completed = false;

  parser.on('file', (fieldName, stream) => {
    if (fieldName !== 'asset' || fileSeen) {
      invalidField = true;
      stream.resume();
      return;
    }
    fileSeen = true;
    stream.on('limit', () => { fileTooLarge = true; });
    stream.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  });
  parser.on('field', () => { invalidField = true; });
  parser.on('filesLimit', () => { invalidField = true; });
  parser.on('fieldsLimit', () => { invalidField = true; });
  parser.on('partsLimit', () => { invalidField = true; });
  parser.on('error', () => {
    if (completed) return;
    completed = true;
    res.status(400).json({ error: 'Bad Request', code: 'MALFORMED_MULTIPART', message: 'Malformed multipart upload' });
  });
  parser.on('close', async () => {
    if (completed) return;
    completed = true;
    if (fileTooLarge) {
      res.status(413).json({ error: 'Payload Too Large', code: 'FILE_TOO_LARGE', message: 'Appearance assets must be 512 KB or smaller' });
      return;
    }
    if (invalidField || !fileSeen) {
      res.status(400).json({ error: 'Bad Request', code: 'ONE_FILE_REQUIRED', message: 'Upload exactly one file field named asset and no other fields' });
      return;
    }
    try {
      const asset = await appearanceService.putAsset(kind, Buffer.concat(chunks), actorId(req));
      res.status(201).json({
        success: true,
        data: {
          id: asset.id, kind: asset.kind, mime: asset.mime, width: asset.width,
          height: asset.height, byteSize: asset.byteSize, sha256: asset.sha256,
          url: `/api/appearance/assets/${asset.kind}/${asset.sha256}`,
        },
      });
    } catch (error) {
      respondFailure(res, 'upload asset for', error);
    }
  });
  req.pipe(parser);
});

router.get('/asset-history/:kind', async (req: AuthRequest, res: Response) => {
  if (!requireRoot(req, res)) return;
  const kind = String(req.params.kind);
  if (!isAssetKind(kind)) {
    res.status(404).json({ error: 'Not Found', message: 'No such asset kind' });
    return;
  }
  try {
    const assets = await appearanceService.listAssetHistoryForRoot(kind);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: assets.map((asset) => ({
        id: asset.id, kind: asset.kind, mime: asset.mime, width: asset.width,
        height: asset.height, byteSize: asset.byteSize, sha256: asset.sha256,
        active: asset.active, uploadedBy: asset.uploadedBy, createdAt: asset.createdAt,
      })),
    });
  } catch (error) {
    respondFailure(res, 'list asset history for', error);
  }
});

router.get('/asset-versions/:id', async (req: AuthRequest, res: Response) => {
  if (!requireRoot(req, res)) return;
  try {
    const asset = await appearanceService.getAssetByIdForRoot(req.params.id);
    if (!asset) {
      res.status(404).json({ error: 'Not Found', message: 'Appearance asset was not found' });
      return;
    }
    res.setHeader('Content-Type', asset.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(asset.byteSize));
    res.send(asset.bytes);
  } catch (error) {
    respondFailure(res, 'read historical asset for', error);
  }
});

export default router;
