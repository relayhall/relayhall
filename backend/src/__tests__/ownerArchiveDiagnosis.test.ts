import {bulkArchiveFailure} from '../utils/bulkArchiveFailure';
import {ForbiddenFault,NotFoundFault} from '../utils/httpErrors';
import {LifecyclePolicyDeniedError} from '../services/LifecyclePolicyService';
import {AssignmentAccessError} from '../services/AccessVehicleService';
import {TaskManagerDB} from '../services/TaskManagerDB';
jest.mock('../db/connection',()=>({pool:{query:jest.fn(),connect:jest.fn()}}));
test.each([[new ForbiddenFault('SECRET'),'FORBIDDEN'],[new NotFoundFault('SECRET'),'NOT_FOUND'],[new LifecyclePolicyDeniedError('task.transition',{kind:'task',id:'SECRET'},[],[],'SECRET'),'LIFECYCLE_POLICY_DENIED'],[new AssignmentAccessError(409,'ASSIGNMENT_REFERENCE_BUSY','SECRET'),'ASSIGNMENT_REFERENCE_BUSY'],[{code:'PZ001',message:'SECRET'},'TASK_REVIEW_EVIDENCE_BUSY'],[new Error('SECRET'),'ERROR'],[{code:'FORBIDDEN'},'ERROR']])('safe typed classification',(err,code)=>{const r=bulkArchiveFailure(err);expect(r.code).toBe(code);expect(JSON.stringify(r)).not.toContain('SECRET');});
test('hostile getter and proxy use unknown envelope',()=>{const get=jest.fn();expect(bulkArchiveFailure(Object.defineProperty({},'code',{get})).code).toBe('ERROR');expect(get).not.toHaveBeenCalled();expect(bulkArchiveFailure(new Proxy({},{getPrototypeOf(){throw new Error('SECRET');}})).code).toBe('ERROR');});
test('real bulk/archive/update refuses and rolls back without mocking failing operations',async()=>{
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';const row={id,status:'completed',completed_at:'2026-01-01',archived_at:null};
 const query=jest.fn(async(sql:string,..._args:any[])=>({rows:sql.startsWith('SELECT status FROM tasks WHERE id')?[{status:'archived'}]:[row]}));const release=jest.fn();const m=new TaskManagerDB({connect:async()=>({query,release})} as any);
 jest.spyOn(m,'getTask').mockImplementation(async(key:string)=>key==='missing'?undefined:{id:key,status:key==='old'?'archived':key==='active'?'todo':'completed',archiveDisposition:'completed'} as any);jest.spyOn(m,'getAllTasks').mockResolvedValue([]);
 const actor={principalId:id,handle:'ordinary',role:'agent',authMethod:'session'} as any;
 const r=await m.bulkArchiveCompleted([id,'missing','old','active'],{},actor);
 expect(r.results.map(x=>x.code)).toEqual(['FORBIDDEN','NOT_FOUND','FORBIDDEN','NOT_COMPLETED']);expect(r.archivedCount).toBe(0);expect(r.failedCount).toBe(4);expect(r.results[0].errorId).toMatch(/^[0-9a-f-]{36}$/);
 expect(query.mock.calls.map(c=>c[0])).toContain('ROLLBACK');expect(query.mock.calls.map(c=>c[0])).not.toContain('COMMIT');expect(query.mock.calls.some(c=>String(c[0]).startsWith('UPDATE'))).toBe(false);
 expect((await m.bulkArchiveCompleted([id],{},actor)).archivedCount).toBe(0);expect(row.status).toBe('completed');expect(row.completed_at).toBe('2026-01-01');expect(release).toHaveBeenCalledTimes(3);
});

test('real archive/update lifecycle denial remains failed and rolls back',async()=>{
 const {lifecyclePolicyService}=jest.requireActual('../services/LifecyclePolicyService');
 const denial=new LifecyclePolicyDeniedError('task.transition',{kind:'task',id:'PRIVATE'},[],[],'SECRET');
 const policy=jest.spyOn(lifecyclePolicyService,'evaluate').mockRejectedValueOnce(denial);
 const query=jest.fn(async(..._args:any[])=>({rows:[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'completed',archived_at:null}]}));
 const m=new TaskManagerDB({connect:async()=>({query,release:jest.fn()})} as any);
 jest.spyOn(m,'getTask').mockResolvedValue({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'completed'} as any);jest.spyOn(m,'getAllTasks').mockResolvedValue([]);
 const logs=jest.spyOn(console,'error').mockImplementation(()=>{});
 try {
 const r=await m.bulkArchiveCompleted(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],{},{principalId:null,handle:'fixture-reviewer',role:'reviewer'} as any);
 expect(r.archivedCount).toBe(0);expect(r.results[0].code).toBe('LIFECYCLE_POLICY_DENIED');expect(policy).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({action:'task.transition'}));
 expect(logs.mock.calls.some(c=>String(c[0]).includes('id='+r.results[0].errorId))).toBe(true);expect(JSON.stringify(r)).not.toContain('SECRET');expect(query.mock.calls.map(c=>c[0])).toContain('ROLLBACK');
 } finally {policy.mockRestore();logs.mockRestore();}
});
