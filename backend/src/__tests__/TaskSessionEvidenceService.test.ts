import {TaskReviewerService} from '../services/TaskReviewerService';
import type {Task} from '../services/TaskManagerDB';
import {buildCanonicalReviewSlice} from '../services/TaskReviewAttemptService';

test('reviewer ignores forged retired Task JSON and carries only record-derived evidence',async()=>{
  const task={id:'fixture',title:'Fixture',status:'review',subtasks:[],successCriteria:['tests pass'],
    attemptCount:0,maxRetries:3,updated:'2026-10-13T00:00:00Z',
    sessionRefs:['forged'],completedBy:{sessionKey:'forged'}} as unknown as Task;
  const evidence={sessionRefs:['record-derived'],completedBy:{sessionKey:'record-derived',harness:'openclaw' as const}};
  const deps={getTask:jest.fn(async()=>task),updateTask:jest.fn(),notifyEscalation:jest.fn(),
    getExecutionEvidence:jest.fn(async()=>evidence),getReportsForTask:jest.fn(async()=>[{id:'proof',title:'Proof',summary:'2 tests passed',content:'2 tests passed'}])};
  const result=await new TaskReviewerService(deps).runReview(task.id,{dryRun:true});
  expect(result.decision).toBe('pass');
  expect(result.evidence).toMatchObject(evidence);
  expect(JSON.stringify(result.evidence)).not.toContain('forged');
  expect(deps.getExecutionEvidence).toHaveBeenCalledWith(task.id);
  expect(deps.updateTask).not.toHaveBeenCalled();
  deps.getExecutionEvidence.mockRejectedValueOnce(new Error('session evidence unavailable'));
  await expect(new TaskReviewerService(deps).runReview(task.id,{dryRun:true})).rejects.toThrow('session evidence unavailable');
  expect(deps.updateTask).not.toHaveBeenCalled();
});

test('review-slice fallback uses supplied canonical evidence instead of retired Task fields',()=>{
  const task={id:'fixture',updated:'2026-10-13T00:00:00Z',
    subtasks:[{id:'subtask',text:'Verify',status:'review'}],
    sessionRefs:['forged'],completedBy:{sessionKey:'forged'},notes:'ordinary note'} as unknown as Task;
  const slice=(buildCanonicalReviewSlice as any)(task,undefined,{sessionRefs:['record-derived'],completedBy:null});
  expect(slice[0].evidenceReceipt).toBe('record-derived');
  expect(JSON.stringify(slice)).not.toContain('forged');
});
