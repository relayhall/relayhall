import {Router,Request,Response} from 'express';
import {nativeExecutionService,NativeExecutionAction} from '../services/NativeExecutionService';
import {requestActor} from './tasks';
import {RequestFaultError} from '../utils/httpErrors';
import {logCaughtFailure} from '../utils/secretSafeLog';

export const nativeExecutionsRouter=Router();
function handle(operation:(req:Request)=>Promise<unknown>) {
  return async(req:Request,res:Response):Promise<void>=>{
    res.setHeader('Cache-Control','private, no-store');
    try {res.json({success:true,result:await operation(req)});}
    catch(error) {
      if(error instanceof RequestFaultError) {res.status(error.status).json({success:false,code:error.code,error:error.message});return;}
      if(error && typeof error==='object' && 'code' in error && ['PZ001','55P03','23505','40P01','40001'].includes(String(error.code))) {
        res.status(409).json({success:false,code:'NATIVE_EXECUTION_CONFLICT',error:'Execution or assignment is busy'});return;
      }
      const errorId=logCaughtFailure('[Native execution] operation failed',error);
      res.status(503).json({success:false,code:'NATIVE_EXECUTION_UNAVAILABLE',errorId});
    }
  };
}
nativeExecutionsRouter.get('/:id/native-executions',handle(req=>nativeExecutionService.list(req.params.id,requestActor(req))));
nativeExecutionsRouter.post('/:id/native-executions',handle(req=>nativeExecutionService.open(req.params.id,req.body,requestActor(req))));
for(const action of ['authorize-launch','heartbeat','attest','close','cancel','reconcile'] as NativeExecutionAction[]) {
  nativeExecutionsRouter.post(`/:id/native-executions/:executionId/${action}`,handle(req=>nativeExecutionService.act(req.params.id,req.params.executionId,action,req.body,requestActor(req))));
}

// No generic idempotency response cache: a consume replay is evidence only.
nativeExecutionsRouter.post('/:id/native-executions/generations',handle(req=>nativeExecutionService.reserveGeneration(req.params.id,req.body,requestActor(req))));
nativeExecutionsRouter.get('/:id/native-executions/generations/:generationId',handle(req=>nativeExecutionService.readGeneration(req.params.id,req.params.generationId,requestActor(req))));
nativeExecutionsRouter.post('/:id/native-executions/generations/:generationId/consume',handle(req=>nativeExecutionService.consumeGeneration(req.params.id,req.params.generationId,req.body,requestActor(req))));
nativeExecutionsRouter.post('/:id/native-executions/generations/:generationId/publication-intent',handle(req=>nativeExecutionService.publishGenerationIntent(req.params.id,req.params.generationId,req.body,requestActor(req))));
nativeExecutionsRouter.post('/:id/native-executions/quarantine/dry-run',handle(req=>nativeExecutionService.quarantineImport(req.params.id,req.body,requestActor(req),true)));
nativeExecutionsRouter.post('/:id/native-executions/quarantine',handle(req=>nativeExecutionService.quarantineImport(req.params.id,req.body,requestActor(req),false)));
nativeExecutionsRouter.get('/:id/native-executions/quarantine/:quarantineId',handle(req=>nativeExecutionService.readQuarantine(req.params.id,req.params.quarantineId,requestActor(req))));
