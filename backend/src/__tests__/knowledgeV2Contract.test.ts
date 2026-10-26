jest.mock('../db/connection',()=>({pool:{query:jest.fn()}}));
import crypto from 'crypto';
import { normalizeV2Query, normalizeKnowledgeFilter, KnowledgeSelectorError } from '../services/KnowledgeV2';
import { sealKnowledgeHandle, unsealKnowledgeHandle, resetKnowledgeHandleKeysetCache } from '../services/KnowledgeHandleSealer';
import { validateV2KnowledgeContent } from '../services/KnowledgeGetExecutor';
const c='c1111111-1111-4111-8111-111111111111';
beforeEach(()=>{process.env.RELAYHALL_KNOWLEDGE_HANDLE_KEYS=JSON.stringify({k:crypto.randomBytes(32).toString('base64')});process.env.RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY='k';resetKnowledgeHandleKeysetCache();});
test('raw duplicate dimensions deduplicate before normalized caps; empty and excess reject',()=>{
 expect(normalizeV2Query({kinds:['docs','docs'],categories:['relaybrain:note','relaybrain:note'],sources:[c,c]})).toEqual({kinds:['docs'],categories:['relaybrain:note'],sources:[c]});
 for(const body of [{categories:[]},{categories:Array.from({length:33},(_,i)=>'rb:c'+i)},{sources:Array.from({length:17},(_,i)=>c.slice(0,-2)+String(i).padStart(2,'0'))},{kinds:['docs',1]}])expect(()=>normalizeV2Query(body)).toThrow();
});
test('historic v1 addresses and v2 continuation domains cannot be confused',()=>{
 const v1=sealKnowledgeHandle({s:c,c:'corpus',r:'doc',dv:1});expect(unsealKnowledgeHandle(v1).v).toBe(1);
 const f=normalizeKnowledgeFilter(['docs'],['relaybrain:note']);
 const continuation=sealKnowledgeHandle({s:c,c,r:'doc',dv:1,f,domain:'continuation',h:'a'.repeat(64),next:3});
 expect(()=>unsealKnowledgeHandle(continuation)).toThrow();expect(unsealKnowledgeHandle(continuation,'continuation').next).toBe(3);
});
test('binary windows use full revision hash and reject forged final hashes and nonadvancing windows',()=>{
 const f=normalizeKnowledgeFilter(['docs'],['relaybrain:note']);const payload=unsealKnowledgeHandle(sealKnowledgeHandle({s:c,c,r:'doc',dv:1,f}));
 const bytes=Buffer.from([0,255,254,13]);const hash=crypto.createHash('sha256').update(bytes).digest('hex');
 const answer={status:'content',content_base64:bytes.toString('base64'),sha256:hash,offset:0,byteLength:4,totalBytes:4,truncated:false,compartment:{id:c},contentKind:'docs',category:'relaybrain:note',retrieval:{status:'complete',reasons:[]}};
 expect(validateV2KnowledgeContent(answer,payload,0,undefined,['relaybrain:note'])).toMatchObject({ok:true,content_base64:bytes.toString('base64')});
 expect(validateV2KnowledgeContent({...answer,sha256:'a'.repeat(64)},payload,0,undefined,['relaybrain:note'])).toMatchObject({ok:false});
 expect(validateV2KnowledgeContent({...answer,content_base64:'',byteLength:0,truncated:true},payload,0,undefined,['relaybrain:note'])).toMatchObject({ok:false});
 const partial=validateV2KnowledgeContent({...answer,content_base64:bytes.subarray(0,2).toString('base64'),byteLength:2,truncated:true},payload,0,undefined,['relaybrain:note']);
 expect(partial).toMatchObject({ok:true,truncated:true});if(partial.ok&&'continuation'in partial)expect(unsealKnowledgeHandle(partial.continuation,'continuation')).toMatchObject({h:hash,next:2});
});

test('v2 numeric controls reject coercion, null, fractions and out-of-range values',()=>{
 for(const key of ['limitPerSource','timeoutMs'])for(const value of ['8',null,true,1.5,-1,9000])expect(()=>normalizeV2Query({[key]:value})).toThrow();
 expect(()=>normalizeV2Query({limitPerSource:8,timeoutMs:8000})).not.toThrow();
});
test('nonzero empty final window is never releasable',()=>{
 const f=normalizeKnowledgeFilter(['docs'],['relaybrain:note']);
 const payload=unsealKnowledgeHandle(sealKnowledgeHandle({s:c,c,r:'doc',dv:1,f}));
 const answer={status:'content',content_base64:'',sha256:'a'.repeat(64),offset:3,byteLength:0,totalBytes:3,truncated:false,compartment:{id:c},contentKind:'docs',category:'relaybrain:note',retrieval:{status:'complete',reasons:[]}};
 expect(validateV2KnowledgeContent(answer,payload,3,undefined,['relaybrain:note'])).toMatchObject({ok:false});
});


test('REST preserves the opaque audit reference on a fan-out ceiling refusal without source metadata',async()=>{
 const express=(await import('express')).default;
 const fanout=await import('../services/KnowledgeFanoutExecutor');
 const {knowledgeQueriesRouter}=await import('../routes/knowledge');
 const auditRef='ka_'+'a'.repeat(32);
 const mock=jest.spyOn(fanout,'executeKnowledgeQuery').mockRejectedValue(new KnowledgeSelectorError('SOURCE_SELECTION_TOO_BROAD',422,auditRef));
 const app=express();app.use(express.json());app.use('/knowledge-queries',knowledgeQueriesRouter);
 const server=app.listen(0,'127.0.0.1');
 try {
  await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  const address=server.address() as import('net').AddressInfo;
  const res=await fetch('http://127.0.0.1:'+address.port+'/knowledge-queries',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({protocol_version:2,q:'needle'})});
  expect(res.status).toBe(422);
  const message='Narrow the authorized source selection to at most 16 sources.';
  expect(await res.json()).toEqual({success:false,error:message,code:'SOURCE_SELECTION_TOO_BROAD',message,auditRef});
 } finally {mock.mockRestore();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
