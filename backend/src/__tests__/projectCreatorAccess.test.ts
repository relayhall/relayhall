jest.mock('../db/connection', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../services/PrincipalService', () => ({ principalService: { getPrincipalById: jest.fn(async id => ({ id,status:'active',legacyIdentity:false })) } }));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn(async () => undefined) } }));
jest.mock('../services/FeedEventService', () => ({ feedEventService: { emit: jest.fn(async () => undefined) } }));
jest.mock('../services/LifecyclePolicyService', () => ({ lifecyclePolicyService: { evaluate: jest.fn(async () => undefined) } }));
import { pool } from '../db/connection';
import { ProjectService } from '../services/ProjectService';
import { GrantService } from '../services/GrantService';
import { auditService } from '../services/AuditService';
import { feedEventService } from '../services/FeedEventService';
import type { AuthorizationActor } from '../services/AuthorizationService';
const principalId='aaaaaaaa-2222-4333-8444-555555555555';
const projectId='bbbbbbbb-2222-4333-8444-555555555555';
const authorization: AuthorizationActor={principalId,handle:'creator',role:'user',scopes:['projects:write'],authenticated:true};
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
test('ordinary Project bootstrap grants exactly creator read/write with same-client audit/feed and no owner or vehicle marker',async()=>{
 const f=fixture();await new ProjectService().create({name:'Created'},actor);
 expect(f.grants.map(g=>[g.grantee_type,g.grantee_id,g.resource_type,g.verb,g.granted_by_principal_id,g.expires_at])).toEqual([
  ['principal',principalId,'project','read',principalId,null],['principal',principalId,'project','write',principalId,null]]);
 expect(new Set(f.grants.map(g=>g.resource_id)).size).toBe(1);
 const insert=f.events.find(sql=>sql.includes('INSERT INTO projects'))!;expect(insert).not.toContain('owner_principal_id');
 expect(f.events.filter(sql=>sql.includes('INSERT INTO grants')).every(sql=>!sql.includes('provenance')&&!sql.includes('origin'))).toBe(true);
 expect(f.events.filter(sql=>sql==='BEGIN')).toHaveLength(1);expect(f.events.filter(sql=>sql==='COMMIT')).toHaveLength(1);
 expect(f.events.at(-1)).toBe('COMMIT');expect(pool.connect).toHaveBeenCalledTimes(1);
 expect((auditService.record as jest.Mock).mock.calls.filter(([e])=>e.action==='project.creator_access').map(([e])=>e.metadata.verb)).toEqual(['read','write']);
 expect((auditService.record as jest.Mock).mock.calls.every(([,client])=>client===f.client)).toBe(true);
 expect(feedEventService.emit).toHaveBeenCalledTimes(2);
});
// Dispatcher ruling D7: the actual-creator pair is a policy of ORDINARY creation only.
// The server-owned Blueprint channel writes NO creator Grant pair - the same clause that
// omits the home-group act omits this one. What this case still owns is the outer-transaction
// seam: no nested BEGIN/COMMIT/ROLLBACK, no release, no reach for the pool.
test('Blueprint outer transaction writes no creator Grant and takes no nested commit/release',async()=>{
 const f=fixture();const tx={client:f.client,actor:{principalId,handle:'creator',authorization},source:'blueprint' as const,afterCommit:jest.fn()};
 await new ProjectService().create({name:'Created'},actor,tx as any,projectId);
 expect(f.grants).toEqual([]);expect(f.events.some(sql=>sql.includes('INSERT INTO grants'))).toBe(false);
 expect(f.events.some(sql=>/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))).toBe(false);
 expect(f.client.release).not.toHaveBeenCalled();expect(pool.connect).not.toHaveBeenCalled();
});
test('creator policy audit failure rolls back ordinary Project and both Grants',async()=>{
 const f=fixture();(auditService.record as jest.Mock).mockImplementation(async event=>{if(event.action==='project.creator_access'&&event.metadata.verb==='write')throw new Error('policy audit unavailable');});
 await expect(new ProjectService().create({name:'Created'},actor)).rejects.toThrow('policy audit unavailable');
 expect(f.grants).toHaveLength(2);expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.events).not.toContain('COMMIT');
});
test.each(['disabled','terminated'])('inactive creator %s cannot receive bootstrap Grants',async status=>{
 const f=fixture();f.client.query.mockImplementation(async sql=>({rows:sql.includes('SELECT id,status,legacy_identity')?[{id:principalId,status,legacy_identity:false}]:[]}));
 await expect(new GrantService().createForProjectCreator(f.client as any,projectId,authorization,actor.audit)).rejects.toMatchObject({code:'PROJECT_CREATOR_UNAVAILABLE'});
 expect(f.client.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO grants'))).toBe(false);
});
test('system creation has no inferred creator Grant',async()=>{
 const f=fixture();await new ProjectService().create({name:'Created'});expect(f.grants).toEqual([]);
});
test('reading an existing Project does not invoke creator bootstrap',async()=>{
 const f=fixture();await new ProjectService().getById(projectId,f.client as any);expect(f.grants).toEqual([]);
});
test('resolved caller without actual create ceiling refuses rather than inferring grants management authority',async()=>{
 const f=fixture();await expect(new ProjectService().create({name:'Created'},{...actor,authorization:{...authorization,scopes:['projects:read']}})).rejects.toMatchObject({code:'PROJECT_CREATOR_REQUIRED'});
 expect(f.grants).toEqual([]);expect(f.events).not.toContain('COMMIT');
});
