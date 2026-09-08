#!/usr/bin/env python3
"""Prove the SCALE entry guards; these tests stop before any database connection."""
import argparse,json,os,subprocess
from pathlib import Path

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir',type=Path,required=True)
args=parser.parse_args();out=args.output_dir.resolve();out.mkdir(parents=True,exist_ok=True)
backend=Path(__file__).resolve().parents[1]
helper='scripts/scale-fixture-host.ts';seed='scripts/seed-scale-fixture.ts';suite='src/__tests__/scaleReadLoad.test.ts'
def names(labels,entries=('seed','live suite')):
 return {f'{entry} database entry guard {label}' for entry in entries for label in labels}
mutations=[
 ('ci-marker',helper,"ci === 'true'","ci !== 'never-ci'",names(['CI host outside CI','false CI marker','truthy non-CI marker'])),
 ('ci-database',helper,"database === 'relayhall_ci'","database !== ''",names(['CI host with nonfixture name','CI host with a local fixture name'])),
 ('ci-host',helper,"host === 'postgres'","host !== ''",names(['remote host in CI'])),
 ('ci-admission',helper,"host === 'postgres'","host === 'never-ci'",names(['CI fixture'])),
 ('local-admission',helper,"['localhost', '127.0.0.1', '::1']","['never-local']",names(['local fixture','localhost fixture'])),
 ('local-host-boundary',helper,"['localhost', '127.0.0.1', '::1'].includes(host)","host.length > 0",names(['CI host outside CI','false CI marker','truthy non-CI marker','CI host with nonfixture name','CI host with a local fixture name','remote host in CI','remote host outside CI'])),
 ('seed-deployment',seed,'if (FORBIDDEN_DATABASES.includes(dbName))','if (FORBIDDEN_DATABASES.includes(dbName) && false)',names(['deployment '+n for n in ['relayhall_dev','relayhall_tst','relayhall_prod','relayhall']]+['missing database'],('seed',))),
 ('suite-deployment',suite,'if (FORBIDDEN_DATABASES.includes(TEST_DB_NAME))','if (FORBIDDEN_DATABASES.includes(TEST_DB_NAME) && false)',names(['deployment '+n for n in ['relayhall_dev','relayhall_tst','relayhall_prod','relayhall']],('live suite',))),
 ('suite-database-required',suite,"if (!TEST_DB_NAME) throw new Error('The URL names no database name. Refusing to write.');", "if (TEST_DB_NAME === 'never-database') throw new Error('The URL names no database name. Refusing to write.');",names(['missing database'],('live suite',))),
]
env=os.environ.copy();env.pop('PGOPTIONS',None);env.pop('RELAYHALL_TEST_DB_URL',None)
env.update(DB_HOST='127.0.0.1',DB_PORT='59999',DB_NAME='relayhall_scale_guard_probe',DB_USER='scale_guard',DB_PASSWORD='scale_guard')
def run(label):
 receipt=out/(label+'.json')
 if receipt.exists():receipt.unlink()
 with (out/(label+'.log')).open('w') as log:
  code=subprocess.run(['node','node_modules/jest/bin/jest.js','--runInBand','--runTestsByPath','src/__tests__/scaleDatabaseGuard.test.ts','--json','--outputFile='+str(receipt)],cwd=backend,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=90).returncode
 assert receipt.exists(),label+' produced no assertion receipt'
 data=json.loads(receipt.read_text())
 assert data['numTotalTests']==30 and data['numPendingTests']==0,label+' did not execute30 tests'
 failed={a['fullName'] for t in data['testResults'] for a in t['assertionResults'] if a['status']=='failed'}
 assert (code==0)==(not failed),label+' runner failure is not an assertion failure'
 return failed
assert not run('baseline')
results=[]
for label,name,before,after,expected in mutations:
 path=backend/name;original=path.read_bytes();text=original.decode()
 assert text.count(before)==1,label+' anchor mismatch'
 try:
  path.write_text(text.replace(before,after));failed=run(label)
  assert failed==expected,(label,sorted(failed),sorted(expected))
  results.append({'mutation':label,'failed':sorted(failed)})
  print(label+' exact red set PASS '+str(len(failed)),flush=True)
 finally:path.write_bytes(original)
(out/'receipt.json').write_text(json.dumps(results,indent=2))
print('PASS nine source mutations; both real entry guards; source restored.',flush=True)
