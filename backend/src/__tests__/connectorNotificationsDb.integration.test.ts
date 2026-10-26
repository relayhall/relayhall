/** Real PostgreSQL + real socket proof. Never runs without a disposable DB URL. */
import http from 'http';
import crypto from 'crypto';
import { WebSocket } from 'ws';
const databaseUrl = process.env.RELAYHALL_TEST_DB_URL;
if (!databaseUrl) throw new Error('RELAYHALL_TEST_DB_URL required; this integration gate never skips');
const parsed = new URL(databaseUrl);
const database = decodeURIComponent(parsed.pathname.slice(1));
const local = ['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) && /test|contract|fixture/.test(database);
const ci = process.env.CI === 'true' && parsed.hostname === 'postgres' && database === 'relayhall_ci';
if (!['postgres:','postgresql:'].includes(parsed.protocol) || ['relayhall','relayhall_dev','relayhall_tst','relayhall_prod'].includes(database) || (!local && !ci)) throw new Error('Refusing a non-disposable database');
Object.assign(process.env,{DB_HOST:parsed.hostname,DB_PORT:parsed.port||'5432',DB_NAME:database,DB_USER:decodeURIComponent(parsed.username),DB_PASSWORD:decodeURIComponent(parsed.password),NODE_ENV:'test'});
const {pool}=require('../db/connection');
const {principalService}=require('../services/PrincipalService');
const {feedEventService}=require('../services/FeedEventService');
const {ConnectorNotificationService}=require('../services/ConnectorNotificationService');
jest.setTimeout(30000);
let server:http.Server,service:any,port:number;
const sockets:WebSocket[]=[];
const inbox=new Map<WebSocket,any[]>();
const system={handle:'connector-ws-db-fixture',authMethod:'system'};
const tag=()=> 'wsdb-'+crypto.randomBytes(8).toString('hex');
async function account(){
 const r=await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,$1,'active','user') RETURNING id",[tag()]);
 return r.rows[0].id;
}
async function connector(parent:string,scopes=['tasks:read'],transport='api'){
 const r=await pool.query("INSERT INTO principals(kind,handle,display_name,status,role,parent_principal_id,purpose,own_expression) VALUES('service',$1,$1,'active','user',$2,'socket database fixture',$3::jsonb) RETURNING id",[tag(),parent,JSON.stringify({scopes:'parent',objects:'parent'})]);
 const id=r.rows[0].id;const credential=await principalService.issueCredential({principalId:id,scopes,transport},system);
 return {id,credential,authorization:'Bearer '+credential.fullKey};
}
async function task(creator:string){
 const r=await pool.query("INSERT INTO tasks(title,status,visibility,creator_principal_id) VALUES($1,'todo','private',$2) RETURNING id",[tag(),creator]);
 return r.rows[0].id;
}
async function grant(parent:string,taskId:string){
 const r=await pool.query("INSERT INTO grants(grantee_type,grantee_id,resource_type,resource_id,verb,granted_by_principal_id) VALUES('principal',$1,'task',$2,'read',$1) RETURNING id",[parent,taskId]);
 return r.rows[0].id;
}
async function emit(taskId:string){
 const client=await pool.connect();
 try {await client.query('BEGIN');await feedEventService.emit(client,{name:'task.updated',objectType:'task',objectId:taskId,payload:{}});await client.query('COMMIT');}
 catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 const r=await pool.query('SELECT max(cursor)::text AS cursor FROM feed_events');return r.rows[0].cursor;
}
async function head(){return (await pool.query("SELECT coalesce(max(cursor),0)::text AS cursor FROM feed_events")).rows[0].cursor;}
async function connect(auth:string,cursor:string):Promise<WebSocket|number>{
 return new Promise((resolve,reject)=>{
 const ws=new WebSocket('ws://127.0.0.1:'+port+'/events/ws?cursor='+cursor,{headers:{Authorization:auth}});
 sockets.push(ws);inbox.set(ws,[]);ws.on('message',data=>inbox.get(ws)!.push(JSON.parse(data.toString())));
 const timer=setTimeout(()=>reject(new Error('Upgrade timed out')),10000);
 ws.on('error',()=>undefined);
 ws.once('open',()=>{clearTimeout(timer);resolve(ws)});
 ws.once('unexpected-response',(_req,res)=>{clearTimeout(timer);res.resume();ws.terminate();resolve(res.statusCode!)});
 });
}
async function page(ws:WebSocket,cursor:string){
 const until=Date.now()+10000;
 while(Date.now()<until){const match=inbox.get(ws)?.find(p=>p.nextCursor===cursor);if(match)return match;await new Promise(r=>setTimeout(r,10));}
 throw new Error('Frame timed out');
}
beforeAll(async()=>{
 server=http.createServer((_req,res)=>{res.writeHead(404);res.end()});service=new ConnectorNotificationService(server,30);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));port=(server.address() as any).port;
});
afterEach(()=>{for(const ws of sockets.splice(0))ws.terminate();inbox.clear()});
afterAll(async()=>{service?.shutdown();if(server)await new Promise<void>(r=>server.close(()=>r()));await pool.end()});

test('database-issued API keys and real delegation/grants separate private account feeds',async()=>{
 const owner=await account(),a=await account(),b=await account();
 const ta=await task(owner),tb=await task(owner);await grant(a,ta);await grant(b,tb);
 const ca=await connector(a),cb=await connector(b),start=await head();
 await emit(ta);const end=await emit(tb);
 const wa=await connect(ca.authorization,start) as WebSocket,wb=await connect(cb.authorization,start) as WebSocket;
 expect((await page(wa,end)).events.map((e:any)=>e.objectId)).toEqual([ta]);
 expect((await page(wb,end)).events.map((e:any)=>e.objectId)).toEqual([tb]);
 // Reconnect from a processed checkpoint and receive only subsequent events.
 const disconnected=new Promise<void>(resolve=>wa.once('close',()=>resolve()));wa.close();await disconnected;
 const later=await emit(ta),resumed=await connect(ca.authorization,end) as WebSocket;
 const recovery=await page(resumed,later);
 expect(recovery.events.map((e:any)=>e.objectId)).toEqual([ta]);
 expect(recovery.events.every((e:any)=>BigInt(e.cursor)>BigInt(end))).toBe(true);
});
test('real credential transport and scope ceilings refuse before upgrade',async()=>{
 const parent=await account();
 const mcp=await connector(parent,['tasks:read'],'mcp'),noScope=await connector(parent,['reports:read'],'api');
 expect(await connect(mcp.authorization,await head())).toBe(401);
 expect(await connect(noScope.authorization,await head())).toBe(401);
 const any=await connector(parent,['tasks:read'],'any');
 expect(await connect(any.authorization,await head())).toBeInstanceOf(WebSocket);
});
test('revoking a real object grant conceals later events on the already-open socket',async()=>{
 const owner=await account(),parent=await account(),t=await task(owner),g=await grant(parent,t),c=await connector(parent);
 const start=await head(),ws=await connect(c.authorization,start) as WebSocket;await page(ws,start);
 const visible=await emit(t);expect((await page(ws,visible)).events.map((e:any)=>e.objectId)).toEqual([t]);
 expect((await pool.query('DELETE FROM grants WHERE id=$1',[g])).rowCount).toBe(1);
 const hidden=await emit(t);expect((await page(ws,hidden)).events).toEqual([]);
});
test('revoking the database credential closes its live socket with 1008',async()=>{
 const parent=await account(),c=await connector(parent),start=await head(),ws=await connect(c.authorization,start) as WebSocket;
 await page(ws,start);
 const closed=new Promise<number>(resolve=>ws.once('close',resolve));
 expect((await pool.query('UPDATE principal_credentials SET revoked_at=now() WHERE id=$1',[c.credential.credentialId])).rowCount).toBe(1);
 expect(await closed).toBe(1008);
});
