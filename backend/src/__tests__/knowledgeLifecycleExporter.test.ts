import fs from 'fs';
import os from 'os';
import path from 'path';
jest.mock('../db/connection',()=>({pool:{connect:jest.fn()}}));
import crypto from 'crypto';
import {parseLifecycleJson,validateLifecycleConfig,createLifecyclePayload,signLifecyclePayload,LifecycleRows,nextLifecycleGeneration,atomicLifecycleWrite} from '../services/KnowledgeLifecycleExporter';
const id='11111111-1111-4111-8111-111111111111', account='22222222-2222-4222-8222-222222222222';
const config=()=>validateLifecycleConfig({enabled:true,sourceId:id,sourceConfigVersion:'v1',expectedServiceRevision:id,issuer:'relayhall-core',actorRef:'deployment-owner',accountIds:[account],projectIds:[],projectGrants:[],personalConsents:[],keyRef:'file:/etc/relayhall/key',kid:'lifecycle-1',outputPath:'/var/lib/relayhall/snapshot',generationPath:'/var/lib/relayhall/generation'});
const rows=():LifecycleRows=>({source:{id,slug:'brain',status:'published',retired_at:null,revision:id,knowledge_query_endpoint:'https://source.invalid/knowledge/search',knowledge_claims_mode:'asserted',knowledge_subject_mode:'direct',knowledge_relevant_groups:[],descriptor:{knowledgeSource:{protocol_version:2,compartment_mode:'dynamic-opaque',contentKinds:['docs'],categories:['brain:note'],compartments:[]}}},accounts:[{id:account,display_name:'Example',handle:'example',status:'active',kind:'human'}],projects:[],groups:[]});
test('duplicate JSON keys and invalid eligibility fail closed',()=>{expect(()=>parseLifecycleJson('{"x":1,"x":2}')).toThrow();expect(parseLifecycleJson('{"x":[1,true]}')).toEqual({x:[1,true]});expect(()=>validateLifecycleConfig({...config(),accountIds:[account,account]})).toThrow();});
test('owner provisioning is independent from A21 and deactivation is explicit',()=>{const r=rows(); const p=createLifecyclePayload(config(),r,1,100);expect(p.accounts[0]).toMatchObject({id:account,assertion_sub:account,active:true});expect(p).not.toHaveProperty('visibility'); r.accounts[0].status='disabled';expect(createLifecyclePayload(config(),r,2,115).accounts[0].active).toBe(false);r.source.revision=account;expect(()=>createLifecyclePayload(config(),r,3,130)).toThrow();});
test('dedicated signed snapshot has bounded lifetime and exact wire header',()=>{const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');const p=createLifecyclePayload(config(),rows(),1,100);const jwt=signLifecyclePayload(p,privateKey,'lifecycle-1');const [h,b,s]=jwt.split('.');expect(JSON.parse(Buffer.from(h,'base64url').toString())).toEqual({alg:'EdDSA',typ:'rb-lifecycle-snapshot+jwt',kid:'lifecycle-1'});expect(crypto.verify(null,Buffer.from(h+'.'+b),publicKey,Buffer.from(s,'base64url'))).toBe(true);expect(p.exp-p.iat).toBe(60);});

test('durable generation survives a reload and refuses rollback/overflow',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lifecycle-test-'));
 try {const file=path.join(directory,'generation');atomicLifecycleWrite(file,JSON.stringify({generation:7,lastIat:100}));
 const state=JSON.parse(fs.readFileSync(file,'utf8'));expect(nextLifecycleGeneration(state,115)).toBe(8);
 expect(()=>nextLifecycleGeneration(state,89)).toThrow();expect(()=>nextLifecycleGeneration({generation:Number.MAX_SAFE_INTEGER,lastIat:100},115)).toThrow();
 atomicLifecycleWrite(file,JSON.stringify({generation:8,lastIat:115}));
 expect(nextLifecycleGeneration(JSON.parse(fs.readFileSync(file,'utf8')),130)).toBe(9);
 expect(fs.readdirSync(directory)).toEqual(['generation']);expect(fs.statSync(file).mode&0o777).toBe(0o600);
 } finally {fs.rmSync(directory,{recursive:true});}
});
test('a retired descriptor or unpublished Service cannot renew authority',()=>{
 for(const change of [{descriptor_retired_at:'now'},{status:'draft'}]){
 const r=rows();Object.assign(r.source,change);expect(()=>createLifecyclePayload(config(),r,1,100)).toThrow();
 }
});

const project='33333333-3333-4333-8333-333333333333', peer='44444444-4444-4444-8444-444444444444';
const dynamic=()=>validateLifecycleConfig({...config(),accountSelection:'all-human',projectSelection:'all-projects',accountIds:[],projectIds:[]});
test('dynamic modes are strictly typed and cannot mix with explicit arrays',()=>{
 for(const mode of [null,1,true,'all','',{}]) {
  expect(()=>validateLifecycleConfig({...config(),accountSelection:mode})).toThrow();
  expect(()=>validateLifecycleConfig({...config(),projectSelection:mode})).toThrow();
 }
 expect(()=>validateLifecycleConfig({...config(),accountSelection:'all-human'})).toThrow();
 expect(()=>validateLifecycleConfig({...config(),projectSelection:'all-projects',projectIds:[project]})).toThrow();
 expect(createLifecyclePayload(config(),{...rows(),accounts:[...rows().accounts,{...rows().accounts[0],id:peer}]},1,100).accounts).toHaveLength(1);
});
test('unchanged dynamic policy discovers future entities without implicit sharing',()=>{
 const c=dynamic(),r=rows();const before=JSON.stringify(c);
 expect(createLifecyclePayload(c,r,1,100).projects).toEqual([]);
 r.accounts.push({...r.accounts[0],id:peer,handle:'future',display_name:'Future'});
 r.projects.push({id:project,name:'Future project',status:'active'});
 const payload=createLifecyclePayload(c,r,2,115);
 expect(payload.accounts).toHaveLength(2);expect(payload.projects).toEqual([{id:project,label:'Future project',active:true,grants:[]}]);
 expect(payload.personal_consents).toEqual([]);expect(JSON.stringify(c)).toBe(before);
});
test('inactive and absent references disappear from policy, not the complete roster',()=>{
 const c=validateLifecycleConfig({...dynamic(),projectGrants:[{projectId:project,grants:[{subject_type:'user',subject_id:account,operation:'read',consent_ref:'grant-1'},{subject_type:'user',subject_id:peer,operation:'write',consent_ref:'grant-2'}]}],personalConsents:[{owner_id:account,reader_id:peer,consent_ref:'consent-1'}]});
 const r=rows();r.projects=[{id:project,name:'Project',status:'active'}];
 let p=createLifecyclePayload(c,r,1,100);expect(p.projects[0].grants).toHaveLength(1);expect(p.personal_consents).toEqual([]);
 r.accounts.push({...r.accounts[0],id:peer,status:'disabled'});
 p=createLifecyclePayload(c,r,2,115);expect(p.accounts[1].active).toBe(false);expect(p.projects[0].grants).toHaveLength(1);
 r.accounts[1].status='active';expect(createLifecyclePayload(c,r,3,130).personal_consents).toHaveLength(1);
 r.projects[0].status='archived';expect(createLifecyclePayload(c,r,4,145).projects[0].grants).toEqual([]);
});
test('combined dynamic roster overflow refuses the whole snapshot',()=>{
 const c=dynamic(),r=rows();
 r.accounts=Array.from({length:10000},(_,i)=>({...r.accounts[0],id:'55555555-5555-4555-8555-'+String(i).padStart(12,'0')}));
 expect(createLifecyclePayload(c,r,1,100).accounts).toHaveLength(10000);
 r.projects=[{id:project,name:'Overflow',status:'active'}];
 expect(()=>createLifecyclePayload(c,r,2,115)).toThrow();
});

// ── Card 549cc51f (E298, E299 F3): the shared-area writer list element ──
const outsider='66666666-6666-4666-8666-666666666666', service='77777777-7777-4777-8777-777777777777';
describe('shared_writers (card 549cc51f)', () => {
 test('the element is always present, organisation-scoped, sorted and unique; an absent list is empty',()=>{
  expect(createLifecyclePayload(config(),rows(),1,100).shared_writers).toEqual([{scope:'organisation',accounts:[]}]);
  const c=dynamic(),r=rows();r.accounts.push({...r.accounts[0],id:peer,handle:'peer',display_name:'Peer'});
  r.sharedWriters=[peer,account,peer];
  expect(createLifecyclePayload(c,r,1,100).shared_writers).toEqual([{scope:'organisation',accounts:[account,peer].sort()}]);
  // Equal inputs in any order sign equal bytes.
  const again={...r,sharedWriters:[account,peer]};
  expect(JSON.stringify(createLifecyclePayload(c,again,1,100))).toBe(JSON.stringify(createLifecyclePayload(c,r,1,100)));
 });
 test('THE E299 TEST: a listed Account outside the export selection does not deny the snapshot; the element omits it',()=>{
  // config() selects exactly one Account explicitly. `outsider` is on the list
  // but not in the selection, so it is not an exported Account at all.
  const r=rows();r.accounts.push({...r.accounts[0],id:outsider,handle:'outsider',display_name:'Outsider'});
  r.sharedWriters=[outsider,account];
  const payload=createLifecyclePayload(config(),r,1,100);
  expect(payload.accounts.map(a=>a.id)).toEqual([account]);
  expect(payload.shared_writers).toEqual([{scope:'organisation',accounts:[account]}]);
  // Only the outsider listed: still a snapshot, with an empty element.
  expect(createLifecyclePayload(config(),{...r,sharedWriters:[outsider]},2,115).shared_writers).toEqual([{scope:'organisation',accounts:[]}]);
 });
 test('only ACTIVE exported human Accounts are emitted: a disabled, a service and an unknown id are dropped',()=>{
  const c=dynamic(),r=rows();
  r.accounts.push({...r.accounts[0],id:peer,status:'disabled'});
  r.accounts.push({...r.accounts[0],id:service,kind:'service',handle:'svc'});
  r.sharedWriters=[account,peer,service,outsider];
  const payload=createLifecyclePayload(c,r,1,100);
  expect(payload.shared_writers).toEqual([{scope:'organisation',accounts:[account]}]);
  // The disabled Account is still in the roster (inactive), only not a writer.
  expect(payload.accounts.find(a=>a.id===peer)?.active).toBe(false);
  r.accounts[1].status='active';
  expect(createLifecyclePayload(c,r,2,115).shared_writers[0].accounts).toEqual([account,peer].sort());
 });
 test('the writer-list read cap: 10000 rows are carried, 10001 refuse the whole snapshot',()=>{
  const c=dynamic(),r=rows();
  r.sharedWriters=Array.from({length:10000},(_,i)=>'88888888-8888-4888-8888-'+String(i).padStart(12,'0'));
  expect(createLifecyclePayload(c,r,1,100).shared_writers[0].accounts).toEqual([]);
  r.sharedWriters.push('99999999-9999-4999-8999-999999999999');
  expect(()=>createLifecyclePayload(c,r,2,115)).toThrow('LIFECYCLE_EXPORT_REFUSED');
 });
 test('the schema version is unchanged: the element is additive under schema_version 1',()=>{
  expect(createLifecyclePayload(config(),{...rows(),sharedWriters:[account]},1,100).schema_version).toBe(1);
 });
});

// ── Card 502fb19e (E308; change-request design sections 7.2 and 7.3): the core tables ──
import {lifecycleImportReadBack,recordLifecycleSelection,lifecycleSelectionFor,lifecycleSelectionMisses} from '../services/KnowledgeLifecycleExporter';
const tableRow=(subject_type:'user'|'group',subject_id:string,operation:'read'|'write',consent_ref:string,approval_id:string|null=null)=>({project_id:project,subject_type,subject_id,operation,consent_ref,approval_id});
const group='88888888-8888-4888-8888-888888888888';
describe('the core tables replace the configuration rows (card 502fb19e)', () => {
 test('table rows are emitted in place of projectGrants, in canonical order, consent_ref preserved',()=>{
  const c=validateLifecycleConfig({...dynamic(),projectGrants:[{projectId:project,grants:[{subject_type:'user',subject_id:account,operation:'read',consent_ref:'config-only'}]}]});
  const r={...rows(),projects:[{id:project,name:'P',status:'active'}],accounts:[...rows().accounts,{...rows().accounts[0],id:peer}]};
  const fromTable=createLifecyclePayload(c,{...r,compartmentGrants:[tableRow('user',peer,'write','t-2','99999999-9999-4999-8999-999999999999'),tableRow('user',account,'read','t-1')]},1,100);
  expect(fromTable.projects[0].grants).toEqual([
   {subject_type:'user',subject_id:account,operation:'read',consent_ref:'t-1'},
   {subject_type:'user',subject_id:peer,operation:'write',consent_ref:'t-2'},
  ]);
  // Without table rows the configuration is read, as before the carry-over.
  expect(createLifecyclePayload(c,r,2,115).projects[0].grants).toEqual([{subject_type:'user',subject_id:account,operation:'read',consent_ref:'config-only'}]);
  // An empty table is an empty list, never a fall-back to the configuration.
  expect(createLifecyclePayload(c,{...r,compartmentGrants:[]},3,130).projects[0].grants).toEqual([]);
 });
 test('THE E299 F3 TEST for table rows: a non-exported user, a disabled user and an irrelevant Group are filtered, never shipped',()=>{
  const r={...rows(),projects:[{id:project,name:'P',status:'active'}],accounts:[...rows().accounts,{...rows().accounts[0],id:peer,status:'disabled'}]};
  const grants=[tableRow('user',account,'read','in'),tableRow('user',peer,'read','disabled'),tableRow('user',outsider,'read','outside'),tableRow('group',group,'read','group')];
  expect(createLifecyclePayload(config(),{...r,compartmentGrants:grants},1,100).projects).toEqual([]);
  const explicit=validateLifecycleConfig({...config(),projectIds:[project]});
  expect(createLifecyclePayload(explicit,{...r,compartmentGrants:grants},1,100).projects[0].grants.map((g:any)=>g.consent_ref)).toEqual(['in']);
  const relevant={...r,source:{...r.source,knowledge_relevant_groups:[group]},groups:[{id:group}]};
  expect(createLifecyclePayload(explicit,{...relevant,compartmentGrants:grants},2,115).projects[0].grants.map((g:any)=>g.consent_ref).sort()).toEqual(['group','in']);
 });
 test('personal consents from the table replace the configuration\'s and are filtered the same way',()=>{
  const c=validateLifecycleConfig({...dynamic(),personalConsents:[{owner_id:account,reader_id:peer,consent_ref:'config'}]});
  const r={...rows(),accounts:[...rows().accounts,{...rows().accounts[0],id:peer}]};
  expect(createLifecyclePayload(c,{...r,personalConsents:[{owner_id:peer,reader_id:account,consent_ref:'table'}]},1,100).personal_consents)
   .toEqual([{owner_id:peer,reader_id:account,consent_ref:'table'}]);
  expect(createLifecyclePayload(c,{...r,personalConsents:[{owner_id:outsider,reader_id:account,consent_ref:'x'}]},2,115).personal_consents).toEqual([]);
 });
 test('the read-back gives one digest for equal payloads in any order and refuses any difference',()=>{
  const p=(grants:any[],consents:any[]=[])=>({projects:[{id:project,grants}],personal_consents:consents}) as any;
  const a={subject_type:'user',subject_id:account,operation:'read',consent_ref:'a'},b={subject_type:'user',subject_id:peer,operation:'write',consent_ref:'b'};
  const one=lifecycleImportReadBack(p([a,b]),p([b,a]));
  expect(one).toEqual({digest:expect.stringMatching(/^[0-9a-f]{64}$/),rowCount:2});
  expect(lifecycleImportReadBack(p([b,a]),p([a,b])).digest).toBe(one.digest);
  for(const other of [p([a]),p([a,{...b,consent_ref:'c'}]),p([a,b],[{owner_id:account,reader_id:peer,consent_ref:'x'}])]){
   expect(()=>lifecycleImportReadBack(p([a,b]),other)).toThrow('LIFECYCLE_EXPORT_REFUSED');
  }
 });
 test('the recorded export selection names the Accounts and Projects outside it; the dynamic modes admit every one',()=>{
  recordLifecycleSelection(validateLifecycleConfig({...config(),projectIds:[project]}));
  const selection=lifecycleSelectionFor(id.toUpperCase());
  expect(selection).not.toBeNull();
  expect(lifecycleSelectionMisses(selection!,{accountIds:[account,peer],projectIds:[project,outsider]})).toEqual({accounts:[peer],projects:[outsider]});
  recordLifecycleSelection(dynamic());
  expect(lifecycleSelectionMisses(lifecycleSelectionFor(id)!,{accountIds:[peer],projectIds:[outsider]})).toEqual({accounts:[],projects:[]});
  expect(lifecycleSelectionFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBeNull();
 });
});
