#!/usr/bin/env python3
"""Run Blueprint census red proofs on a private source copy, never live files.

Only the census test imports execute (fs/path/TypeScript). Production sources are
parsed as text; no production module, database, migration, browser or Git runs.
"""
import argparse,datetime,hashlib,json,os,pathlib,shutil,subprocess,sys
p=argparse.ArgumentParser();p.add_argument('--root',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);p.add_argument('--control',action='append');args=p.parse_args()
root=args.root.resolve();out=args.output.resolve()
assert root.is_dir() and (root/'backend/src/services/BlueprintInstantiationService.ts').is_file()
assert root!=out and root not in out.parents and out not in root.parents,'Output must be outside the live tree'
out.mkdir(parents=True,exist_ok=False);tree=out/'source-copy';tree.mkdir()
digest=lambda data:hashlib.sha256(data).hexdigest()
copied={};receipts=[]
inst='backend/src/services/BlueprintInstantiationService.ts'
cases=[
 ('d2-direct-sql',inst,None,"\nvoid pool.query(\"INSERT INTO tasks(title) VALUES ('Census fixture')\");\n",'D2 canonical imports and no direct work-plane SQL'),
 ('d5-forbidden-service',inst,None,"\nimport {grantService} from './GrantService';\nvoid grantService.create({} as never,null);\n",'D5 exact admitted service and helper call identities'),
 ('d8-propagation-route','backend/src/routes/blueprints.ts',None,"\nrouter.post('/blueprints/:blueprintId/instances/:instanceId/update',(_req,res)=>{res.json({success:true});});\n",'D8 route whole production corpus excludes propagation carriers'),
 ('d8-backend-reader','backend/src/utils/blueprintProvenance.ts',None,"\nimport {pool} from '../db/connection';\nexport async function censusProvenanceReader(id:string){return pool.query('SELECT document FROM blueprint_versions WHERE id=$1',[id]);}\n",'D8 reader whole production corpus excludes postcommit Blueprint bodies'),
 ('d8-frontend-reader','frontend/src/components/projects/ProjectDetailModal.tsx',None,"\nexport async function censusProvenanceReader(id:string){return fetch('/api/blueprints/'+encodeURIComponent(id));}\n",'D8 reader whole production corpus excludes postcommit Blueprint bodies'),
 ('d16-second-builder',inst,'const plan = await buildBlueprintPlan(version.document, input.parameterValues, this.registry.bodyConfiguration,',"const plan = await (async (..._args: Parameters<typeof buildBlueprintPlan>) => ({target:{mode:'new-project' as const},project:null,phases:[],tasks:[],reports:[],dependencies:[],references:[],authority:[],humanGates:[],counts:{},parameterValues:{},refusals:[]}))(version.document, input.parameterValues, this.registry.bodyConfiguration,",'D16 each entry point uses exactly the shared plan builder'),
]
known={c[0] for c in cases};assert not args.control or set(args.control)<=known,'Unknown control'
def copy(relative):
 source=root/relative;data=source.read_bytes();target=tree/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data);copied[str(relative)]=digest(data)
def invoke(label,selector=None):
 report=out/(label+'.json');log=out/(label+'.log');env=os.environ.copy()
 for key in ['DB_HOST','DB_NAME','DB_USER','DB_PASSWORD','DB_PORT','RELAYHALL_TEST_DB_URL']:env.pop(key,None)
 env['NODE_ENV']='test'
 cmd=['node',str(root/'backend/node_modules/jest/bin/jest.js'),'--runInBand','--runTestsByPath','src/__tests__/blueprintCensus.test.ts','--json','--outputFile',str(report)]
 if selector:cmd.extend(['--testNamePattern',selector])
 with log.open('w') as output:process=subprocess.run(cmd,cwd=tree/'backend',env=env,stdout=output,stderr=subprocess.STDOUT,timeout=120)
 assert report.exists(),f'{label}: no structured Jest result (not a red proof)'
 result=json.loads(report.read_text());failures=[a for suite in result.get('testResults',[]) for a in suite.get('assertionResults',[]) if a.get('status')=='failed']
 return process.returncode,result,failures
try:
 for surface in ['backend/src','frontend/src']:
  for source in sorted((root/surface).rglob('*')):
   if not source.is_file() or not source.suffix in ['.ts','.tsx']:continue
   relative=source.relative_to(root)
   if '__tests__' in source.parts:continue
   if source.name.endswith(('.test.ts','.test.tsx','.spec.ts','.spec.tsx')):continue
   copy(relative)
 for relative in ['backend/src/__tests__/blueprintCensus.test.ts','backend/src/__tests__/helpers/blueprintCensus.ts','backend/jest.config.js','backend/tsconfig.json']:copy(pathlib.Path(relative))
 for source in (root/'backend/src/__tests__/fixtures/blueprint-census').rglob('*'):
  if source.is_file():copy(source.relative_to(root))
 (tree/'backend/node_modules').symlink_to((root/'backend/node_modules').resolve(),target_is_directory=True)
 (out/'snapshot.json').write_text(json.dumps({'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'root':str(root),'sha256':copied},indent=2))
 rc,result,failures=invoke('baseline');assert rc==0 and result.get('numPassedTests',0)>=40 and not failures,'Census baseline must pass before mutation'
 for name,relative,needle,replacement,selector in cases:
  if args.control and name not in args.control:continue
  file=tree/relative;original=file.read_bytes();text=original.decode();receipt={'control':name,'file':relative,'selector':selector,'beforeSha256':digest(original)}
  try:
   if needle:
    assert text.count(needle)==1,(name,'mutation anchor must be unique')
    changed=text.replace(needle,replacement,1)
    # A separate inline plan-construction body, not an unresolved symbol or
    # alias of the canonical export. One replacement edit at the call site.
   else:changed=text+replacement
   file.write_text(changed);receipt['mutatedSha256']=digest(file.read_bytes())
   rc,result,failures=invoke(name,selector)
   receipt.update(exit=rc,failedTests=result.get('numFailedTests'),assertions=[{'name':a.get('fullName'),'messages':a.get('failureMessages')} for a in failures])
   receipt['red']=rc!=0 and len(failures)==1 and selector in failures[0].get('fullName','') and bool(failures[0].get('failureMessages'))
   assert receipt['red'],f'{name}: missing intended assertion failure (compiler/process errors do not count)'
  finally:
   file.write_bytes(original);receipt['restoredSha256']=digest(file.read_bytes());receipt['restored']=receipt['restoredSha256']==receipt['beforeSha256'];receipts.append(receipt)
   (out/'summary.json').write_text(json.dumps(receipts,indent=2));assert receipt['restored']
  print(name,'RED intended assertion; copy restored',flush=True)
 rc,result,failures=invoke('restored-green');assert rc==0 and not failures,'Restored copy must pass'
 drift=[{'file':relative,'before':before,'after':digest((root/relative).read_bytes()) if (root/relative).exists() else None} for relative,before in copied.items() if not (root/relative).exists() or digest((root/relative).read_bytes())!=before]
 additions=[]
 for surface in ['backend/src','frontend/src']:
  for source in (root/surface).rglob('*'):
   if source.is_file() and source.suffix in ['.ts','.tsx'] and '__tests__' not in source.parts and not source.name.endswith(('.test.ts','.test.tsx','.spec.ts','.spec.tsx')) and str(source.relative_to(root)) not in copied:additions.append(str(source.relative_to(root)))
 (out/'live-source-readback.json').write_text(json.dumps({'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'changed':drift,'added':additions,'currentEvidence':not drift and not additions},indent=2))
 assert not drift and not additions,'Live builders changed the scanned corpus: copy receipts are snapshot-only; refresh before claiming current evidence'
 print('PASS',len(receipts),'production-text mutations; live source never written and final fingerprints match',flush=True)
finally:
 assert tree.resolve()==out/'source-copy' and not tree.is_symlink()
 shutil.rmtree(tree)
