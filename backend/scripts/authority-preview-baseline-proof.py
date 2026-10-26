"""Exact accepted-base SQL comparison and baseline-red visibility proof.
All source substitutions are owned here and restored in finally.
"""
from pathlib import Path
import subprocess, os, json, re
root=Path(__file__).resolve().parents[1]
base='ee7a31181c8d2b9c8f4ee35242c9cddc705c8dbf'
service=root/'src/services/AuthorizationService.ts'
old=root/'src/services/__p2dBaselineAuthorizationService.ts'
proof=root/'src/__tests__/__p2dBaselineSqlProof.test.ts'
baseline=subprocess.check_output(['git','show',base+':backend/src/services/AuthorizationService.ts'],cwd=root)
current=service.read_bytes()
oracle_file=root/'src/__tests__/AuthorizationService.test.ts'
current_oracle=oracle_file.read_bytes()
def run(name, args):
 p=subprocess.run(['node','node_modules/jest/bin/jest.js','--runInBand','--runTestsByPath',*args,'--testPathIgnorePatterns=/node_modules/','--silent'],cwd=root,env=os.environ,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=150)
 (root/('p2d-baseline-'+name+'.log')).write_text(p.stdout+p.stderr,encoding='utf-8')
 return p
try:
 old.write_bytes(baseline)
 proof.write_text('''
jest.mock('../db/connection',()=>({pool:{query:jest.fn(),connect:jest.fn()}}));
import {AuthorizationService as Old} from '../services/__p2dBaselineAuthorizationService';
import {AuthorizationService as Current, AUTHORIZATION_ACTIONS} from '../services/AuthorizationService';
import {authorizationRepository} from '../services/AuthorizationRepository';
const id='11111111-1111-4111-8111-111111111111',parent='22222222-2222-4222-8222-222222222222';
test('default SQL and every binding remain byte-exact to accepted ee7 across actions, shapes and chains',()=>{
 const actors:any[]=[
 {principalId:id,handle:'fixture',role:'user',authenticated:true,scopes:['tasks:read','tasks:write']},
 {principalId:id,handle:'fixture',role:'admin',authenticated:true,scopes:['root']},
 {principalId:id,handle:'fixture',role:'user',authenticated:false,scopes:[]},
 ...['service','agent'].flatMap(kind=>['parent',[],[{resourceType:'task',selectorForm:'exact',selectorIds:[id],verbs:['read','write']}]].map(objects=>({
 principalId:id,handle:'fixture',role:null,authenticated:true,scopes:['tasks:read','tasks:write'],delegation:{links:[
 {principalId:id,kind,role:null,parentPrincipalId:parent,boundTaskId:kind==='agent'?id:null,legacyIdentity:false,ownExpression:{scopes:'parent',objects}},
 {principalId:parent,kind:'human',role:'user',parentPrincipalId:null,boundTaskId:null,legacyIdentity:false,ownExpression:null}]} })))];
 const before=new Old(),after=new Current();
 for(const actor of actors)for(const action of AUTHORIZATION_ACTIONS)for(const type of ['task','phase','project','report','skill','personality','service'] as const){
  const shape=authorizationRepository.sqlResource(type).resource;
  expect(after.sqlCondition(actor,action,shape)).toEqual(before.sqlCondition(actor,action,shape));
 }
});
''',encoding='utf-8')
 comparison=run('sql-parity',['src/__tests__/__p2dBaselineSqlProof.test.ts'])
 if comparison.returncode: raise RuntimeError('Default SQL parity failed')
 service.write_bytes(baseline)
 oracle_file.write_bytes(subprocess.check_output(['git','show',base+':backend/src/__tests__/AuthorizationService.test.ts'],cwd=root))
 oracle=run('existing-oracle',['src/__tests__/AuthorizationService.test.ts'])
 print(json.dumps({'defaultSqlParity':comparison.returncode==0,'acceptedBaseExistingOracleExit':oracle.returncode}),flush=True)
finally:
 service.write_bytes(current)
 oracle_file.write_bytes(current_oracle)
 old.unlink(missing_ok=True);proof.unlink(missing_ok=True)

principal=root/'src/routes/principals.ts'
mint=root/'src/services/AgentMintService.ts'
saved={p:p.read_bytes() for p in [principal,mint]}
try:
 principal.write_bytes(subprocess.check_output(['git','show',base+':backend/src/routes/principals.ts'],cwd=root))
 red=run('visibility',['src/__tests__/authorityPreviewLive.test.ts','--testNamePattern=shows acting|assigned Connector|SELF MCP'])
 if red.returncode==0 or not re.search(r'expect\(received\)|Expected:',red.stdout+red.stderr) or re.search(r'error TS\d+',red.stdout+red.stderr): raise RuntimeError('Visibility baseline did not redden meaningfully')
 principal.write_bytes(saved[principal])
 mint.write_bytes(subprocess.check_output(['git','show',base+':backend/src/services/AgentMintService.ts'],cwd=root))
 audit=run('mint-context',['src/__tests__/authorityPreviewLive.test.ts','--testNamePattern=Agent context'])
 if audit.returncode==0 or 'derivedContext' not in audit.stdout+audit.stderr: raise RuntimeError('Mint audit baseline did not redden meaningfully')
 print(json.dumps({'visibilityBaselineRedExit':red.returncode,'mintContextBaselineRedExit':audit.returncode}),flush=True)
finally:
 for p,b in saved.items():p.write_bytes(b)
