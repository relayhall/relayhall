#!/usr/bin/env python3
"""Three clean example installations, exact-name cleanup, local/CI profiles.

Only the local profile inspects the already-running owned Docker container.
Database operations use Node pg in both profiles. No container lifecycle acts.
Optional exporter mutation is confined to a disposable source copy.
"""
import argparse,datetime,hashlib,json,os,pathlib,shutil,subprocess,urllib.parse

NAMES={s:f'blueprint_examples_test_{s}_20260906' for s in 'abc'}
KEYS=['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD']
CONTAINER='rh-blueprints-codex-20260906-pg'
TEST='backend/src/__tests__/blueprintExamplesLive.test.ts'
EXPORTER='backend/src/services/BlueprintRegistryService.ts'
ANCHOR='return stableBlueprintJson(validateBlueprintDocument(result.document, this.bodyConfiguration));'
MUTANT="return stableBlueprintJson({...validateBlueprintDocument(result.document, this.bodyConfiguration), references: result.document.references.map((reference: Record<string,unknown>) => reference.kind === 'service' ? {...reference,name:'11111111-2222-4333-8444-555555555555'} : reference)});"

def admit(profile,config,ci):
 if profile not in ['local','ci'] or any(not isinstance(config.get(k),str) or not config[k] for k in KEYS):raise ValueError('EXAMPLE_CONFIG_REFUSED')
 identity=tuple(config[k] for k in KEYS[:4])
 expected=('127.0.0.1','55437','blueprints_contract_20260906','postgres') if profile=='local' else ('postgres','5432','relayhall_ci','relayhall_ci')
 if identity!=expected or profile=='ci' and ci!='true':raise ValueError('EXAMPLE_CONFIG_REFUSED')
 return {k:config[k] for k in KEYS}

def clean_environment(config):
 # Explicitly discard inherited PostgreSQL/deployment connection settings.
 result={k:v for k,v in os.environ.items() if not k.startswith(('DB_','PG','BLUEPRINT_EXAMPLE_')) and k not in ['DATABASE_URL','RELAYHALL_TEST_DB_URL','BOOT_CHECK']}
 result.update(config,NODE_ENV='test');return result

def self_test(root,out):
 local=dict(zip(KEYS,['127.0.0.1','55437','blueprints_contract_20260906','postgres','fixture-only']))
 ci=dict(zip(KEYS,['postgres','5432','relayhall_ci','relayhall_ci','fixture-only']))
 cases=[('local-exact','local',local,'',True),('ci-exact','ci',ci,'true',True),('unknown-profile','production',local,'',False),('ci-marker-missing','ci',ci,'',False)]
 for profile,config,marker in [('local',local,''),('ci',ci,'true')]:
  for key,value in [('DB_HOST','198.51.100.9'),('DB_HOST',''),('DB_PORT','5433'),('DB_NAME','relayhall_prod'),('DB_NAME',NAMES['a']),('DB_USER','root'),('DB_PASSWORD','')]:
   cases.append((profile+'-'+key+'-'+(value or 'missing'),profile,{**config,key:value},marker,False))
 receipts=[]
 for name,profile,config,marker,allowed in cases:
  try:admit(profile,config,marker);actual=True
  except ValueError as error:assert str(error)=='EXAMPLE_CONFIG_REFUSED';actual=False
  assert actual==allowed,name;receipts.append({'control':name,'allowed':actual})
 previous={k:os.environ.get(k) for k in ['DB_HOST','PGHOST','DATABASE_URL','RELAYHALL_TEST_DB_URL']}
 try:
  for k in previous:os.environ[k]='inherited-production-marker'
  sanitized=clean_environment(local)
  assert sanitized['DB_HOST']=='127.0.0.1' and all(k not in sanitized for k in ['PGHOST','DATABASE_URL','RELAYHALL_TEST_DB_URL'])
 finally:
  for k,v in previous.items():
   if v is None:os.environ.pop(k,None)
   else:os.environ[k]=v
 receipts.append({'control':'inherited-connection-settings-discarded','allowed':True})
 # Execute the ACTUAL test admission prefix, stopping before its first
 # production require. A different exception or forbidden require is a failure.
 source=(root/TEST).read_text();assert source.count("const express=require('express');")==1
 prefix=source.split("const express=require('express');")[0]
 url=lambda host,port,user,db:f'postgresql://{user}:fixture-only@{host}:{port}/{db}'
 base={'BLUEPRINT_EXAMPLE_STAGE':'a','BLUEPRINT_EXAMPLE_ARTIFACTS':str(out),'BLUEPRINT_EXAMPLE_PROFILE':'local','RELAYHALL_TEST_DB_URL':url('127.0.0.1','55437','postgres',NAMES['a'])}
 good_ci={**base,'BLUEPRINT_EXAMPLE_PROFILE':'ci','CI':'true','RELAYHALL_TEST_DB_URL':url('postgres','5432','relayhall_ci',NAMES['a'])}
 test_cases=[{'name':'test-local-exact','env':base,'allowed':True},{'name':'test-ci-exact','env':good_ci,'allowed':True}]
 for name,changes in [('missing-url',{'RELAYHALL_TEST_DB_URL':''}),('invalid-url',{'RELAYHALL_TEST_DB_URL':'nonsense'}),('profile-missing',{'BLUEPRINT_EXAMPLE_PROFILE':''}),('wrong-stage',{'BLUEPRINT_EXAMPLE_STAGE':'b'}),('unknown-stage',{'BLUEPRINT_EXAMPLE_STAGE':'z'}),('relative-output',{'BLUEPRINT_EXAMPLE_ARTIFACTS':'relative'}),('deployment-db',{'RELAYHALL_TEST_DB_URL':url('127.0.0.1','55437','postgres','relayhall_prod')}),('contract-db',{'RELAYHALL_TEST_DB_URL':url('127.0.0.1','55437','postgres','blueprints_contract_20260906')}),('remote-host',{'RELAYHALL_TEST_DB_URL':url('198.51.100.9','55437','postgres',NAMES['a'])}),('query-override',{'RELAYHALL_TEST_DB_URL':base['RELAYHALL_TEST_DB_URL']+'?host=production'})]:test_cases.append({'name':'test-'+name,'env':{**base,**changes},'allowed':False})
 test_cases.append({'name':'test-ci-marker-missing','env':{**good_ci,'CI':''},'allowed':False})
 program=r"""const fs=require('fs'),vm=require('vm'),ts=require('typescript');const input=JSON.parse(fs.readFileSync(0,'utf8'));const compiled=ts.transpileModule(input.source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true},reportDiagnostics:true});if(compiled.diagnostics.some(d=>d.category===ts.DiagnosticCategory.Error))throw Error('Admission prefix did not compile');const receipts=[];for(const item of input.cases){let allowed=true;try{vm.runInNewContext(compiled.outputText,{exports:{},URL,process:{env:{...item.env}},require:(name)=>{if(!['http','crypto','fs','path'].includes(name))throw Error('Forbidden module load: '+name);return require(name)}})}catch(error){if(!String(error.message).startsWith('EXAMPLE_CONFIG_REFUSED:'))throw error;allowed=false}if(allowed!==item.allowed)throw Error('Admission mismatch: '+item.name);receipts.push({control:item.name,allowed})}process.stdout.write(JSON.stringify(receipts));"""
 result=subprocess.run(['node','-e',program],cwd=root/'backend',input=json.dumps({'source':prefix,'cases':test_cases}),text=True,capture_output=True,timeout=30)
 (out/'test-admission.log').write_text(result.stderr);assert result.returncode==0,'Actual test admission prefix failed (see isolated log)'
 receipts.extend(json.loads(result.stdout));(out/'config-controls.json').write_text(json.dumps(receipts,indent=2))
 print('PASS',len(receipts),'non-DB configuration controls; no production module or connection opened',flush=True)

def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);p.add_argument('--profile',choices=['local','ci']);p.add_argument('--env-file',type=pathlib.Path);p.add_argument('--self-test',action='store_true');p.add_argument('--with-exporter-mutation',action='store_true');args=p.parse_args()
 root=args.root.resolve();out=args.output.resolve();assert (root/TEST).is_file()
 assert root!=out and root not in out.parents and out not in root.parents
 out.mkdir(parents=True,exist_ok=False)
 if args.self_test:self_test(root,out);return
 if args.profile=='local':
  assert args.env_file and args.env_file.is_file(),'Local profile requires explicit owner fixture env file'
  config=admit('local',json.loads(args.env_file.read_text()),os.environ.get('CI'))
  inspection=json.loads(subprocess.check_output(['docker','inspect',CONTAINER],text=True))[0]
  assert inspection['State']['Running'] and inspection['Config'].get('Labels',{}).get('owner')=='blueprints-codex-20260906','Owner must provide its running fixture container'
  assert inspection['NetworkSettings']['Ports'].get('5432/tcp')==[{'HostIp':'127.0.0.1','HostPort':'55437'}],'Unexpected fixture binding'
 else:
  assert args.profile=='ci' and args.env_file is None,'Explicit profile required; CI cannot load a local env file'
  config=admit('ci',{k:os.environ.get(k) for k in KEYS},os.environ.get('CI'))
 base_env=clean_environment(config)
 manifest={'profile':args.profile,'created':[],'dropped':[],'cleanupErrors':[]}
 current=set();receipts=[];copy=out/'source-copy'
 def record():
  manifest['currentlyOwned']=sorted(current);manifest['updatedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'database-manifest.json').write_text(json.dumps(manifest,indent=2))
 def sql(statement,params=None):
  program="const fs=require('fs'),{Client}=require('pg');const input=JSON.parse(fs.readFileSync(0,'utf8'));const client=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),database:'postgres',user:process.env.DB_USER,password:process.env.DB_PASSWORD});(async()=>{await client.connect();try{const r=await client.query(input.sql,input.params);process.stdout.write(JSON.stringify(r.rows))}finally{await client.end()}})().catch(e=>{console.error('Fixture admin SQL failed:',e.code||e.name);process.exit(1)});"
  result=subprocess.run(['node','-e',program],cwd=root/'backend',env=base_env,input=json.dumps({'sql':statement,'params':params or []}),text=True,capture_output=True,timeout=30)
  assert result.returncode==0,'Fixture admin SQL failed (no deployment fallback)';return json.loads(result.stdout)
 def fingerprints():
  files=list((root/'backend/src').rglob('*'))+list((root/'backend/scripts').rglob('*'))+list((root/'docs/blueprints/examples').glob('*.json'))+[root/f for f in ['database/init.sql','backend/package.json','backend/package-lock.json','backend/jest.config.js','backend/tsconfig.json','scripts/blueprints-examples-live.py']]
  return {str(f.relative_to(root)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(set(files)) if f.is_file() and ('__tests__' not in f.parts or f.name=='blueprintExamplesLive.test.ts')}
 def run(label,command,env,folder,timeout=180):
  with (folder/(label+'.log')).open('wb') as log:result=subprocess.run(command,cwd=copy/'backend',env=env,stdout=log,stderr=subprocess.STDOUT,timeout=timeout)
  return result.returncode
 def cleanup(label):
  for name in sorted(current,reverse=True):
   try:
    assert name in NAMES.values() and any(r['database']==name for r in manifest['created'])
    sql('DROP DATABASE "'+name+'" WITH (FORCE)');current.remove(name);manifest['dropped'].append({'database':name,'scenario':label});record()
   except Exception as error:manifest['cleanupErrors'].append({'database':name,'errorType':type(error).__name__});record()
  if current:raise RuntimeError('Owned DB cleanup incomplete; see exact-name manifest')
 def scenario(label,stages,mutation=False):
  folder=out/label;folder.mkdir()
  try:
   for name in NAMES.values():assert sql('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1',[name])[0]['n']==0,'Example DB already exists; refuse rather than adopt'
   for stage in stages:
    name=NAMES[stage];sql('CREATE DATABASE "'+name+'" TEMPLATE template0');current.add(name);manifest['created'].append({'database':name,'scenario':label});record()
    env={**base_env,'DB_NAME':name,'BLUEPRINT_EXAMPLE_STAGE':stage,'BLUEPRINT_EXAMPLE_PROFILE':args.profile,'BLUEPRINT_EXAMPLE_ARTIFACTS':str(folder)}
    env['RELAYHALL_TEST_DB_URL']='postgresql://'+urllib.parse.quote(config['DB_USER'],safe='')+':'+urllib.parse.quote(config['DB_PASSWORD'],safe='')+'@'+config['DB_HOST']+':'+config['DB_PORT']+'/'+name
    assert run(stage+'-init',['node','scripts/load-base-schema.js'],env,folder)==0,'Fixture schema initialization failed'
    assert run(stage+'-migrate',['npm','run','migrate'],env,folder)==0,'Fixture migration failed'
    report=folder/(stage+'-jest.json');rc=run(stage+'-tests',['node','node_modules/jest/bin/jest.js','--runInBand','--testPathIgnorePatterns=/node_modules/','--runTestsByPath','src/__tests__/blueprintExamplesLive.test.ts','--json','--outputFile',str(report)],env,folder)
    assert report.is_file(),'No structured Jest assertions (not evidence)';result=json.loads(report.read_text());failed=[a for suite in result.get('testResults',[]) for a in suite.get('assertionResults',[]) if a.get('status')=='failed']
    receipt={'scenario':label,'stage':stage,'passed':result.get('numPassedTests'),'failed':result.get('numFailedTests')}
    if mutation:
     expected={'three-installation actual Blueprint example round trips '+n+' origin publishes, exports portable bytes and stores exact ordinary graph' for n in ['governed-deployment','incident-investigation']}
     assert rc!=0 and result.get('numPassedTests')==1 and result.get('numFailedTests')==2 and {a.get('fullName') for a in failed}==expected,'Exporter mutation did not fail its exact two portable-export assertions'
     assert all('11111111-2222-4333-8444-555555555555' in ''.join(a.get('failureMessages',[])) and 'toBe' in ''.join(a.get('failureMessages',[])) for a in failed),'Missing semantic exporter diagnostics'
     receipt['redAssertions']=[{'name':a['fullName'],'messages':a['failureMessages']} for a in failed]
    else:
     assert rc==0 and result.get('success') and result.get('numPassedTests')=={'a':3,'b':4,'c':2}[stage] and not failed,'Example baseline/restored assertions must pass'
    receipts.append(receipt);(out/'test-receipts.json').write_text(json.dumps(receipts,indent=2));print(label,stage,receipt['passed'],'PASS',receipt['failed'],'intended RED' if mutation else 'FAIL',flush=True)
  finally:cleanup(label)
 record();before=fingerprints();(out/'source-snapshot.json').write_text(json.dumps(before,indent=2))
 try:
  copy.mkdir();(copy/'backend').mkdir()
  shutil.copytree(root/'backend/src',copy/'backend/src',ignore=shutil.ignore_patterns('__tests__','*.test.ts','*.spec.ts'))
  (copy/pathlib.Path(TEST).parent).mkdir(parents=True);shutil.copy2(root/TEST,copy/TEST)
  shutil.copytree(root/'backend/scripts',copy/'backend/scripts')
  for name in ['package.json','package-lock.json','jest.config.js','tsconfig.json']:shutil.copy2(root/'backend'/name,copy/'backend'/name)
  (copy/'backend/node_modules').symlink_to((root/'backend/node_modules').resolve(),target_is_directory=True)
  (copy/'database').mkdir();shutil.copy2(root/'database/init.sql',copy/'database/init.sql')
  shutil.copytree(root/'docs/blueprints/examples',copy/'docs/blueprints/examples')
  scenario('baseline','abc')
  if args.with_exporter_mutation:
   file=copy/EXPORTER;original=file.read_bytes();text=original.decode();assert text.count(ANCHOR)==1,'Exporter mutation anchor must be unique'
   mutation={'file':EXPORTER,'beforeSha256':hashlib.sha256(original).hexdigest(),'scope':'Exported optional Service name replaced with a synthetic installation UUID on copied source; no available-Service instantiation claim'}
   try:
    file.write_text(text.replace(ANCHOR,MUTANT));mutation['mutatedSha256']=hashlib.sha256(file.read_bytes()).hexdigest();scenario('exporter-mutant','a',True)
   finally:
    file.write_bytes(original);mutation['restoredSha256']=hashlib.sha256(file.read_bytes()).hexdigest();(out/'exporter-mutation.json').write_text(json.dumps(mutation,indent=2));assert mutation['restoredSha256']==mutation['beforeSha256']
   scenario('exporter-restored','a')
  after=fingerprints();drift=[k for k in sorted(set(before)|set(after)) if before.get(k)!=after.get(k)]
  (out/'source-readback.json').write_text(json.dumps({'changed':drift,'currentEvidence':not drift},indent=2));assert not drift,'Source changed; receipts are snapshot-only'
  (out/'summary.json').write_text(json.dumps({'profile':args.profile,'receipts':receipts,'sourceUnchanged':True,'humanAcceptance':False,'agentInterview':False,'availableHermesSuccess':False,'ciProfile':args.profile=='ci'},indent=2))
 finally:
  if current:cleanup('outer-finally')
  assert copy.resolve()==out/'source-copy' and not copy.is_symlink()
  if copy.exists():shutil.rmtree(copy)
 print('PASS examples; all successfully created DBs dropped and private source copy removed; shared PostgreSQL lifecycle untouched',flush=True)

if __name__=='__main__':main()
