import hashlib,json,os,shlex,subprocess
from pathlib import Path
import argparse
from urllib.parse import urlsplit

parser=argparse.ArgumentParser(description='LENSES-b round-three production mutation controls; disposable PostgreSQL required.')
parser.add_argument('--output-dir', required=True, help='Owned scratch directory for JSON and logs')
args=parser.parse_args()
r=Path(__file__).resolve().parents[2]
s=Path(args.output_dir).resolve();s.mkdir(parents=True,exist_ok=True)
env=os.environ.copy();env.pop('PGOPTIONS',None)
url=urlsplit(env.get('RELAYHALL_TEST_DB_URL',''))
if url.hostname not in ('127.0.0.1','localhost') or not url.path.removeprefix('/').startswith('relayhall_lenses_b_test'):
 raise SystemExit('Explicit loopback relayhall_lenses_b_test disposable database required')
hg='backend/src/services/HomeGroupService.ts';route='backend/src/routes/principals.ts';migration='backend/src/migrations/128_lenses_featured_home_group_grant_origin.sql'
tests={
 'operator':'an operator login cannot set another Account home pointer',
 'inactive':'an inactive target is refused even for a root session',
 'set':'set commits first: the production acts leave no offboarded pointer',
 'terminate':'terminate commits first: the production acts leave no offboarded pointer',
 'absent':'migration refuses an absent provenance constraint',
 'unvalidated':'migration refuses an unvalidated provenance constraint',
}
mutations=[
 ('R3-lock',hg,"'SELECT id, status FROM principals WHERE id = $1 FOR SHARE', [accountPrincipalId]","'SELECT id, status FROM principals WHERE id = $1', [accountPrincipalId]",{'set','terminate'}),
 ('R3-active',hg,"if (account.rows.length === 0 || account.rows[0].status !== 'active') {","if (false && (account.rows.length === 0 || account.rows[0].status !== 'active')) {",{'inactive','terminate'}),
 ('R3-root',route,"if (!req.scopes?.includes('root')) {","if (false && !req.scopes?.includes('root')) {",{'operator'}),
 ('R3-exists',migration,"  IF NOT EXISTS (\n    SELECT 1 FROM pg_constraint c\n     WHERE c.conrelid = 'grants'::regclass","  IF FALSE AND NOT EXISTS (\n    SELECT 1 FROM pg_constraint c\n     WHERE c.conrelid = 'grants'::regclass",{'absent','unvalidated'}),
 ('R3-validated',migration,'       AND c.convalidated','       AND (c.convalidated OR true)',{'unvalidated'}),
]
receipt=[]
def run(label):
 result=s/(label+'.json')
 if result.exists():result.unlink()
 with (s/(label+'.log')).open('w') as log:
  p=subprocess.run(['node','node_modules/jest/bin/jest.js','--runInBand','--testPathIgnorePatterns=/node_modules/','--runTestsByPath','src/__tests__/lensesCreationDefaultLive.test.ts','--testNamePattern=round-three','--json','--outputFile='+str(result)],cwd=r/'backend',env=env,stdout=log,stderr=subprocess.STDOUT,timeout=150)
 assert result.exists(),label+' produced no assertion receipt'
 data=json.loads(result.read_text())
 executed=[a for suite in data['testResults'] for a in suite['assertionResults'] if a['status'] in ('passed','failed')]
 assert len(executed)==6,label+' did not execute all six assertions'
 failed={a['title'] for a in executed if a['status']=='failed'}
 assert (p.returncode==0)==(not failed),label+' runner failure is not an assertion failure'
 return failed
assert not run('round3-drill-baseline')
for label,name,before,after,expected in mutations:
 path=r/name;original=path.read_bytes();source=original.decode();assert source.count(before)==1,label+' anchor mismatch'
 try:
  path.write_text(source.replace(before,after))
  failed=run(label)
  assert failed=={tests[key] for key in expected},(label,sorted(failed),sorted(tests[key] for key in expected))
  receipt.append({'mutation':label,'failed':sorted(failed),'source_sha256':hashlib.sha256(original).hexdigest()})
  print(label+' exact assertion set RED: '+str(len(failed)),flush=True)
 finally:
  path.write_bytes(original)
  assert path.read_bytes()==original
(s/'round3-drill-receipt.json').write_text(json.dumps(receipt,indent=2))
print('PASS: five independent production mutations; exact assertion sets; original bytes restored.',flush=True)
