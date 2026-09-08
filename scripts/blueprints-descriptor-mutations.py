#!/usr/bin/env python3
"""Pinned descriptor semantics: copied-source, exact assertion failure sets."""
import argparse,hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--output-dir',type=Path,required=True);args=parser.parse_args()
root=Path(__file__).resolve().parents[1];backend=root/'backend';out=args.output_dir.resolve();out.mkdir(parents=True,exist_ok=False)
plan='src/services/BlueprintPlanService.ts';doc='src/utils/blueprintDocument.ts';test='src/__tests__/blueprintDescriptor.test.ts'
def inventory():
 return {str(p.relative_to(backend)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (backend/'src').rglob('*') if p.is_file()}
original=inventory();env={k:v for k,v in os.environ.items() if not k.startswith(('DB_','PG')) and k not in ['DATABASE_URL','RELAYHALL_TEST_DB_URL']};env.update(DB_HOST='127.0.0.1',DB_PORT='59999',DB_NAME='blueprint_refused',DB_USER='refused',DB_PASSWORD='refused',NODE_ENV='test',FORCE_COLOR='0',NO_COLOR='1')
controls=[
 ('pin-cache-alias',plan,'=> `${id}:${version}`;','=> { void version; return id; };',['preview observations of two immutable pins']),
 ('enum-is-string',plan,"const declared = descriptor.options.find(option => option.key === key);\n          if (declared?.type !== 'string')","const declared = descriptor.options.find(option => option.key === key);\n          if (!declared || !['string','enum'].includes(declared.type))",['descriptor type enum forbids']),
 ('recursive-inserted-text',plan,'options[key] = substituteBlueprintText(value, values);','options[key] = substituteBlueprintText(substituteBlueprintText(value, values), values);',['shared plan uses the resolved pin']),
 ('wrong-pin',plan,'normalizeConnectorProfileOptions({ options, parameters }, service.id, service.version, descriptor)','normalizeConnectorProfileOptions({ options, parameters }, service.id, 1, descriptor)',['shared plan uses the resolved pin','preview observations of two immutable pins']),
 ('canonical-validator-skipped',plan,'executionProfile = normalizeConnectorProfileOptions({ options, parameters }, service.id, service.version, descriptor);','void normalizeConnectorProfileOptions; executionProfile = { serviceId: service.id, descriptorVersion: service.version, options };',['literal non-string options still use canonical','nested Connector parameter strings round-trip']),
 ('plain-service-execution',plan,"resolvedDescriptor && resolvedDescriptor.kind !== 'connector'",'false',['plain Services cannot become execution']),
 ('option-field-name',doc,"if (Object.keys(e.options).some(key => /\\{\\{|\\}\\}/.test(key))) fail('executionProfile.options', 'Substitution is not allowed in field names');",'/* mutation: field names unvalidated */',['placeholder field names are refused']),
]
receipt={'sourceSha256':original,'controls':[]}
with tempfile.TemporaryDirectory(prefix='rh-blueprint-descriptor-') as tmp:
 copied=Path(tmp)/'backend';shutil.copytree(backend,copied,ignore=shutil.ignore_patterns('node_modules','dist','coverage','.env*','*.log'));(copied/'node_modules').symlink_to((backend/'node_modules').resolve(),target_is_directory=True)
 bases={name:(copied/name).read_bytes() for name in [plan,doc]}
 def run(label):
  result=out/(label+'.json')
  with (out/(label+'.log')).open('w') as log:
   process=subprocess.run(['node',str(copied/'node_modules/jest/bin/jest.js'),'--runInBand','--runTestsByPath',test,'--json','--outputFile='+str(result)],cwd=copied,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=120)
  data=json.loads(result.read_text());assert data['numTotalTests']==20,label+': compile/import/test count'
  assertions=[a for suite in data['testResults'] for a in suite['assertionResults']];assert len(assertions)==20 and all(a['status'] in ['passed','failed'] for a in assertions)
  return process.returncode,sorted(a['fullName'] for a in assertions if a['status']=='failed'),[a['fullName'] for a in assertions]
 code,bad,names=run('baseline');assert code==0 and not bad
 try:
  for label,file,before,after,selectors in controls:
   s=(copied/file).read_text();assert s.count(before)==1,label+': anchor'
   expected=sorted(name for name in names if any(selector in name for selector in selectors));assert len(expected)==(2 if label in ['wrong-pin','canonical-validator-skipped'] else 1),label+': selector'
   (copied/file).write_text(s.replace(before,after,1));code,bad,_=run(label)
   row={'name':label,'expected':expected,'actual':bad,'returncode':code,'pass':code!=0 and bad==expected};receipt['controls'].append(row);(out/'receipt.json').write_text(json.dumps(receipt,indent=2));assert row['pass'],label+': unexpected red'
   for name,data in bases.items():(copied/name).write_bytes(data)
   print(label+': exact semantic RED and bytes restored',flush=True)
  code,bad,_=run('restored');assert code==0 and not bad
 finally:
  for name,data in bases.items():(copied/name).write_bytes(data)
  receipt['liveSourceUnchanged']=inventory()==original;assert receipt['liveSourceUnchanged']
receipt.update(baseline=20,restored=20,copyRemoved=True);(out/'receipt.json').write_text(json.dumps(receipt,indent=2));print('PASS descriptor20 and seven exact semantic controls',flush=True)