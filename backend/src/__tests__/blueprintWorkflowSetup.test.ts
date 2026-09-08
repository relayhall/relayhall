jest.mock('../db/connection',()=>({pool:{connect:jest.fn(),query:jest.fn()}}));
jest.mock('../services/BlueprintRegistryService',()=>({requireBlueprintScope:jest.fn()}));
jest.mock('../services/AuthorizationRepository',()=>({authorizationRepository:{listScope:jest.fn(()=>({from:'tasks t',render:()=>({sql:'TRUE',params:[]})})),authorizedIds:jest.fn(async(_a,_type,ids)=>new Set(ids))}}));
jest.mock('../utils/executionProfile',()=>({validateConnectorProfile:jest.fn(async value=>value)}));
jest.mock('../services/TaskManagerDB',()=>({taskManagerDB:{updateTask:jest.fn(async()=>({}))}}));
jest.mock('../services/AuditService',()=>({auditService:{record:jest.fn(async()=>undefined)}}));
import {pool} from '../db/connection';
import {BlueprintSetupService} from '../services/BlueprintSetupService';
import {taskManagerDB} from '../services/TaskManagerDB';
import {authorizationRepository} from '../services/AuthorizationRepository';
import {validateConnectorProfile} from '../utils/executionProfile';
import type {BlueprintCreationCaller} from '../services/BlueprintInstantiationService';
const id='11111111-2222-4333-8444-555555555555',project='22222222-2222-4333-8444-555555555555';
const taskId='33333333-2222-4333-8444-555555555555',serviceId='44444444-2222-4333-8444-555555555555';
const warrantId='55555555-2222-4333-8444-555555555555',principalId='66666666-2222-4333-8444-555555555555';
const actor={principalId,handle:'creator',role:'user',scopes:['blueprints:use','tasks:write','services:invoke'],authenticated:true};
const caller:BlueprintCreationCaller={actor,rootSession:false,audit:{principalId,handle:'creator',authMethod:'session'},taskActor:{principalId,handle:'creator',authorization:actor,authMethod:'session'}};
function fixture(){
 const profile={serviceId,descriptorVersion:2,options:{command:'Private resolved text'}};
 const task:any={id:taskId,instantiation_id:id,project_id:project,phase_id:null,title:'Inspect',status:'todo',auto_start:false,execution_service_id:null,owner_principal_id:null,setup_revision:'a'.repeat(32)};
 const instance:any={id,root_project_id:project,execution_defaults:[{taskId,projectId:project,phaseId:null,executionProfile:profile}]};
 const warrant:any={id:warrantId,status:'active',expires_at:null,holder_principal_id:principalId,ceiling_profile_version_id:'internal-profile-version'};
 const profileState:any={id:'profile',published_version_id:'published-version'};
 const anchors:any[]=[{anchor_type:'project',anchor_id:project}];let prior:any=null;
 const client={release:jest.fn(),query:jest.fn(async(sql:string,values:any[]=[]):Promise<any>=>{
  if(sql.includes('FROM blueprint_instantiations i'))return{rows:[instance]};
  if(sql.includes('md5(row_to_json(t)'))return{rows:[task]};
  if(sql.includes('JOIN access_profiles ap'))return{rows:[profileState]};
  if(sql.includes('FROM warrants'))return{rows:[warrant]};
  if(sql.includes('FROM warrant_anchors'))return{rows:anchors};
  if(sql.includes('FROM blueprint_setup_requests'))return{rows:prior?[prior]:[]};
  if(sql.includes('INSERT INTO blueprint_setup_requests'))prior={request_hash:values[3],response_snapshot:values[4]};
  return{rows:[]};
 })};(pool.connect as jest.Mock).mockResolvedValue(client);
 return{client,task,instance,warrant,anchors,profile,profileState,service:new BlueprintSetupService()};
}
beforeEach(()=>{jest.clearAllMocks();(taskManagerDB.updateTask as jest.Mock).mockResolvedValue({});(authorizationRepository.authorizedIds as jest.Mock).mockImplementation(async(_a,_type,ids)=>new Set(ids));});
async function confirmed(f:ReturnType<typeof fixture>){const plan=await f.service.preview(id,{warrantId},caller);return{warrantId,tasks:plan.tasks.map((t:any)=>({id:t.id,revision:t.revision})),confirmationHash:plan.confirmationHash};}
test('preview displays exact current Task versions and staged profiles but no foreign Warrant management fields',async()=>{
 const f=fixture();const plan=await f.service.preview(id,{warrantId},caller);
 expect(plan.tasks).toEqual([{id:taskId,revision:'a'.repeat(32),title:'Inspect',phaseId:null,executionProfile:f.profile}]);
 expect(plan).toMatchObject({warrantId,allParked:true,assignmentOnly:true});
 expect(JSON.stringify(plan)).not.toContain('holderPrincipalId');expect(JSON.stringify(plan)).not.toContain('internal-profile-version');
 expect(taskManagerDB.updateTask).not.toHaveBeenCalled();
 const sql=f.client.query.mock.calls.find(([sql])=>sql.includes('FROM blueprint_instantiations i'))![0];
 expect(sql).toContain('CASE WHEN i.actor_principal_id::text=$2 OR $3::boolean THEN i.execution_defaults ELSE NULL');
});
test('confirmed setup passes only canonical assignment fields and exact existing Warrant into one outer transaction',async()=>{
 const f=fixture();const input=await confirmed(f);f.client.query.mockClear();
 const result=await f.service.apply(id,input,'setup-key-long-enough',caller);
 expect(taskManagerDB.updateTask).toHaveBeenCalledWith(taskId,{executionProfile:f.profile,executionServiceId:serviceId,executionDescriptorVersion:2,executionWarrantId:warrantId},caller.taskActor,undefined,expect.objectContaining({client:f.client,actor:caller.taskActor}));
 expect(result).toMatchObject({taskIds:[taskId],assigned:true,armed:false});expect(JSON.stringify(result)).not.toContain('Private resolved text');
 expect(f.client.query.mock.calls.filter(([sql])=>sql.startsWith('BEGIN'))).toHaveLength(1);expect(f.client.query.mock.calls.at(-1)![0]).toBe('COMMIT');
});
test('setup replay returns original receipt after Warrant revocation without rematerializing authority',async()=>{
 const f=fixture();const input=await confirmed(f);const first=await f.service.apply(id,input,'setup-key-long-enough',caller);
 f.warrant.status='revoked';f.task.execution_service_id=serviceId;
 expect(await f.service.apply(id,input,'setup-key-long-enough',caller)).toEqual(first);expect(taskManagerDB.updateTask).toHaveBeenCalledTimes(1);
});
test('changed Task revision refuses before assignment',async()=>{
 const f=fixture();const input=await confirmed(f);f.task.setup_revision='b'.repeat(32);
 await expect(f.service.apply(id,input,'setup-key-long-enough',caller)).rejects.toMatchObject({code:'BLUEPRINT_SETUP_CHANGED'});
 expect(taskManagerDB.updateTask).not.toHaveBeenCalled();expect(f.client.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
});
test('a copied setup key with different selected Warrant is refused',async()=>{
 const f=fixture();const input=await confirmed(f);await f.service.apply(id,input,'setup-key-long-enough',caller);
 await expect(f.service.apply(id,{...input,warrantId:project},'setup-key-long-enough',caller)).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
 expect(taskManagerDB.updateTask).toHaveBeenCalledTimes(1);
});
test('canonical assignment failure aborts setup before recording a success receipt',async()=>{
 const f=fixture();const input=await confirmed(f);(taskManagerDB.updateTask as jest.Mock).mockRejectedValueOnce(new Error('canonical holder refusal'));
 await expect(f.service.apply(id,input,'setup-key-long-enough',caller)).rejects.toThrow('canonical holder refusal');
 expect(f.client.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');expect(f.client.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO blueprint_setup_requests'))).toBe(false);
});
test('lost invoke authority refuses before descriptor lookup or canonical assignment',async()=>{
 const f=fixture();(authorizationRepository.authorizedIds as jest.Mock).mockImplementation(async(_a,type,ids)=>new Set(type==='service'?[]:ids));
 await expect(f.service.preview(id,{warrantId},caller)).rejects.toMatchObject({code:'BLUEPRINT_AUTHORITY_REQUIRED'});
 expect(validateConnectorProfile).not.toHaveBeenCalled();expect(taskManagerDB.updateTask).not.toHaveBeenCalled();
});
test.each(['auto_start','owner_principal_id','execution_service_id'])('setup never silently changes a Task with %s',async field=>{
 const f=fixture();f.task[field]=field==='auto_start'?true:principalId;
 await expect(f.service.preview(id,{warrantId},caller)).rejects.toMatchObject({code:'BLUEPRINT_SETUP_CHANGED'});expect(taskManagerDB.updateTask).not.toHaveBeenCalled();
});
test('a Task-only Warrant cannot replace the approved Phase/Project grouped anchor',async()=>{
 const f=fixture();f.anchors.splice(0,1,{anchor_type:'task',anchor_id:taskId});
 await expect(f.service.preview(id,{warrantId},caller)).rejects.toMatchObject({code:'BLUEPRINT_SETUP_WARRANT_UNAVAILABLE'});
});
test('private default projection null is concealed and does not reach task lookup',async()=>{
 const f=fixture();f.instance.execution_defaults=null;
 await expect(f.service.preview(id,{warrantId},caller)).rejects.toMatchObject({status:404,code:'BLUEPRINT_SETUP_NOT_FOUND'});
 expect(f.client.query.mock.calls.some(([sql])=>sql.includes('md5(row_to_json(t)'))).toBe(false);
});

test.each(['project_id','phase_id','instantiation_id'])('changed %s membership refuses before assignment',async field=>{
 const f=fixture();const input=await confirmed(f);f.task[field]=principalId;(validateConnectorProfile as jest.Mock).mockClear();
 await expect(f.service.apply(id,input,'setup-key-long-enough',caller)).rejects.toMatchObject({code:'BLUEPRINT_SETUP_CHANGED'});
 expect(validateConnectorProfile).not.toHaveBeenCalled();expect(taskManagerDB.updateTask).not.toHaveBeenCalled();
});
test('a changed Warrant ceiling invalidates the displayed confirmation',async()=>{
 const f=fixture();const input=await confirmed(f);f.warrant.ceiling_profile_version_id='changed-ceiling';
 await expect(f.service.apply(id,input,'setup-key-long-enough',caller)).rejects.toMatchObject({code:'BLUEPRINT_SETUP_CHANGED'});
 expect(taskManagerDB.updateTask).not.toHaveBeenCalled();
});

test('publishing a changed live profile requires a fresh setup confirmation',async()=>{
 const f=fixture();const input=await confirmed(f);f.profileState.published_version_id='new-published-version';
 await expect(f.service.apply(id,input,'setup-key-long-enough',caller)).rejects.toMatchObject({code:'BLUEPRINT_SETUP_CHANGED'});
 expect(taskManagerDB.updateTask).not.toHaveBeenCalled();
});
