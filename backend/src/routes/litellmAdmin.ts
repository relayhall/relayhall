import { Request, Response, Router } from 'express';
import {
  CreateLiteLLMModelInput,
  GenerateLiteLLMKeyInput,
  LiteLLMAdminError,
  liteLLMAdminService,
} from '../services/LiteLLMAdminService';
import { logCaughtFailure } from '../utils/secretSafeLog';

const router = Router();

function sendError(res: Response, error: unknown): void {
  if (error instanceof LiteLLMAdminError) {
    res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    return;
  }
  const errorId = logCaughtFailure('[LiteLLM Admin API] Unexpected error:', error);
  res.status(500).json({ success: false, error: 'Unexpected LiteLLM administration error', code: 'LITELLM_ADMIN_FAILED', errorId });
}

router.get('/models', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await liteLLMAdminService.listModels();
    res.json({ success: true, ...result });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/models', async (req: Request, res: Response): Promise<void> => {
  try {
    const input = req.body as CreateLiteLLMModelInput;
    const model = await liteLLMAdminService.createModel(input);
    res.status(201).json({ success: true, model });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/models/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await liteLLMAdminService.deleteModel(req.params.id);
    res.json({ success: true, result });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/keys', async (_req: Request, res: Response): Promise<void> => {
  try {
    const keys = await liteLLMAdminService.listKeys();
    res.json({ success: true, keys });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/keys', async (req: Request, res: Response): Promise<void> => {
  try {
    const key = await liteLLMAdminService.generateKey(req.body as GenerateLiteLLMKeyInput);
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, key });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/keys/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await liteLLMAdminService.deleteKey(req.params.id);
    res.json({ success: true, result });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/spend', async (req: Request, res: Response): Promise<void> => {
  try {
    const summary = await liteLLMAdminService.getSpendSummary({
      startDate: typeof req.query.startDate === 'string' ? req.query.startDate : undefined,
      endDate: typeof req.query.endDate === 'string' ? req.query.endDate : undefined,
    });
    res.json({ success: true, ...summary });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/health', async (_req: Request, res: Response): Promise<void> => {
  try {
    const health = await liteLLMAdminService.getModelHealth();
    res.json({ success: true, ...health });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
