import express from 'express';
jest.mock('../db/connection', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../services/FeedEventService', () => ({ feedEventService: { emit: jest.fn(async()=>undefined) } }));
jest.mock('../services/GrantService', () => { const actual=jest.requireActual('../services/GrantService'); return {...actual,grantService:{...actual.grantService,createForReportCreator:jest.fn()}}; });
import { pool } from '../db/connection';
import { grantService } from '../services/GrantService';
import reportsRoutes from '../routes/reports';
import { feedEventService } from '../services/FeedEventService';
const P='aaaaaaaa-2222-4333-8444-555555555555',R='bbbbbbbb-2222-4333-8444-555555555555';
const key='standalone-report-logical-operation';
type State={report:any;grants:string[];receipt:any};
let state:State, snapshot:State|undefined, events:string[], fail:string, actor:any;
const clone=(x:any):any=>x===undefined?undefined:structuredClone(x);
async function query(sql:string,params:any[]=[]):Promise<any>{
 events.push(sql);
 if(sql.startsWith('BEGIN')){snapshot=clone(state);return {rows:[]};}
 if(sql==='ROLLBACK'){if(snapshot)state=snapshot;snapshot=undefined;return {rows:[]};}
 if(sql==='COMMIT'){if(fail==='commit')throw Error('commit failed');snapshot=undefined;return {rows:[]};}
 if(sql.includes('INSERT INTO operation_idempotency_records')){
  if(state.receipt)return {rows:[],rowCount:0};state.receipt={scope:params[0],request_hash:params[3],request_id:'request-1',state:'in_flight',replay_policy:'return',created_at:new Date(),expires_at:new Date(Date.now()+86400000)};return {rows:[{request_id:'request-1'}],rowCount:1};
 }
 if(sql.includes('SELECT request_hash, state'))return {rows:state.receipt?[state.receipt]:[]};
 if(sql.includes('SELECT request_id FROM operation_idempotency_records'))return {rows:state.receipt&&fail!=='reservation'?[{request_id:'request-1'}]:[]};
 if(sql.includes('DELETE FROM operation_idempotency_records')){if(state.receipt?.state==='in_flight')state.receipt=null;return {rows:[]};}
 if(sql.includes('UPDATE operation_idempotency_records')){
  if(fail==='receipt')throw Error('receipt failed');
  if(!state.receipt)return {rows:[],rowCount:0};
  state.receipt={...state.receipt,state:'completed',response_status:201,response_body:params[4],response_content_type:params[5]};return {rows:[],rowCount:1};
 }
 if(sql.includes('INSERT INTO reports')){state.report={id:R,title:params[0],content:params[1],content_hash:params[2],summary:params[3],tags:params[4],project_id:params[5],task_ids:params[6],author:params[7],author_actor_id:params[8],author_principal_id:params[9],origin:params[10],visibility:params[11]};return {rows:[state.report]};}
 if(sql.includes('FROM reports r')&&sql.includes('WHERE r.id = $1'))return {rows:state.report?[state.report]:[]};
 if(sql.startsWith('SET LOCAL'))return {rows:[]};
 throw Error('Unexpected mock query');
}
beforeEach(()=>{
 jest.clearAllMocks();state={report:null,grants:[],receipt:null};snapshot=undefined;events=[];fail='';
 actor={principal:{id:P,handle:'creator'},userId:'creator',authMethod:'session',authorizationActor:{principalId:P,handle:'creator',role:'user',authenticated:true,scopes:['reports:write']}};
 (pool.query as jest.Mock).mockImplementation(query);(pool.connect as jest.Mock).mockResolvedValue({query,release:jest.fn()});
 (grantService.createForReportCreator as jest.Mock).mockImplementation(async(_c,id,who,audit)=>{expect(id).toBe(R);expect(who.principalId).toBe(P);expect(audit.principalId).toBe(P);state.grants.push('read','write');if(fail==='grant')throw Error('grant failed');});
 (feedEventService.emit as jest.Mock).mockImplementation(async()=>{if(fail==='feed')throw Error('feed failed');});
});
async function server(run:(base:string)=>Promise<void>,custom=false){
 const app=express();app.use(express.json());if(custom){app.set('json spaces',2);app.set('json escape',true);}
 app.use((req,_res,next)=>{Object.assign(req,actor);next();});app.use('/reports',reportsRoutes);
 const live=app.listen(0,'127.0.0.1');await new Promise<void>(r=>live.once('listening',r));
 try{await run('http://127.0.0.1:'+(live.address() as any).port);}finally{await new Promise<void>((r,e)=>live.close(x=>x?e(x):r()));}
}
function post(base:string,body:any={title:'Title',content:'<proof>'},token:string|null=key,origin?:string){return fetch(base+'/reports',{method:'POST',headers:{'content-type':'application/json',...(token?{'idempotency-key':token}:{}),...(origin?{'x-relayhall-origin':origin}:{})},body:JSON.stringify(body)});}
test('real route commits report, grant callback, feed and exact Express bytes before response',async()=>{await server(async base=>{
 const res=await post(base);expect(res.status).toBe(201);const text=await res.text();expect(state.receipt.response_body).toBe(text);expect(text).toContain('\\u003cproof\\u003e');expect(state.grants).toEqual(['read','write']);expect(feedEventService.emit).toHaveBeenCalledTimes(1);
 expect(events).toContain('BEGIN ISOLATION LEVEL READ COMMITTED');
 expect(events.findIndex(x=>x.includes('FOR UPDATE'))).toBeLessThan(events.findIndex(x=>x.includes('INSERT INTO reports')));
 expect(events.findIndex(x=>x.includes('UPDATE operation_idempotency_records'))).toBeLessThan(events.indexOf('COMMIT'));
 },true);});
test.each(['grant','feed','receipt','commit','reservation'])('%s failure commits no report or grants or success receipt',async failure=>{fail=failure;await server(async base=>{const res=await post(base);expect(res.status).toBe(500);await res.text();expect(state.report).toBeNull();expect(state.grants).toEqual([]);expect(state.receipt).toBeNull();expect(events).toContain('ROLLBACK');});});
test('response loss followed by exact replay returns stored result without regenerating revoked grants',async()=>{await server(async base=>{
 const first=await post(base);expect(first.status).toBe(201);await first.body?.cancel();const receipt=state.receipt.response_body;state.grants=[];
 const second=await post(base);expect(second.headers.get('Retry-Replayed')).toBe('true');expect(await second.text()).toBe(receipt);expect(state.grants).toEqual([]);expect(grantService.createForReportCreator).toHaveBeenCalledTimes(1);
 });});
test('changed input under same key does not execute creation policy',async()=>{await server(async base=>{await(await post(base)).text();const res=await post(base,{title:'Other',content:'body'});expect(res.status).toBe(409);expect(grantService.createForReportCreator).toHaveBeenCalledTimes(1);});});
test('unkeyed canonical human creation remains atomic without an invented retry record',async()=>{await server(async base=>{const res=await post(base,undefined,null);expect(res.status).toBe(201);await res.text();expect(state.report.author_principal_id).toBe(P);expect(state.receipt).toBeNull();expect(events).toContain('COMMIT');});});
test.each(['task-report','task-stream','native-execution','native-review'])('%s origin cannot receive standalone grants',async origin=>{await server(async base=>{const res=await post(base,undefined,key,origin);expect(res.status).toBe(400);await res.text();expect(state.report).toBeNull();expect(grantService.createForReportCreator).not.toHaveBeenCalled();});});
test('caller labels and foreign task association cannot choose the grant recipient',async()=>{await server(async base=>{const res=await post(base,{title:'T',content:'C',author:'foreign',task_ids:['cccccccc-2222-4333-8444-555555555555']});expect(res.status).toBe(201);await res.text();expect((grantService.createForReportCreator as jest.Mock).mock.calls[0][2].principalId).toBe(P);expect(state.report.author_principal_id).toBe(P);});});
test('forged canonical author is not passed into the creation policy',async()=>{await server(async base=>{const res=await post(base,{title:'T',content:'C',author_actor_id:'foreign'});expect(res.status).toBe(400);await res.text();expect(grantService.createForReportCreator).not.toHaveBeenCalled();});});

test('other creation callers retain repeatable-read by default',async()=>{
 const {runCreationTransaction}=require('../db/creationTransaction');
 await runCreationTransaction(pool,{principalId:P,authorization:actor.authorizationActor},async()=>undefined);
 expect(events).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ');
 expect(events).not.toContain('BEGIN ISOLATION LEVEL READ COMMITTED');
});
