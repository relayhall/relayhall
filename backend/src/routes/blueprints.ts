import { WarrantError } from '../services/WarrantService';
import { StepUpError } from '../services/StepUpService';
import { blueprintReferenceRegistry } from '../services/BlueprintReferenceRegistry';
import { BlueprintCaptureService } from '../services/BlueprintCaptureService';
import { BlueprintSetupService } from '../services/BlueprintSetupService';
import { GrantError } from '../services/GrantService';
import { AssignmentAccessError } from '../services/AccessVehicleService';
import { ProfileValidationError } from '../utils/executionProfile';
import { Router, Request, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { actorFromRequest } from '../middleware/sharedAuthorization';
import { auditActorFromRequest } from '../utils/auditActor';
import { isLoginSessionKind } from '../utils/administratorSession';
import { BlueprintError } from '../utils/blueprintDocument';
import { ResourceContractError } from '../services/ProjectResourceService';
import { jsonBodyOptions } from '../utils/jsonBodyTypes';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { BlueprintRegistryService } from '../services/BlueprintRegistryService';
import { BlueprintResolutionService } from '../services/BlueprintResolutionService';
import { BlueprintInstantiationService, BlueprintCreationCaller } from '../services/BlueprintInstantiationService';
import { BlueprintLedgerService } from '../services/BlueprintLedgerService';
import { getPluginRegistry } from './plugins';
import { requestActor } from './tasks';

export const blueprintRegistry = new BlueprintRegistryService(jsonBodyOptions);
const resolution = new BlueprintResolutionService(getPluginRegistry);
blueprintReferenceRegistry.usePlugins(getPluginRegistry);
const instantiation = new BlueprintInstantiationService(blueprintRegistry,(caller,target,client) => resolution.context(caller,target,client));
const ledger = new BlueprintLedgerService(blueprintRegistry);
const setup = new BlueprintSetupService();
const router = Router();
export const instantiationsRouter = Router();
function caller(req: Request): BlueprintCreationCaller {
  const request = req as AuthRequest; const actor = actorFromRequest(request);
  return { actor, audit: auditActorFromRequest(request), taskActor: requestActor(req),
    rootSession: isLoginSessionKind(request.authMethod) && !!actor.principalId && !!actor.scopes?.includes('root') };
}
function version(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new BlueprintError(422,'BLUEPRINT_VERSION_INVALID','Version must be a positive integer');
  return Number(value);
}
function keys(value: unknown, allowed: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new BlueprintError(422,'BLUEPRINT_INPUT_INVALID','Unexpected request field');
}
function handle(operation: (req: Request,res: Response) => Promise<void>) {
  return async (req: Request,res: Response): Promise<void> => {
    try { await operation(req,res); }
    catch (error) {
      if (error instanceof WarrantError || error instanceof StepUpError || error instanceof BlueprintError || error instanceof ResourceContractError || error instanceof GrantError || error instanceof AssignmentAccessError || error instanceof ProfileValidationError) { res.status(error.status).json({ success:false,code:error.code,error:error.message,...('field' in error && error.field ? {field:error.field} : {}) }); return; }
      const errorId = logCaughtFailure('[Blueprint API] operation failed',error);
      res.status(503).json({ success:false,code:'BLUEPRINT_OPERATION_UNAVAILABLE',error:'Blueprint operation is unavailable',errorId });
    }
  };
}
router.get('/',handle(async(req,res) => { keys(req.query,[]); res.json({success:true,blueprints:await blueprintRegistry.list(caller(req))}); }));
router.post('/',handle(async(req,res) => { res.status(201).json({success:true,blueprint:await blueprintRegistry.save(caller(req),req.body)}); }));
router.post('/capture',handle(async(req,res) => {
  keys(req.body,['phaseId','projectId','name','key']);
  res.status(201).json({success:true,blueprint:await new BlueprintCaptureService(blueprintRegistry).capture(caller(req),req.body)});
}));
router.post('/import',handle(async(req,res) => { keys(req.body,['document','rename']); if (req.body.rename !== undefined && typeof req.body.rename !== 'string') throw new BlueprintError(422,'BLUEPRINT_INPUT_INVALID','Rename must be text'); res.status(201).json({success:true,blueprint:await blueprintRegistry.importDocument(caller(req),req.body.document,req.body.rename)}); }));
router.get('/:id/versions',handle(async(req,res) => { keys(req.query,[]); res.json({success:true,versions:await blueprintRegistry.versions(req.params.id,caller(req))}); }));
router.post('/:id/versions',handle(async(req,res) => { res.status(201).json({success:true,blueprint:await blueprintRegistry.save(caller(req),req.body,req.params.id)}); }));
router.patch('/:id/versions/:n',handle(async(req,res) => { res.json({success:true,blueprint:await blueprintRegistry.save(caller(req),req.body,req.params.id,version(req.params.n))}); }));
for (const action of ['submit','withdraw','reject','publish','retire'] as const) {
  router.post(`/:id/versions/:n/${action}`,handle(async(req,res) => { keys(req.body ?? {},['note']); if (req.body?.note !== undefined && typeof req.body.note !== 'string') throw new BlueprintError(422,'BLUEPRINT_INPUT_INVALID','Note must be text'); res.json({success:true,blueprint:await blueprintRegistry.transition(req.params.id,version(req.params.n),action,caller(req),req.body?.note)}); }));
}
router.get('/:id/versions/:n/export',handle(async(req,res) => { const document=await blueprintRegistry.export(req.params.id,version(req.params.n),caller(req)); res.type('application/json').attachment('blueprint.json').send(document); }));
router.post('/:id/instantiations/preview',handle(async(req,res) => { res.json({success:true,...await instantiation.preview(req.params.id,req.body,caller(req))}); }));
router.post('/:id/instantiations',handle(async(req,res) => { const result=await instantiation.instantiate(req.params.id,req.body,req.get('Idempotency-Key'),caller(req)); res.status(result.status).json({success:true,...result}); }));
router.get('/:id/instantiations',handle(async(req,res) => { keys(req.query,[]); res.json({success:true,instantiations:await ledger.list(req.params.id,caller(req))}); }));
router.get('/:id',handle(async(req,res) => { keys(req.query,['version']); res.json({success:true,blueprint:await blueprintRegistry.get(req.params.id,caller(req),req.query.version === undefined ? undefined : version(req.query.version))}); }));
instantiationsRouter.get('/:id',handle(async(req,res) => { keys(req.query,[]); res.json({success:true,instantiation:await ledger.get(req.params.id,caller(req))}); }));
instantiationsRouter.post('/:id/setup/preview',handle(async(req,res) => { res.json({success:true,plan:await setup.preview(req.params.id,req.body,caller(req))}); }));
instantiationsRouter.post('/:id/setup',handle(async(req,res) => { const result=await setup.apply(req.params.id,req.body,req.get('Idempotency-Key'),caller(req)); res.status(result.status).json({success:true,...result}); }));
export default router;
