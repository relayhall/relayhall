import { Pool } from 'pg';
import { TaskElementService } from '../services/TaskElementService';
const TASK='22222222-2222-4222-8222-222222222222';
const OWNER='33333333-3333-4333-8333-333333333333';
const REPORT='44444444-4444-4444-8444-444444444444';
function fixture(role=OWNER,status='in-progress',updated=true) {
 const statements:string[]=[];
 const client={query:jest.fn(async(sql:string,_params?:any[])=>{
  statements.push(sql);
  if(sql.includes('FROM tasks t')) return {rows:[{id:TASK,title:'work',status,claimant_principal_id:role,verifier_principal_id:null,masking_enabled:false}]};
  if(sql.includes('INSERT INTO reports')) return {rows:[{id:REPORT}]};
  if(sql.includes('UPDATE reports SET title')) return {rows:updated?[{id:REPORT}]:[]};
  if(sql.includes('SELECT * FROM reports')) return {rows:[{id:REPORT,source_task_id:TASK,author_principal_id:OWNER}]};
  return {rows:[]};
 }),release:jest.fn()};
 const service=new TaskElementService({connect:async()=>client} as unknown as Pool);
 // Only linkage's already independently covered AccessVehicle SQL is isolated here.
 jest.spyOn(service as any,'linkReport').mockResolvedValue(undefined);
 return {service,client,statements};
}
const input={reportId:REPORT,title:'Progress',content:'Evidence',expectedContentHash:'a'.repeat(64)};
const actor={principalId:OWNER,handle:'worker'} as any;
test('current claimant edits with exact source/author/hash predicates in one transaction',async()=>{
 const f=fixture();const result=await f.service.saveTaskReport(TASK,input,actor);
 expect(result.report.id).toBe(REPORT);expect(f.statements).toContain('COMMIT');
 const sql=f.statements.find(s=>s.includes('UPDATE reports SET title'))!;
 expect(sql).toContain('source_task_id=$2');expect(sql).toContain('author_principal_id=$7');expect(sql).toContain('content_hash=$8');
 expect((f.service as any).linkReport).toHaveBeenCalledWith(f.client,expect.anything(),REPORT,actor);
});
test.each(['someone-else',null])('release/reassignment %s refuses before Report writes',async role=>{
 const f=fixture(role as any);await expect(f.service.saveTaskReport(TASK,input,actor)).rejects.toMatchObject({code:'TASK_CLAIMANT_REQUIRED'});
 expect(f.statements.some(s=>s.includes('UPDATE reports'))).toBe(false);expect(f.statements).toContain('ROLLBACK');
});
test.each(['review','completed','todo'])('handoff state %s freezes progress Report',async status=>{
 const f=fixture(OWNER,status);await expect(f.service.saveTaskReport(TASK,input,actor)).rejects.toMatchObject({code:'TASK_REPORT_FROZEN'});
 expect(f.statements.some(s=>s.includes('UPDATE reports'))).toBe(false);
});
test('foreign author or stale CAS refuses without linking',async()=>{
 const f=fixture(OWNER,'in-progress',false);await expect(f.service.saveTaskReport(TASK,input,actor)).rejects.toMatchObject({code:'TASK_REPORT_CONFLICT'});
 expect((f.service as any).linkReport).not.toHaveBeenCalled();expect(f.statements).toContain('ROLLBACK');
});
test('caller-supplied source or author cannot become an authority claim',async()=>{
 const f=fixture();await expect(f.service.saveTaskReport(TASK,{...input,sourceTaskId:TASK} as any,actor)).rejects.toMatchObject({code:'INVALID_TASK_REPORT'});
 expect(f.client.query).not.toHaveBeenCalled();
});

import { authorizationService } from '../services/AuthorizationService';
const reader={principalId:OWNER,handle:'worker',role:'member',scopes:['reports:read','reports:write'],authenticated:true,delegation:null} as any;
test('Task Report reader vehicle grants read only, no edit authority',()=>{
 const resource={type:'report',id:REPORT,ownerPrincipalId:'foreign',visibility:'private',taskEvidenceReaders:[OWNER]} as any;
 expect(authorizationService.authorizeResource(reader,'read',resource).allowed).toBe(true);
 expect(authorizationService.authorizeResource(reader,'write',resource).allowed).toBe(false);
 expect(authorizationService.authorizeResource(reader,'read',{...resource,taskEvidenceReaders:[]} as any).allowed).toBe(false);
});

import { toolByName } from '../mcp/registry';
import { authorizationRepository } from '../services/AuthorizationRepository';
test('reserved workflow access requires server origin, source Task and real Reference',()=>{
 const shape=authorizationRepository.sqlResource('report');
 expect(shape.from).toContain("r.origin='task-report'");
 expect(shape.from).toContain('evidence_ref.target_id=r.id');
 expect(shape.from).toContain('evidence_task.id=r.source_task_id');
 expect(shape.resource.taskEvidenceReaders).toContain('evidence_task.verifier_principal_id');
});
test('MCP workflow surface rejects caller-written provenance before dispatch',async()=>{
 const tool=toolByName('relayhall_task_report_save')!;
 await expect(tool.handler({task:TASK,title:'p',content:'c',idempotencyKey:'one-exact-key-123',authorPrincipalId:OWNER},{} as any)).rejects.toThrow();
 expect(tool.scope).toBe('tasks:write');
 expect(toolByName('relayhall_task_report_list')!.scope).toBe('tasks:read');
});

import { feedEventService } from '../services/FeedEventService';
test('create records authenticated author, server source and links automatically',async()=>{
 const owner=jest.spyOn(feedEventService,'resolveOwnerPrincipalUuid').mockResolvedValue(OWNER);
 const emit=jest.spyOn(feedEventService,'emit').mockResolvedValue(undefined as any);
 const f=fixture();await f.service.saveTaskReport(TASK,{title:'Progress',content:'Evidence'},actor);
 const call=f.client.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO reports')) as any;
 expect(call[1][8]).toBe(OWNER);expect(call[1][9]).toBe(OWNER);expect(call[1][12]).toBe(TASK);
 expect(f.statements).toContain("UPDATE reports SET origin='task-report', visibility='private' WHERE id=$1");
 expect((f.service as any).linkReport).toHaveBeenCalled();expect(f.statements).toContain('COMMIT');
 owner.mockRestore();emit.mockRestore();
});

import { ReportManager } from '../services/ReportManager';
test('generic Report PATCH cannot bypass Task handoff/reassignment gate',async()=>{
 const manager=new ReportManager({} as Pool);
 jest.spyOn(manager,'getById').mockResolvedValue({id:REPORT,origin:'task-report',source_task_id:TASK,status:'active'} as any);
 await expect(manager.update(REPORT,{content:'Bypass'})).rejects.toThrow('TASK_REPORT_ROUTE_REQUIRED');
});

test('missing authenticated canonical principal cannot use an unowned Task',async()=>{
 const f=fixture(null as any);await expect(f.service.saveTaskReport(TASK,input,{principalId:null,handle:'legacy'} as any)).rejects.toMatchObject({code:'TASK_CLAIMANT_REQUIRED'});
 expect(f.statements.some(sql=>sql.includes('UPDATE reports'))).toBe(false);
});


import { delegationService } from "../services/DelegationService";
import { taskLifecycleAccess } from "../services/TaskLifecycleAccess";
import { buildOpenApiSpec } from "../openapi/spec";

describe("authoritative Report maintenance display contract", () => {
  afterEach(() => jest.restoreAllMocks());
  function displayFixture(options: {claimant?: string | null; verifier?: string | null; status?: string; scopes?: string[]; cap?: "write" | "read" | "foreign"; alive?: boolean; accountRole?: string; fail?: boolean} = {}) {
    const acting:any={principalId:OWNER,kind:"service",role:"service",parentPrincipalId:REPORT,boundTaskId:null,legacyIdentity:false,status:"active",
      ownExpression:{scopes:["tasks:read","tasks:write"],objects:[{resourceType:"task",selectorForm:"exact",selectorIds:[options.cap==="foreign"?REPORT:TASK],verbs:[options.cap==="read"?"read":"write"]}]}};
    const account:any={principalId:REPORT,kind:"human",role:options.accountRole||"user",parentPrincipalId:null,boundTaskId:null,legacyIdentity:false,status:"active",ownExpression:null};
    const authorization:any={principalId:OWNER,handle:"worker",authenticated:true,role:"service",scopes:options.scopes||["tasks:read","tasks:write"],delegation:{links:[acting,account]}};
    jest.spyOn(delegationService,"resolveChain").mockResolvedValue({alive:options.alive!==false,links:[acting,account]} as any);
    jest.spyOn(authorizationRepository,"authorizedIds").mockImplementation(async(value,_type,ids,action)=>new Set(action==="write" && authorizationService.authorizeResource(value,"write",{type:"task",id:TASK,claimantPrincipalId:OWNER}).allowed?ids:[]));
    const client:any={release:jest.fn(),query:jest.fn(async(sql:string)=>{
      if(options.fail && sql.includes("FROM tasks t"))throw new Error("fixture lookup unavailable");
      if(sql.includes("FROM tasks t"))return {rows:[{id:TASK,status:options.status||"in-progress",claimant_principal_id:options.claimant===undefined?OWNER:options.claimant,verifier_principal_id:options.verifier||null}]};
      if(sql.includes("SELECT project_id FROM tasks"))return {rows:[{project_id:null}]};
      if(sql.includes("FROM principal_credentials"))return {rows:[{scopes:authorization.scopes}]};
      return {rows:[]};
    })};
    return {service:new TaskElementService({connect:async()=>client} as any),client,authorization,actor:{principalId:OWNER,handle:"worker",authorization}};
  }
  test.each(["foreign","read"] as const)("Arm allowed by claimant role but explicit %s cap denies Report WRITE",async cap=>{
    const f=displayFixture({cap});
    expect(authorizationService.authorizeResource(f.authorization,"write",{type:"task",id:TASK,claimantPrincipalId:OWNER}).allowed).toBe(true);
    const lifecycle=await taskLifecycleAccess(f.authorization,{id:TASK,status:"in-progress",autoStart:true,ownerPrincipalId:OWNER},false);
    expect(lifecycle.arm.allowed).toBe(true);
    expect(await f.service.taskReportMaintenanceAccess(TASK,f.actor)).toEqual({allowed:false,reason:"TASK_REPORT_AUTHORITY_REVOKED"});
    await expect(f.service.saveTaskReport(TASK,input,f.actor)).rejects.toMatchObject({code:"TASK_REPORT_AUTHORITY_REVOKED"});
    expect(f.client.query.mock.calls.some(([sql]:any[])=>sql.includes("UPDATE reports"))).toBe(false);
  });
  test.each([
    [{scopes:["tasks:read"]},"TASK_REPORT_AUTHORITY_REVOKED"],
    [{claimant:REPORT},"TASK_CLAIMANT_REQUIRED"],
    [{verifier:OWNER},"TASK_CLAIMANT_REQUIRED"],
    [{status:"review"},"TASK_REPORT_FROZEN"],
    [{status:"completed"},"TASK_REPORT_FROZEN"],
    [{alive:false},"TASK_REPORT_AUTHORITY_REVOKED"],
    [{accountRole:"viewer"},"TASK_REPORT_AUTHORITY_REVOKED"],
    [{fail:true},"TASK_REPORT_ACCESS_UNAVAILABLE"],
  ])("fails closed for current contract %j",async(options,reason)=>{
    const f=displayFixture(options as any);
    expect(await f.service.taskReportMaintenanceAccess(TASK,f.actor)).toEqual({allowed:false,reason});
    expect(f.client.query).toHaveBeenCalledWith("ROLLBACK");expect(f.client.release).toHaveBeenCalled();
  });
  test("missing/mismatched identity cannot use an internal-caller exception",async()=>{
    const f=displayFixture();
    for(const actor of [{principalId:null,handle:"x"},{principalId:OWNER,handle:"x"},{...f.actor,authorization:{...f.authorization,principalId:REPORT}},{...f.actor,authorization:{...f.authorization,authenticated:false}}])
      expect(await f.service.taskReportMaintenanceAccess(TASK,actor as any)).toEqual({allowed:false,reason:"TASK_REPORT_AUTHORITY_REVOKED"});
    expect(f.client.query).not.toHaveBeenCalled();
  });
  test("valid current claimant passes only after fresh authority on locked connection",async()=>{
    const f=displayFixture();expect(await f.service.taskReportMaintenanceAccess(TASK,f.actor)).toEqual({allowed:true,reason:null});
    expect(f.client.query.mock.calls.find(([sql]:any[])=>sql.includes("FROM tasks t"))[0]).toContain("FOR UPDATE OF t");
    expect(authorizationRepository.authorizedIds).toHaveBeenCalledWith(expect.anything(),"task",[TASK],"write",f.client);
    expect(f.client.query).toHaveBeenCalledWith("COMMIT");
  });
  test("incremental display acquisition failure denies without a client; save still rejects",async()=>{
    const f=displayFixture();const connect=jest.fn().mockRejectedValue(new Error("Injected acquisition failure"));
    const service=new TaskElementService({connect} as any);
    expect(await service.taskReportMaintenanceAccess(TASK,f.actor)).toEqual({allowed:false,reason:"TASK_REPORT_ACCESS_UNAVAILABLE"});
    expect(f.client.query).not.toHaveBeenCalled();expect(f.client.release).not.toHaveBeenCalled();
    await expect(service.saveTaskReport(TASK,input,f.actor)).rejects.toThrow("Injected acquisition failure");
    expect(connect).toHaveBeenCalledTimes(2);
  });
  test.each(["rollback", "release", "both"])("cleanup %s failure cannot override denied claimant projection",async failure=>{
    const f=displayFixture({claimant:REPORT});const query=f.client.query.getMockImplementation()!;
    f.client.query.mockImplementation(async(sql:string)=>{
      if(sql==="ROLLBACK" && failure!=="release")throw new Error("Injected rollback failure");
      return query(sql);
    });
    if(failure!=="rollback")f.client.release.mockImplementation(()=>{throw new Error("Injected release failure");});
    expect(await f.service.taskReportMaintenanceAccess(TASK,f.actor)).toEqual({allowed:false,reason:"TASK_CLAIMANT_REQUIRED"});
    expect(f.client.query).toHaveBeenCalledWith("ROLLBACK");expect(f.client.release).toHaveBeenCalledTimes(1);
    expect(f.client.query.mock.calls.some(([sql]:any[])=>sql.includes("UPDATE reports"))).toBe(false);
  });
  test("release failure after successful policy lookup degrades to denied projection",async()=>{
    const f=displayFixture();f.client.release.mockImplementation(()=>{throw new Error("Injected release failure");});
    expect(await f.service.taskReportMaintenanceAccess(TASK,f.actor)).toEqual({allowed:false,reason:"TASK_REPORT_ACCESS_UNAVAILABLE"});
    expect(f.client.query).toHaveBeenCalledWith("COMMIT");expect(f.client.release).toHaveBeenCalledTimes(1);
  });
  test("lookup plus rollback and release failures still return unavailable rather than throwing",async()=>{
    const f=displayFixture({fail:true});const query=f.client.query.getMockImplementation()!;
    f.client.query.mockImplementation(async(sql:string)=>{if(sql==="ROLLBACK")throw new Error("Injected rollback failure");return query(sql);});
    f.client.release.mockImplementation(()=>{throw new Error("Injected release failure");});
    expect(await f.service.taskReportMaintenanceAccess(TASK,f.actor)).toEqual({allowed:false,reason:"TASK_REPORT_ACCESS_UNAVAILABLE"});
    expect(f.client.release).toHaveBeenCalledTimes(1);
  });
  test("public GET Task schema declares the read-only projection, not a write capability",()=>{
    const spec:any=buildOpenApiSpec();const decision=spec.components.schemas.TaskReadShape.properties.reportMaintenanceAccess;
    expect(decision).toMatchObject({readOnly:true,required:["allowed","reason"],properties:{allowed:{type:"boolean"},reason:{type:"string",nullable:true}}});
    expect(spec.components.schemas.TaskSharedWriteFields.properties.reportMaintenanceAccess).toBeUndefined();
  });
});
