#!/usr/bin/env python3
"""Approved creator/bootstrap and explicit setup semantic controls, mocked persistence.

The live PostgreSQL suite independently proves atomicity and redaction. These
controls run only in a disposable copy and demand the named behavioral failure,
then restored green. No database connection or worktree mutation is permitted.
"""
import argparse,fnmatch,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path

def inventory(base):
    result={}
    ignored=['node_modules','dist','coverage','.env*','*.log','__pycache__','*.pyc']
    for parent,folders,files in os.walk(base):
        folders[:]=[f for f in folders if not any(fnmatch.fnmatch(f,x) for x in ignored)]
        for f in files:
            if not any(fnmatch.fnmatch(f,x) for x in ignored):
                p=Path(parent)/f;result[str(p.relative_to(base))]=hashlib.sha256(p.read_bytes()).hexdigest()
    return dict(sorted(result.items()))

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output-dir',type=Path,required=True);args=parser.parse_args()
    root=Path(__file__).resolve().parents[1];out=args.output_dir.resolve()
    if out==root or root in out.parents:raise ValueError('Proof output must be a fresh directory outside source')
    os.umask(0o077);out.mkdir(parents=True,exist_ok=False)
    env={k:v for k,v in os.environ.items() if not k.startswith(('DB_','PG')) and k not in ['DATABASE_URL','RELAYHALL_TEST_DB_URL']}
    env.update(NODE_ENV='test',DB_HOST='127.0.0.1',DB_PORT='59999',DB_NAME='none',FORCE_COLOR='0')
    creator='src/services/GrantService.ts';setup='src/services/BlueprintSetupService.ts'
    tests=['src/__tests__/projectCreatorAccess.test.ts','src/__tests__/blueprintWorkflowSetup.test.ts']
    controls=[
      ('creator-read-omitted',creator,"for (const verb of ['read','write'] as const)","for (const verb of ['write'] as const)",'ordinary Project bootstrap grants exactly creator read/write with same-client audit/feed and no owner or vehicle marker'),
      ('creator-client-omitted',creator,'resourceType: \'project\', resourceId: projectId, verb }, audit, client);','resourceType: \'project\', resourceId: projectId, verb }, audit);','ordinary Project bootstrap grants exactly creator read/write with same-client audit/feed and no owner or vehicle marker'),
      ('creator-identity-substituted',creator,"granteeType: 'principal', granteeId: actor.principalId,","granteeType: 'principal', granteeId: projectId,",'ordinary Project bootstrap grants exactly creator read/write with same-client audit/feed and no owner or vehicle marker'),
      ('creator-liveness-omitted',creator,"if (locked.rows.length !== ids.length || locked.rows.some(row => row.status !== 'active' || row.legacy_identity))",'if (locked.rows.length < 0)','inactive creator disabled cannot receive bootstrap Grants'),
      ('setup-client-omitted',setup,'caller.taskActor, undefined, transaction);','caller.taskActor, undefined);','confirmed setup passes only canonical assignment fields and exact existing Warrant into one outer transaction'),
      ('setup-activation-added',setup,'executionWarrantId: warrantId } as any','executionWarrantId: warrantId, autoStart: true } as any','confirmed setup passes only canonical assignment fields and exact existing Warrant into one outer transaction'),
      ('setup-private-projection-removed',setup,'CASE WHEN i.actor_principal_id::text=$2 OR $3::boolean THEN i.execution_defaults ELSE NULL END AS execution_defaults','i.execution_defaults AS execution_defaults','preview displays exact current Task versions and staged profiles but no foreign Warrant management fields'),
      ('setup-profile-binding-omitted',setup,'if (plan.confirmationHash !== input.confirmationHash','if (false','publishing a changed live profile requires a fresh setup confirmation'),
      ('setup-phase-membership-omitted',setup,'|| (task.phase_id ?? null) !== staged.phaseId','|| staged.phaseId === undefined && false','changed phase_id membership refuses before assignment'),
      ('setup-invoke-omitted',setup,"if (invocable.size !== services.length)","if (invocable.size < 0)",'lost invoke authority refuses before descriptor lookup or canonical assignment'),
    ]
    receipts=[]
    with tempfile.TemporaryDirectory(prefix='rh-blueprint-setup-') as temporary:
        copied=Path(temporary)/'backend';shutil.copytree(root/'backend',copied,ignore=shutil.ignore_patterns('node_modules','dist','coverage','.env*','*.log','__pycache__','*.pyc'))
        original=inventory(copied);(out/'source-sha256.json').write_text(json.dumps(original,indent=2))
        (copied/'node_modules').symlink_to((root/'backend/node_modules').resolve(),target_is_directory=True)
        def run(label,selected=None):
            report=out/(label+'.json');command=['node',str(copied/'node_modules/jest/bin/jest.js'),'--runInBand','--runTestsByPath',*tests,'--json','--outputFile='+str(report)]
            if selected:command+=['--testNamePattern','^'+re.escape(selected)+'$']
            with (out/(label+'.log')).open('w') as log:result=subprocess.run(command,cwd=copied,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180)
            if not report.exists():raise AssertionError(label+': no assertion report')
            data=json.loads(report.read_text());assertions=[a for suite in data['testResults'] for a in suite['assertionResults']]
            active=[a for a in assertions if a['status'] in ['passed','failed']]
            if selected:
                if len(active)!=1 or active[0]['fullName']!=selected:raise AssertionError(label+': selected assertion missing or unexpected execution')
            elif len(active)!=25 or len(assertions)!=25:raise AssertionError(label+': expected complete25 assertion inventory')
            return result.returncode,active
        code,baseline=run('baseline');assert code==0 and all(a['status']=='passed' for a in baseline)
        for name,file,before,after,selected in controls:
            assert sum(a['fullName']==selected for a in baseline)==1
            production=copied/file;source=production.read_bytes();text=source.decode();assert text.count(before)==1,name+': ambiguous mutation anchor'
            row={'name':name,'file':file,'expected':[selected],'beforeSha256':hashlib.sha256(source).hexdigest()}
            try:
                production.write_text(text.replace(before,after,1));row['mutatedSha256']=hashlib.sha256(production.read_bytes()).hexdigest()
                code,active=run(name+'-red',selected);failed=[a for a in active if a['status']=='failed'];row['actual']=[a['fullName'] for a in failed];row['messages']=[a['failureMessages'] for a in failed]
                row['accepted']=code!=0 and row['actual']==row['expected'] and all(any('expect(' in m for m in a['failureMessages']) for a in failed)
                assert row['accepted'],name+': intended behavioral assertion did not fail'
            finally:
                production.write_bytes(source);row['byteRestored']=production.read_bytes()==source;receipts.append(row);(out/'receipt.json').write_text(json.dumps(receipts,indent=2))
            code,active=run(name+'-restored',selected);assert code==0 and all(a['status']=='passed' for a in active);row['restoredGreen']=True
            (out/'receipt.json').write_text(json.dumps(receipts,indent=2));print(name+': intended RED and restored green',flush=True)
        code,active=run('restored');assert code==0 and all(a['status']=='passed' for a in active)
        current=inventory(root/'backend');changed=[p for p in sorted(set(original)|set(current)) if original.get(p)!=current.get(p)]
        (out/'source-readback.json').write_text(json.dumps({'changed':changed}));assert not changed,'Live source changed during proof'
    result={'baseline':25,'restored':25,'controls':len(receipts),'copyRemoved':not copied.exists(),'liveSourceUnchanged':True,'persistence':'mocked'}
    (out/'summary.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
if __name__=='__main__':main()
