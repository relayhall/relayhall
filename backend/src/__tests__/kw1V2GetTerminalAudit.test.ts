// KW1 0b4b779b [4]: mock-only terminal audit invocation regression.
// No durable audit persistence or deployed permission claim.
import assert from 'node:assert/strict';
async function run(answer: unknown, input: Record<string, unknown> = {}, allowed = true) {
 const audits: any[] = [], calls: string[] = [];
 const payload={v:2,s:'fixture-source',c:'fixture-compartment',dv:1,r:'PRIVATE-FIXTURE-REF',f:{kinds:['docs']}};
 const row={id:payload.s,slug:'fixture-source',knowledge_claims_mode:'none',knowledge_query_endpoint:'https://example.invalid/get'};
 const descriptor={knowledgeSource:{protocol_version:2,compartment_mode:'dynamic-opaque',categories:['fixture:note']}};
 const modules={
  '../db/connection':{pool:{query:async(sql: string)=>({rows:sql.includes('FROM services s')?[row]:[{descriptor}]})}},
  './KnowledgeDialClient':{dialKnowledgeSource:async()=>{calls.push('dial');return{ok:true,status:200,body:JSON.stringify(answer)}}},
  './KnowledgeArmEvaluator':{evaluateKnowledgeArms:async()=>allowed?{}:null,isBoardSource:()=>false},
  './KnowledgeAssertionSigner':{signKnowledgeAssertion:()=>{throw Error('unexpected signer')}},
  './KnowledgeV2':{KnowledgeCompartment:undefined,RetrievalStatus:undefined,validateRetrieval:()=>({status:'complete',reasons:[]})},
  './KnowledgeHandleSealer':{KnowledgeHandlePayload:undefined,unsealKnowledgeHandle:()=>payload,sealKnowledgeHandle:()=>{throw Error('unexpected sealing')},KnowledgeHandleError:class extends Error{}},
  './KnowledgeBoardAdapter':{readBoardObject:()=>{throw Error('unexpected board read')}},
  './KnowledgeChannelAuth':{resolveChannelCredential:()=>({}),channelAuthDialOptions:()=>({})},
  './KnowledgeAuditService':{recordKnowledgeGet:async(_req: unknown, event: unknown)=>{audits.push(event)}},
 };
 jest.resetModules();
 for (const [specifier, exports] of Object.entries(modules)) {
  const target = specifier.startsWith('./') ? '../services/' + specifier.slice(2) : specifier;
  jest.doMock(target, () => exports);
 }
 const {executeKnowledgeGet} = require('../services/KnowledgeGetExecutor');
 const result=await executeKnowledgeGet({}, {handle:'opaque-fixture',...input},{issuer:'fixture'});
 return {result,audits,calls};
}

for(const[title,answer]of [
 ['wrong protocol',{protocol_version:1,status:'content',content:'PRIVATE-RESPONSE'}],
 ['unsolicited notModified',{protocol_version:2,status:'notModified'}],
])test(title+' refuses and records exactly one terminal audit',async()=>{
 const{result,audits,calls}=await run(answer);
 assert.equal(result.ok,false);assert.equal(result.code,'source_protocol_error');
 assert.equal(audits.length,1);assert.equal(audits[0].outcome,'source_response_invalid');
 assert.equal(audits[0].auditRef,result.auditRef);assert.equal(audits[0].sourceId,'fixture-source');
 assert.deepEqual(calls,['dial']);
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('requested notModified remains successful with one audit',async()=>{
 const{result,audits}=await run({protocol_version:2,status:'notModified'},{ifNoneMatch:'a'.repeat(64)});
 assert.equal(result.ok,true);assert.equal(result.status,'notModified');
 assert.equal(audits.length,1);assert.equal(audits[0].outcome,'not_modified');
});
test('source refusal remains audited once',async()=>{
 const{result,audits}=await run({protocol_version:2,status:'refused',code:'private-reason'});
 assert.equal(result.ok,false);assert.equal(result.code,'refused');
 assert.equal(audits.length,1);assert.equal(audits[0].outcome,'source_refused');
 assert.ok(!JSON.stringify(result).includes('private-reason'));
});
test('invalid content shape remains audited once',async()=>{
 const{result,audits}=await run({protocol_version:2,status:'content'});
 assert.equal(result.ok,false);assert.equal(audits.length,1);
 assert.equal(audits[0].outcome,'source_protocol_error');
});
test('authorization exclusion never dials and retains concealed outcome',async()=>{
 const{result,audits,calls}=await run({protocol_version:1}, {}, false);
 assert.equal(result.ok,false);assert.equal(result.code,'refused');
 assert.deepEqual(calls,[]);assert.equal(audits.length,1);
 assert.equal(audits[0].outcome,'not_authorized');
});
