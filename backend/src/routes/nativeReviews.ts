import { Router, Request, Response } from 'express';
import { nativeReviewService } from '../services/NativeReviewService';
import { requestActor } from './tasks';
import { RequestFaultError } from '../utils/httpErrors';
import { logCaughtFailure } from '../utils/secretSafeLog';

export const nativeTaskReviewsRouter=Router();
export const nativeServiceReviewsRouter=Router();
function handle(operation:(req:Request)=>Promise<unknown>) {
  return async (req:Request,res:Response):Promise<void> => {
    try { res.setHeader('Cache-Control','private, no-store'); res.json({success:true,result:await operation(req)}); }
    catch(error) {
      if(error instanceof RequestFaultError) { res.status(error.status).json({success:false,code:error.code,error:error.message}); return; }
      if(error && typeof error==='object' && 'code' in error && ['PZ001','55P03','23505'].includes(String(error.code))) {
        res.status(409).json({success:false,code:'NATIVE_REVIEW_CONFLICT',error:'Review evidence or request is busy'}); return;
      }
      const errorId=logCaughtFailure('[Native review] operation failed',error);
      res.status(503).json({success:false,code:'NATIVE_REVIEW_UNAVAILABLE',errorId});
    }
  };
}
nativeTaskReviewsRouter.get('/:id/native-reviews/inputs',handle(req=>nativeReviewService.inputs(req.params.id,requestActor(req))));
nativeTaskReviewsRouter.get('/:id/native-reviews/capabilities',handle(req=>nativeReviewService.capabilities(req.params.id,requestActor(req))));
nativeTaskReviewsRouter.get('/:id/native-reviews',handle(req=>nativeReviewService.list(req.params.id,requestActor(req))));
nativeTaskReviewsRouter.post('/:id/native-reviews',handle(req=>nativeReviewService.request(req.params.id,req.body,requestActor(req))));
nativeTaskReviewsRouter.post('/:id/native-reviews/:reviewId/reconcile',handle(req=>nativeReviewService.reconcile(req.params.id,req.params.reviewId,req.body,requestActor(req))));
nativeTaskReviewsRouter.post('/:id/native-reviews/:reviewId/cancel',handle(req=>nativeReviewService.cancel(req.params.id,req.params.reviewId,req.body,requestActor(req))));
for(const action of ['lease','attest','verdict','uncertain'] as const) {
  nativeTaskReviewsRouter.post(`/:id/native-reviews/:reviewId/${action}`,handle(req=>nativeReviewService.act(req.params.id,req.params.reviewId,action,req.body,requestActor(req))));
}
nativeServiceReviewsRouter.get('/:id/review-requests',handle(req=>nativeReviewService.pull(req.params.id,requestActor(req))));
