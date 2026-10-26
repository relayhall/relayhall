jest.mock('../db/connection',()=>({pool:{query:jest.fn()}}));
jest.mock('../services/TaskManagerDB',()=>({taskManagerDB:{}}));
jest.mock('../services/ReportManager',()=>({reportManager:{}}));
jest.mock('../services/TaskHistoryService',()=>({taskHistoryService:{}}));
jest.mock('../services/TaskReviewAttemptService',()=>({TaskReviewAttemptService:jest.fn(),hashReviewReports:jest.fn()}));
jest.mock('../services/FeedEventService',()=>({feedEventService:{}}));
jest.mock('../services/TelemetryPrincipalService',()=>({telemetryPrincipalService:{}}));
jest.mock('../services/TaskAuthoritySnapshot',()=>({taskAuthoritySnapshot:jest.fn()}));
jest.mock('../services/TaskCompletionAuthority',()=>({assertTaskCompletionAuthority:jest.fn()}));
jest.mock('../services/AuthorizationRepository',()=>({authorizationRepository:{authorizedIds:jest.fn(async()=>new Set())}}));
jest.mock('../services/AuthorizationService',()=>({authorizationService:{authorizeRoute:jest.fn()}}));
jest.mock('../services/TelemetryProjectionService',()=>({telemetryProjectionService:{session:jest.fn()}}));
import { NativeReviewService } from '../services/NativeReviewService';
import { authorizationService } from '../services/AuthorizationService';
import { telemetryProjectionService } from '../services/TelemetryProjectionService';
const task='00000000-0000-4000-8000-000000000001';
const actor:any={principalId:'reader',authorization:{}};
const expired='2000-01-01T00:00:00Z',live='2099-01-01T00:00:00Z';
const key={sessionRef:'private-ref',connectorId:'private-connector',sourceProduct:'claude-code'};
let pool:any,service:NativeReviewService,row:any,link:any;
beforeEach(()=>{
 jest.clearAllMocks();
 (authorizationService.authorizeRoute as jest.Mock).mockReturnValue({allowed:true});
 actor.authorization={authenticated:true,principalId:'own',scopes:['services:read']};
 (telemetryProjectionService.session as jest.Mock).mockResolvedValue({events:[{}]});
 row={id:'review',task_id:task,state:'attested',session_expires_at:live,report_ids:[],verdict:null};
 link={account_id:'own',expires_at:live,session_ref:key.sessionRef,connector_id:key.connectorId,source_product:key.sourceProduct};
 pool={query:jest.fn(async(sql:string)=>({rows:sql.includes('task_native_review_sessions')?(link?[link]:[]):[row]}))};
 service=new NativeReviewService(pool);
});
async function session(){return (await service.list(task,actor))[0].session;}
test.each([expired,live])('denied service scope hides session state %s',async expiry=>{
 row.session_expires_at=expiry;link.expires_at=expiry;
 (authorizationService.authorizeRoute as jest.Mock).mockReturnValue({allowed:false});
 expect(await session()).toEqual({state:'restricted'});expect(telemetryProjectionService.session).not.toHaveBeenCalled();
});
test.each([expired,live])('missing telemetry scope hides session state %s',async expiry=>{
 link.expires_at=expiry;actor.authorization.authenticated=false;
 expect(await session()).toEqual({state:'restricted'});expect(telemetryProjectionService.session).not.toHaveBeenCalled();
});
test.each([expired,live])('foreign account hides session state %s',async expiry=>{
 link.expires_at=expiry;link.account_id='foreign';
 expect(await session()).toEqual({state:'restricted'});expect(telemetryProjectionService.session).not.toHaveBeenCalled();
});
test('authorized expired session remains expired without projection',async()=>{
 link.expires_at=expired;expect(await session()).toEqual({state:'expired'});expect(telemetryProjectionService.session).not.toHaveBeenCalled();
});
test('authorized live session returns only the exact navigation triple',async()=>{
 expect(await session()).toEqual({state:'available',...key});expect(telemetryProjectionService.session).toHaveBeenCalledWith({kind:'account',accountId:'own'},key,{events:1});
});
test('authorized live but never observed remains unavailable',async()=>{
 (telemetryProjectionService.session as jest.Mock).mockResolvedValue(null);expect(await session()).toEqual({state:'unavailable'});
});
test('current scope is recomputed after a previously available read',async()=>{
 expect(await session()).toEqual({state:'available',...key});jest.clearAllMocks();
 (authorizationService.authorizeRoute as jest.Mock).mockReturnValue({allowed:false});
 expect(await session()).toEqual({state:'restricted'});expect(telemetryProjectionService.session).not.toHaveBeenCalled();
});
test('purged link cannot reveal expiry to a denied or unbound account',async()=>{
 link=null;row.session_expires_at=expired;
 expect(await session()).toEqual({state:'restricted'});
 actor.authorization.authenticated=false;expect(await session()).toEqual({state:'restricted'});expect(telemetryProjectionService.session).not.toHaveBeenCalled();
});
test('authorized root sentinel retains expired and pending semantics without a link',async()=>{
 link=null;actor.authorization.scopes=['root'];row.session_expires_at=expired;
 expect(await session()).toEqual({state:'expired'});row.session_expires_at=null;row.state='pending';expect(await session()).toEqual({state:'not-started'});
});
