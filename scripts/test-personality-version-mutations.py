#!/usr/bin/env python3
"""Focused Personality projection controls only; mock DB, never a live schema proof."""
from pathlib import Path
import argparse, hashlib, json, os, re, shutil, subprocess

ROOT = Path(__file__).resolve().parents[1]
TEST = 'src/__tests__/personalityVersion.test.ts'
PROJECT = 'immutable current Personality projection (schema-independent) '
WRITER = 'Personality writer current-version transaction boundary (mocked DB) '
CASES = [
    ('missing-version', 'src/utils/personalityVersion.ts',
     "  if (!Number.isInteger(current_version) || current_version < 1 || current_version > 2147483647\n      || current_version !== resolved_version || typeof row.id !== 'string'\n      || row.id !== version_parent_id) unavailable();", '',
     PROJECT + 'does not invent a version for undefined', ['did not throw']),
    ('snapshot-content-drift', 'src/utils/personalityVersion.ts',
     '          || version_snapshot[key] !== row[key]', '',
     PROJECT + 'rejects current/snapshot drift in content', ['did not throw']),
    ('initial-version', 'src/services/PersonalityService.ts',
     "      if (current && current.version !== 1) throw new Error('Personality creation omitted its initial immutable version');", '',
     WRITER + 'create refuses a valid but non-initial version and rolls back', ['resolved instead of rejected']),
    ('early-commit', 'src/services/PersonalityService.ts',
     "      const current = result.rows[0] ? await this.written(client, result.rows[0].id) : null;\n      if (current && current.version !== 1)",
     "      await client.query('COMMIT');\n      const current = result.rows[0] ? await this.written(client, result.rows[0].id) : null;\n      if (current && current.version !== 1)",
     WRITER + 'create checks immutable projection before same-client feed and COMMIT', ['COMMIT','version-read']),
]

def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def inputs():
    paths = list((ROOT/'backend/src').rglob('*')) + [ROOT/'backend'/n for n in ['package.json','package-lock.json','tsconfig.json','jest.config.js']]
    return {str(p.relative_to(ROOT)):digest(p) for p in paths if p.is_file()}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output-dir',required=True);args=parser.parse_args()
    out=Path(args.output_dir).resolve();out.mkdir(mode=0o700,parents=False,exist_ok=False)
    copy=out/'private-copy';backend=copy/'backend';backend.mkdir(parents=True)
    before=inputs(); receipt={'scope':'mocked nonmigration projection only','liveDatabaseProven':False,'scriptSha256':digest(Path(__file__)),'sourceBefore':before,'controls':[]}
    (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    env={k:v for k,v in os.environ.items() if not k.startswith('DB_') and k not in ['DATABASE_URL','RELAYHALL_TEST_DB_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD']}
    env.update({'DB_HOST':'127.0.0.1','DB_PORT':'59999','DB_NAME':'personality_no_db','DB_USER':'personality_no_db','DB_PASSWORD':'unused','NO_COLOR':'1','FORCE_COLOR':'0'})
    try:
        shutil.copytree(ROOT/'backend/src',backend/'src')
        for n in ['package.json','package-lock.json','tsconfig.json','jest.config.js']:shutil.copy2(ROOT/'backend'/n,backend/n)
        (backend/'node_modules').symlink_to((ROOT/'backend/node_modules').resolve(),target_is_directory=True)
        def run(name,selector=None):
            cmd=['node_modules/.bin/jest','--runInBand','--runTestsByPath',TEST,'--cacheDirectory',str(out/'jest-cache'),'--json','--outputFile',str(out/(name+'.json'))]
            if selector:cmd += ['--testNamePattern','^'+re.escape(selector)+'$']
            with (out/(name+'.log')).open('w') as log:code=subprocess.run(cmd,cwd=backend,env=env,stdout=log,stderr=subprocess.STDOUT).returncode
            result=json.loads((out/(name+'.json')).read_text());return code,result
        code,data=run('baseline');assert code==0 and data['numPassedTests']==39 and data['numFailedTests']==0,'Baseline refused'
        for name,relative,old,new,selector,tokens in CASES:
            p=backend/relative;original=p.read_bytes();text=original.decode();assert text.count(old)==1,(name,'anchor count')
            try:
                p.write_text(text.replace(old,new,1));code,data=run(name,selector)
                failed=[a for r in data['testResults'] for a in r.get('assertionResults',[]) if a['status']=='failed']
                assert code!=0 and data['numFailedTests']==1 and len(failed)==1 and failed[0]['fullName']==selector,(name,'wrong failure set')
                message='\n'.join(failed[0].get('failureMessages',[]))
                assert all(token.lower() in message.lower() for token in tokens),(name,'semantic failure mismatch')
                receipt['controls'].append({'control':name,'failedAssertion':selector,'semanticTokens':tokens,'red':True})
            finally:p.write_bytes(original)
            assert p.read_bytes()==original,(name,'restore mismatch')
            code,data=run(name+'-restored',selector);assert code==0 and data['numPassedTests']==1 and data['numFailedTests']==0,(name,'restored not green')
            assert inputs()==before,'Live input file-set/hash changed'
        code,data=run('restored');assert code==0 and data['numPassedTests']==39 and data['numFailedTests']==0,'Final restore refused'
        assert inputs()==before,'Live source drift'
        receipt.update({'status':'PASS','baselinePassed':39,'restoredPassed':39,'sourceUnchanged':True})
    finally:
        assert copy.parent==out and copy.name=='private-copy'
        if copy.exists():shutil.rmtree(copy)
        receipt['copyRemoved']=not copy.exists();(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print('PASS: 39 baseline/restored, four exact semantic controls; no live database proof.')

if __name__=='__main__':main()