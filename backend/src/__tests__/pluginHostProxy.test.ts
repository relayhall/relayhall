import http from 'http';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import express from 'express';
import jwt from 'jsonwebtoken';
jest.mock('../middleware/auth',()=>({authMiddleware:async(req:any,res:any,next:any)=>{
  const token=req.headers.authorization;
  if(!token){res.status(401).end();return;}
  req.userId='caller';req.principal={id:'actor',status:'active'};
  req.delegationLinks=[{principalId:'actor'},{principalId:['Bearer other','Bearer root-other'].includes(token)?'other':'owner'}];
  req.scopes=token==='Bearer narrow'?[]:token==='Bearer read-only'?['services:read']:token==='Bearer root-other'?['root']:['services:read','services:write','tasks:write','tasks:read'];
  next();
}}));
jest.mock('../services/PrincipalService',()=>({principalService:{getPrincipalById:jest.fn(async(id:string)=>({id,status:'active',kind:'human',parentPrincipalId:null}))}}));
jest.mock('../services/AuthorizationRepository',()=>({authorizationRepository:{authorizePoint:jest.fn(async()=>({allowed:true}))}}));
import {createPluginProxy} from '../middleware/pluginProxy';
import {principalService} from '../services/PrincipalService';
import {authorizationRepository} from '../services/AuthorizationRepository';
import { installPluginSettingsDouble } from './support/pluginSettingsDouble';
// Card bedf50cc: availability is ANDed into every plugin site; no row = default_on.
installPluginSettingsDouble();
const key='p02-test-only-assertion-key-long-enough';
const task='11111111-1111-4111-8111-111111111111';
describe('v1 proxy authorization and assertion transport',()=>{
 let upstream:http.Server,host:http.Server,url:string,last:any,releaseEvent:(()=>void)|undefined,upstreamClosed:Promise<void>|undefined;
 const config:any={name:'sample-plugin',access:{accounts:{owner:['view','generate']},assertion_key_env:'P02_KEY'}};
 beforeAll(async()=>{
  process.env.P02_KEY=key;
  upstream=http.createServer((req,res)=>{
   let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    last={headers:req.headers,body,path:req.url};
    // Card bedf50cc: a ranged media representation that honours If-Range.
    if(req.url==='/media'){
     const whole='0123456789',etag='"media-v1"';
     res.setHeader('Accept-Ranges','bytes');res.setHeader('ETag',etag);
     if(req.headers.range==='bytes=2-5'&&(!req.headers['if-range']||req.headers['if-range']===etag)){
      res.statusCode=206;res.setHeader('Content-Range','bytes 2-5/10');res.setHeader('Content-Length','4');res.end(whole.slice(2,6));
     }else{res.setHeader('Content-Length','10');res.end(whole);}
     return;
    }
    // Card bedf50cc: an upstream that breaks after its headers, and one that
    // stays open until the client goes away.
    if(req.url==='/truncated'){
     res.setHeader('Content-Type','text/plain');res.flushHeaders();res.write('first');
     setTimeout(()=>res.destroy(),30);return;
    }
    if(req.url==='/cancel'){
     upstreamClosed=new Promise<void>(resolve=>res.once('close',resolve));
     res.setHeader('Content-Type','text/event-stream');res.flushHeaders();res.write('data: open\n\n');return;
    }
    if(req.url==='/events'){
     res.setHeader('Content-Type','text/event-stream');res.flushHeaders();res.write('data: first\n\n');
     releaseEvent=()=>res.end('data: final\n\n');return;
    }
    res.setHeader('Cache-Control','public,max-age=600');res.end('ok');
   });
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const port=(upstream.address() as any).port;
  const mappingRules = [
    {path:'/',methods:['GET'],match:'prefix',capability:'view'},
    {path:'/private',methods:['GET'],match:'prefix',capability:'manage'},
    {path:'/generated',methods:['POST'],match:'prefix',capability:'generate'}
  ];
  const loader:any={getPlugin:()=>({manifest:{schema_version:'rh.plugin/1'},config}),getProxyRoutes:()=>[{
    pathPrefix:'/plugins/sample-plugin',target:'http://127.0.0.1:'+port,pluginName:'sample-plugin',
    // '/view-write' is a write rule labelled view: load validation refuses it,
    // so it reaches the proxy only by a rule that bypassed the contract.
    allow:[{path:'/',methods:['GET'],match:'prefix',capability:'view'},{path:'/admin/settings',methods:['GET'],match:'prefix',capability:'manage'},{path:'/generate',methods:['POST'],match:'exact',capability:'generate'},{path:'/view-write',methods:['POST'],match:'exact',capability:'view'}]
  }, ...[
    { publicPath: '/custom-ui', upstreamPath: '/rendered-ui' },
    { publicPath: '/restricted-ui', upstreamPath: '/private' },
    { publicPath: '/write-alias', upstreamPath: '/generated' }
  ].map(mapping => ({
    pathPrefix:'/plugins/sample-plugin'+mapping.publicPath,
    target:'http://127.0.0.1:'+port+mapping.upstreamPath,
    pluginName:'sample-plugin', allow:mappingRules
  }))]};
  const app=express();app.use(express.json());app.use(createPluginProxy(loader));
  host=http.createServer(app);await new Promise<void>(resolve=>host.listen(0,'127.0.0.1',resolve));
  url='http://127.0.0.1:'+(host.address() as any).port+'/plugins/sample-plugin';
 });
 afterAll(async()=>{delete process.env.P02_KEY;await Promise.all([host,upstream].map(s=>new Promise<void>(resolve=>s.close(()=>resolve()))));});
 beforeEach(()=>{last=null;jest.clearAllMocks();});
 it('refuses legacy capability-only requests and other Accounts',async()=>{
  expect((await fetch(url,{headers:{cookie:'nim_browser_access=legacy'}})).status).toBe(401);
  expect((await fetch(url,{headers:{authorization:'Bearer other'}})).status).toBe(404);expect(last).toBeNull();
 });
 it('honors credential scope narrowing',async()=>expect((await fetch(url,{headers:{authorization:'Bearer narrow'}})).status).toBe(403));
 it('rejects write scope without Account grant and Account grant without write scope',async()=>{
  expect((await fetch(url+'/generate',{method:'POST',headers:{authorization:'Bearer read-only'}})).status).toBe(403);
  expect(last).toBeNull();
  expect((await fetch(url+'/generate',{method:'POST',headers:{authorization:'Bearer root-other'}})).status).toBe(404);
  expect(last).toBeNull();
 });
 it('rejects revoked Account and missing per-plugin key',async()=>{
  (principalService.getPrincipalById as jest.Mock).mockResolvedValueOnce({id:'owner',status:'disabled',parentPrincipalId:null});
  expect((await fetch(url,{headers:{authorization:'Bearer owner'}})).status).toBe(404);
  delete process.env.P02_KEY;
  expect((await fetch(url,{headers:{authorization:'Bearer owner'}})).status).toBe(503);
  process.env.P02_KEY=key;
 });
 it('strips all credentials, binds authorized task and preserves parsed JSON body',async()=>{
  const response=await fetch(url+'/generate',{method:'POST',headers:{authorization:'Bearer owner',cookie:'private=board-secret',
    'content-type':'application/json','x-relayhall-task-id':task,'x-relayhall-assertion':'forged'},body:JSON.stringify({prompt:'test'})});
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(last.headers.authorization).toBeUndefined();expect(last.headers.cookie).toBeUndefined();
  expect(last.headers['x-relayhall-task-id']).toBeUndefined();expect(last.body).toBe('{"prompt":"test"}');
  const claims=jwt.verify(last.headers['x-relayhall-assertion'],key,{audience:'sample-plugin',issuer:'relayhall'}) as jwt.JwtPayload;
  expect(claims).toMatchObject({sub:'owner',actor:'actor',capability:'generate',taskId:task});
  expect(authorizationRepository.authorizePoint).toHaveBeenCalledWith(expect.objectContaining({principalId:'actor'}),'task',task,'write');
 });
 it('selects custom UI over the broad route and preserves proxy_to with suffix/query',async()=>{
  expect((await fetch(url+'/custom-ui',{headers:{authorization:'Bearer owner'}})).status).toBe(200);
  expect(last.path).toBe('/rendered-ui');
  expect((await fetch(url+'/custom-ui/assets/icon?size=2',{headers:{authorization:'Bearer owner'}})).status).toBe(200);
  expect(last.path).toBe('/rendered-ui/assets/icon?size=2');
 });
 it('checks the mapped upstream capability, never the public alias',async()=>{
  expect((await fetch(url+'/restricted-ui/job',{headers:{authorization:'Bearer owner'}})).status).toBe(404);
  expect(last).toBeNull();
  expect((await fetch(url+'/write-alias/job',{method:'POST',headers:{authorization:'Bearer owner'}})).status).toBe(200);
  expect(last.path).toBe('/generated/job');
  const claims=jwt.verify(last.headers['x-relayhall-assertion'],key) as jwt.JwtPayload;
  expect(claims.capability).toBe('generate');
 });
 it('protects direct deployment settings on every request including grant revocation',async()=>{
  expect((await fetch(url+'/admin/settings',{headers:{authorization:'Bearer owner'}})).status).toBe(404);
  expect(last).toBeNull();
  config.access.accounts.owner.push('manage');
  try {
   expect((await fetch(url+'/admin/settings',{headers:{authorization:'Bearer owner'}})).status).toBe(200);
   expect(last.path).toBe('/admin/settings');
   const claims=jwt.verify(last.headers['x-relayhall-assertion'],key) as jwt.JwtPayload;
   expect(claims.capability).toBe('manage');
  } finally { config.access.accounts.owner=config.access.accounts.owner.filter((cap:string)=>cap!=='manage'); }
  last=null;
  expect((await fetch(url+'/admin/settings',{headers:{authorization:'Bearer owner'}})).status).toBe(404);
  expect(last).toBeNull();
 });
 it('refuses a write immediately after its Account grant is revoked without reaching upstream',async()=>{
  expect((await fetch(url+'/generate',{method:'POST',headers:{authorization:'Bearer owner'}})).status).toBe(200);
  last=null;
  config.access.accounts.owner=['view'];
  try {
   expect((await fetch(url+'/generate',{method:'POST',headers:{authorization:'Bearer owner'}})).status).toBe(404);
   expect(last).toBeNull();
  } finally { config.access.accounts.owner=['view','generate']; }
 });
 it('the deployment view default admits a read and never a write, even on a rule labelled view (card 8fe6d7bb)',async()=>{
  config.access.default=['view'];
  try {
   expect((await fetch(url,{headers:{authorization:'Bearer other'}})).status).toBe(200);
   expect(jwt.verify(last.headers['x-relayhall-assertion'],key)).toMatchObject({sub:'other',capability:'view'});
   last=null;
   expect((await fetch(url+'/view-write',{method:'POST',headers:{authorization:'Bearer other'}})).status).toBe(404);
   expect((await fetch(url+'/generate',{method:'POST',headers:{authorization:'Bearer other'}})).status).toBe(404);
   expect((await fetch(url+'/admin/settings',{headers:{authorization:'Bearer other'}})).status).toBe(404);
   expect(last).toBeNull();
   // An explicit per-Account entry keeps its write path unchanged.
   expect((await fetch(url+'/view-write',{method:'POST',headers:{authorization:'Bearer owner'}})).status).toBe(200);
  } finally { delete config.access.default; }
 });
 it('forwards If-Range together with Range (card bedf50cc)',async()=>{
  const response=await fetch(url+'/media',{headers:{authorization:'Bearer owner',range:'bytes=2-5','if-range':'"media-v1"'}});
  expect(last.headers.range).toBe('bytes=2-5');expect(last.headers['if-range']).toBe('"media-v1"');
  expect(response.status).toBe(206);expect(await response.text()).toBe('2345');
 });
 it('stale validator yields upstream 200 full body, matching validator yields 206 with Content-Range (card bedf50cc)',async()=>{
  const stale=await fetch(url+'/media',{headers:{authorization:'Bearer owner',range:'bytes=2-5','if-range':'"obsolete"'}});
  expect(stale.status).toBe(200);expect(await stale.text()).toBe('0123456789');
  expect(stale.headers.get('content-range')).toBeNull();expect(stale.headers.get('content-length')).toBe('10');
  const matching=await fetch(url+'/media',{headers:{authorization:'Bearer owner',range:'bytes=2-5','if-range':'"media-v1"'}});
  expect(matching.status).toBe(206);expect(await matching.text()).toBe('2345');
  expect(matching.headers.get('content-range')).toBe('bytes 2-5/10');expect(matching.headers.get('content-length')).toBe('4');
  expect(matching.headers.get('accept-ranges')).toBe('bytes');expect(matching.headers.get('etag')).toBe('"media-v1"');
 });
 it('an SSE chunk is delivered before the upstream ends (card bedf50cc)',async()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const response=await fetch(url+'/events',{headers:{authorization:'Bearer owner'},signal:controller.signal});
   expect(response.headers.get('content-type')).toBe('text/event-stream');
   const reader=response.body!.getReader();
   const first=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('first chunk withheld until end')),2000);})]);
   clearTimeout(timer);expect(first.done).toBe(false);expect(Buffer.from(first.value!).toString()).toBe('data: first\n\n');
   expect(releaseEvent).toBeDefined();releaseEvent!();
   let rest='';for(;;){const chunk=await reader.read();if(chunk.done)break;rest+=Buffer.from(chunk.value!).toString();}
   expect(rest).toBe('data: final\n\n');
  }finally{clearTimeout(timer);releaseEvent?.();releaseEvent=undefined;controller.abort();}
 });
 it('upstream abort after headers ends the downstream as incomplete (card bedf50cc)',async()=>{
  // The client must see a terminated stream promptly, never a clean end and
  // never a wait for its own timeout.
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),2000);
  try{
   const response=await fetch(url+'/truncated',{headers:{authorization:'Bearer owner'},signal:controller.signal});
   expect(response.status).toBe(200);
   await expect(response.text()).rejects.toThrow();
   expect(controller.signal.aborted).toBe(false);
  }finally{clearTimeout(timer);controller.abort();}
 });
 it('client close destroys the upstream request (card bedf50cc)',async()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const response=await fetch(url+'/cancel',{headers:{authorization:'Bearer owner'},signal:controller.signal});
   const reader=response.body!.getReader();expect((await reader.read()).done).toBe(false);
   expect(upstreamClosed).toBeDefined();await reader.cancel();controller.abort();
   await expect(Promise.race([upstreamClosed!.then(()=>'closed'),new Promise<string>(resolve=>{timer=setTimeout(()=>resolve('retained'),2000);})])).resolves.toBe('closed');
  }finally{clearTimeout(timer);controller.abort();upstreamClosed=undefined;}
 });
 it('forwards Range without If-Range and preserves 206 and its headers (card bedf50cc)',async()=>{
  const response=await fetch(url+'/media',{headers:{authorization:'Bearer owner',range:'bytes=2-5'}});
  expect(last.headers.range).toBe('bytes=2-5');expect(last.headers['if-range']).toBeUndefined();
  expect(response.status).toBe(206);expect(await response.text()).toBe('2345');
  expect(response.headers.get('content-range')).toBe('bytes 2-5/10');expect(response.headers.get('content-length')).toBe('4');
  expect(response.headers.get('accept-ranges')).toBe('bytes');expect(response.headers.get('etag')).toBe('"media-v1"');
 });
 // Card bedf50cc slice 2. A scripted upstream: the test decides when the
 // response headers arrive and which failure follows, so each downstream
 // ending is attributed to exactly one proxy path.
 describe('scripted upstream failures (card bedf50cc)',()=>{
  let script:{request?:any;respond?:()=>PassThrough&{complete:boolean}};
  let spy:jest.SpyInstance|undefined,quiet:jest.SpyInstance|undefined;
  beforeEach(()=>{
   script={};
   quiet=jest.spyOn(console,'error').mockImplementation(()=>{});
   spy=jest.spyOn(http,'request').mockImplementation(((_options:any,callback:any)=>{
    const request:any=new EventEmitter();
    request.end=jest.fn();request.write=jest.fn(()=>true);request.destroy=jest.fn();
    script.request=request;
    script.respond=()=>{
     const upstream=Object.assign(new PassThrough(),{statusCode:200,headers:{'content-type':'text/plain'},complete:false});
     // A listener of the test's own, so emitting 'error' never throws here:
     // only the proxy's listener can end the downstream response.
     upstream.on('error',()=>{});
     callback(upstream);return upstream;
    };
    return request;
   }) as any);
  });
  afterEach(()=>{spy?.mockRestore();quiet?.mockRestore();});
  const until=async(ready:()=>unknown)=>{for(let i=0;i<300&&!ready();i++)await new Promise(resolve=>setTimeout(resolve,10));};
  /** Open a response whose headers and first chunk arrived; resolve with how the rest of it ends. */
  async function opened(controller:AbortController){
   const pending=fetch(url+'/scripted',{headers:{authorization:'Bearer owner'},signal:controller.signal});
   await until(()=>script.request);
   const upstream=script.respond!();upstream.write('first');
   const response=await pending;
   expect(response.status).toBe(200);
   const reader=response.body!.getReader();
   expect(Buffer.from((await reader.read()).value!).toString()).toBe('first');
   const ending=(async()=>{let rest='';for(;;){const chunk=await reader.read();if(chunk.done)return 'clean end:'+rest;rest+=Buffer.from(chunk.value!).toString();}})()
     .catch(()=>controller.signal.aborted?'test timeout':'incomplete');
   return {upstream,ending};
  }
  async function ends(act:(upstream:any)=>void){
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),2000);
   try{const {upstream,ending}=await opened(controller);act(upstream);return await ending;}
   finally{clearTimeout(timer);controller.abort();}
  }
  it('an upstream request error after headers ends the downstream as incomplete',async()=>{
   expect(await ends(()=>script.request.emit('error',new Error('upstream reset after headers')))).toBe('incomplete');
  });
  it('the upstream idle timeout after headers destroys the upstream request and ends the downstream as incomplete',async()=>{
   // Checked synchronously: the timeout handler itself must destroy the upstream
   // request (the downstream 'close' handler would also do so, but later).
   let destroyedByTimeout=false;
   expect(await ends(()=>{script.request.emit('timeout');destroyedByTimeout=script.request.destroy.mock.calls.length>0;})).toBe('incomplete');
   expect(destroyedByTimeout).toBe(true);
  });
  it('an upstream response error alone ends the downstream as incomplete',async()=>{
   expect(await ends(upstream=>upstream.emit('error',new Error('upstream body failed')))).toBe('incomplete');
  });
  it('an upstream response that closes incomplete without an error ends the downstream as incomplete',async()=>{
   expect(await ends(upstream=>{upstream.complete=false;upstream.emit('close');})).toBe('incomplete');
  });
  it('a complete upstream response ends the downstream cleanly, even if its close arrives first',async()=>{
   // 'close' on a response whose transfer completed must never destroy the downstream.
   expect(await ends(upstream=>{upstream.complete=true;upstream.emit('close');upstream.end('last');})).toBe('clean end:last');
  });
  it('an upstream request error before headers answers the generic 502 without the error text',async()=>{
   const pending=fetch(url+'/scripted',{headers:{authorization:'Bearer owner'}});
   await until(()=>script.request);
   script.request.emit('error',new Error('connect refused at a private address'));
   const response=await pending;
   expect(response.status).toBe(502);
   expect(await response.json()).toEqual({error:'Plugin unavailable',plugin:'sample-plugin'});
  });
 });
 it('rejects task correlation after task permission revocation' ,async()=>{
  (authorizationRepository.authorizePoint as jest.Mock).mockResolvedValueOnce({allowed:false});
  expect((await fetch(url+'/generate',{method:'POST',headers:{authorization:'Bearer owner','x-relayhall-task-id':task}})).status).toBe(404);
  expect(last).toBeNull();
 });
});
