jest.mock('../db/connection', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../services/PrincipalService', () => ({ principalService: { getPrincipalById: jest.fn(async id => ({ id,status:'active',legacyIdentity:false })) } }));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn(async () => undefined) } }));
jest.mock('../services/FeedEventService', () => ({ feedEventService: { emit: jest.fn(async () => undefined) } }));
jest.mock('../services/LifecyclePolicyService', () => ({ lifecyclePolicyService: { evaluate: jest.fn(async () => undefined) } }));
import { pool } from '../db/connection';

import { GrantService } from '../services/GrantService';
import { delegationService } from '../services/DelegationService';
import { auditService } from '../services/AuditService';
import { feedEventService } from '../services/FeedEventService';
import type { AuthorizationActor } from '../services/AuthorizationService';
const principalId='aaaaaaaa-2222-4333-8444-555555555555';
const projectId='bbbbbbbb-2222-4333-8444-555555555555';
const authorization: AuthorizationActor={principalId,handle:'creator',role:'user',scopes:['reports:write'],authenticated:true};
const actor={principalId,authMethod:'session',scopes:authorization.scopes,authorization,audit:{principalId,handle:'creator',authMethod:'session' as const}};
function fixture() {
 const events:string[]=[];const grants:any[]=[];
 const client={release:jest.fn(),query:jest.fn(async(sql:string,params:any[]=[]):Promise<any>=>{
  events.push(sql);
  if(sql.includes('SELECT id,status,legacy_identity')) return {rows:[{id:principalId,status:'active',legacy_identity:false}]};
  if(sql.includes('INSERT INTO grants')) {const [grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id,expires_at]=params;const row={id:`grant-${verb}`,grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id,expires_at};grants.push(row);return {rows:[row]};}
  if(sql.includes('SELECT * FROM projects')) return {rows:[{id:projectId,name:'Created',status:'active'}]};
  return {rows:[]};
 })};
 (pool.connect as jest.Mock).mockResolvedValue(client);
 return {client,events,grants};
}
beforeEach(()=>{jest.clearAllMocks();(auditService.record as jest.Mock).mockResolvedValue(undefined);});

test('exact Report pair has no wildcard, admin or vehicle provenance and shares transaction',async()=>{
 const f=fixture();await new GrantService().createForReportCreator(f.client as any,projectId,authorization,actor.audit);
 expect(f.grants.map(g=>[g.grantee_id,g.resource_type,g.resource_id,g.verb])).toEqual([[principalId,'report',projectId,'read'],[principalId,'report',projectId,'write']]);
 expect(feedEventService.emit).toHaveBeenCalledTimes(2);
 expect(f.events.some(sql=>/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))).toBe(false);
 expect((auditService.record as jest.Mock).mock.calls.every(([,client])=>client===f.client)).toBe(true);
 expect(f.events.filter(sql=>sql.includes('INSERT INTO grants')).every(sql=>!sql.includes('provenance')&&!sql.includes('origin'))).toBe(true);
});
test.each(['disabled','terminated'])('inactive %s creator refuses before any grant',async status=>{
 const f=fixture();f.client.query.mockImplementation(async sql=>({rows:sql.includes('SELECT id,status,legacy_identity')?[{id:principalId,status,legacy_identity:false}]:[]}));
 await expect(new GrantService().createForReportCreator(f.client as any,projectId,authorization,actor.audit)).rejects.toMatchObject({code:'REPORT_CREATOR_UNAVAILABLE'});expect(f.grants).toEqual([]);
});
test('legacy principal refuses before any grant',async()=>{
 const f=fixture();f.client.query.mockImplementation(async sql=>({rows:sql.includes('SELECT id,status,legacy_identity')?[{id:principalId,status:'active',legacy_identity:true}]:[]}));
 await expect(new GrantService().createForReportCreator(f.client as any,projectId,authorization,actor.audit)).rejects.toMatchObject({code:'REPORT_CREATOR_UNAVAILABLE'});expect(f.grants).toEqual([]);
});
test.each([{...authorization,scopes:['reports:read']},{...authorization,authenticated:false},{...authorization,principalId:'cccccccc-2222-4333-8444-555555555555'}])('trusted create ceiling and exact audit identity are required',async who=>{
 const f=fixture();await expect(new GrantService().createForReportCreator(f.client as any,projectId,who,actor.audit)).rejects.toMatchObject({code:'REPORT_CREATOR_REQUIRED'});expect(f.grants).toEqual([]);
});

const sponsorId='cccccccc-2222-4333-8444-555555555555';
const credentialId='dddddddd-2222-4333-8444-555555555555';
function sponsoredFixture() {
 const f=fixture(),baseQuery=f.client.query.getMockImplementation()!;
 const links:any[]=[
  {principalId,kind:'service',role:null,status:'active',parentPrincipalId:sponsorId,boundTaskId:null,legacyIdentity:false,ownExpression:{scopes:'parent',objects:'parent'},liveCredentialCount:1},
  {principalId:sponsorId,kind:'human',role:'user',status:'active',parentPrincipalId:null,boundTaskId:null,legacyIdentity:false,ownExpression:null,liveCredentialCount:0},
 ];
 const current={links:JSON.parse(JSON.stringify(links)),alive:true,deadReason:null};
 const resolver=jest.spyOn(delegationService,'resolveChain').mockResolvedValue(current);
 let credentialRows:any[]=[{scopes:['reports:read','reports:write']}];
 f.client.query.mockImplementation(async(sql:string,params:any[]=[])=>{
  if(sql.includes('SELECT id,status,legacy_identity')) {f.events.push(sql);return {rows:links.map(link=>({id:link.principalId,status:'active',legacy_identity:false}))};}
  if(sql.includes('SELECT scopes FROM principal_credentials')) {f.events.push(sql);return {rows:credentialRows};}
  return baseQuery(sql,params);
 });
 const who:AuthorizationActor={...authorization,role:'agent',scopes:['reports:read','reports:write'],delegation:{links}};
 const audit={...actor.audit,authMethod:'principal_api_key' as const,credentialId};
 return {...f,links,current,resolver,who,audit,setCredentials:(rows:any[])=>{credentialRows=rows;}};
}
afterEach(()=>jest.restoreAllMocks());

test('human sponsorship is exact, transactional, and immutable audit provenance keeps actual creator',async()=>{
 const f=sponsoredFixture();
 await new GrantService().createForReportCreator(f.client as any,projectId,f.who,f.audit);
 expect(f.grants.map(g=>[g.grantee_id,g.verb])).toEqual([[principalId,'read'],[principalId,'write'],[sponsorId,'read'],[sponsorId,'write']]);
 expect(f.grants.every(g=>g.resource_id===projectId&&g.resource_type==='report'&&g.granted_by_principal_id===principalId)).toBe(true);
 const writes=(auditService.record as jest.Mock).mock.calls.filter(([event])=>event.action==='report.sponsor_access');
 expect(writes).toHaveLength(2);
 for(const [event,client] of writes) {
  expect(client).toBe(f.client);
  expect(event.actor).toEqual(f.audit);
  expect(event.metadata).toEqual({policy:'report-human-sponsor-read-write-v1',grantId:'grant-'+event.metadata.verb,granteePrincipalId:sponsorId,verb:event.metadata.verb,creatorPrincipalId:principalId,sponsorPrincipalId:sponsorId,credentialId,chain:f.links.map(({principalId,kind,parentPrincipalId})=>({principalId,kind,parentPrincipalId}))});
 }
 expect(f.resolver).toHaveBeenCalledWith(principalId,f.client);
 expect(f.events.findIndex(sql=>sql.includes('FOR SHARE'))).toBeLessThan(f.events.findIndex(sql=>sql.includes('SELECT scopes FROM principal_credentials')));
 const credentialRead=f.events.find(sql=>sql.includes('SELECT scopes FROM principal_credentials'))!;
 expect(credentialRead).toContain('expires_at > clock_timestamp()');
 expect(credentialRead).toContain('grace_until > clock_timestamp()');
 expect(credentialRead).not.toContain('NOW()');
 expect(f.events.some(sql=>/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))).toBe(false);
});
test.each(['reparent','disable','legacy','wrong-creator','wrong-kind'])('fresh %s chain refuses before any grant',async mutation=>{
 const f=sponsoredFixture();
 if(mutation==='reparent') f.current.links[0].parentPrincipalId=projectId;
 if(mutation==='disable') f.current.links[1].status='disabled';
 if(mutation==='legacy') f.current.links[0].legacyIdentity=true;
 if(mutation==='wrong-creator') f.current.links[0].principalId=projectId;
 if(mutation==='wrong-kind') f.current.links[1].kind='service';
 await expect(new GrantService().createForReportCreator(f.client as any,projectId,f.who,f.audit)).rejects.toMatchObject({code:'REPORT_SPONSOR_UNAVAILABLE'});
 expect(f.grants).toEqual([]);
});
test.each([
 {rows:[],code:'REPORT_SPONSOR_UNAVAILABLE'},
 {rows:[{scopes:null}],code:'REPORT_SPONSOR_UNAVAILABLE'},
 {rows:[{scopes:['reports:read']}],code:'REPORT_CREATOR_REQUIRED'},
 {rows:[{scopes:['reports:write',1]}],code:'REPORT_SPONSOR_UNAVAILABLE'},
])('missing, expired/revoked or narrowed actual credential refuses: %j',async ({rows,code})=>{
 const f=sponsoredFixture();f.setCredentials(rows);
 await expect(new GrantService().createForReportCreator(f.client as any,projectId,f.who,f.audit)).rejects.toMatchObject({code});
 expect(f.grants).toEqual([]);
});
test('fresh Account or own-scope narrowing cannot reuse a trusted request grant',async()=>{
 const f=sponsoredFixture();f.current.links[0].ownExpression.scopes=['reports:read'];
 await expect(new GrantService().createForReportCreator(f.client as any,projectId,f.who,f.audit)).rejects.toMatchObject({code:'REPORT_CREATOR_REQUIRED'});
 expect(f.grants).toEqual([]);
});
test('missing authenticated credential and forged chain fail closed',async()=>{
 const f=sponsoredFixture();
 await expect(new GrantService().createForReportCreator(f.client as any,projectId,f.who,{...f.audit,credentialId:null})).rejects.toMatchObject({code:'REPORT_SPONSOR_UNAVAILABLE'});
 f.who.delegation!.links[0].principalId=projectId;
 await expect(new GrantService().createForReportCreator(f.client as any,projectId,f.who,f.audit)).rejects.toMatchObject({code:'REPORT_CREATOR_UNAVAILABLE'});
 expect(f.grants).toEqual([]);
});
test.each(['service-account'])('%s receives no inferred human sponsorship',async mode=>{
 const f=sponsoredFixture();
 expect(mode).toBe('service-account');f.who.delegation!.links[1].kind='service';
 await new GrantService().createForReportCreator(f.client as any,projectId,f.who,f.audit);
 expect(f.grants.map(g=>g.grantee_id)).toEqual([principalId,principalId]);
 expect(f.resolver).not.toHaveBeenCalled();
});
test('sponsor audit failure propagates to the owning creation transaction',async()=>{
 const f=sponsoredFixture();
 (auditService.record as jest.Mock).mockImplementation(async event=>{if(event.action==='report.sponsor_access')throw Error('audit unavailable');});
 await expect(new GrantService().createForReportCreator(f.client as any,projectId,f.who,f.audit)).rejects.toThrow('audit unavailable');
 expect(f.events.some(sql=>sql==='COMMIT')).toBe(false);
});

test('legitimate task-bound Agent creation sponsors only its human Account, not an intermediate Connector',async()=>{
 const f=sponsoredFixture(),connectorId='eeeeeeee-2222-4333-8444-555555555555';
 f.links[0].kind='agent';f.links[0].boundTaskId=projectId;f.links[0].parentPrincipalId=connectorId;
 f.links.splice(1,0,{...f.links[0],principalId:connectorId,kind:'service',boundTaskId:null,parentPrincipalId:sponsorId});
 f.current.links=JSON.parse(JSON.stringify(f.links));
 await new GrantService().createForReportCreator(f.client as any,projectId,f.who,f.audit);
 expect(f.grants.map(g=>g.grantee_id)).toEqual([principalId,principalId,sponsorId,sponsorId]);
 const query=f.client.query.mock.calls.find(([sql])=>sql.includes('SELECT scopes FROM principal_credentials'))!;
 expect(query[1]).toEqual([credentialId,principalId,[principalId,connectorId]]);
 expect(query[0]).toContain('live.expires_at > clock_timestamp()');
});
