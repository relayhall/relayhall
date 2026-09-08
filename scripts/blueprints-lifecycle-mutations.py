#!/usr/bin/env python3
"""D19 named lifecycle controls: real PostgreSQL, source-only disposable copy.

Never starts/stops a database or edits the builder, its tests, or schema.
Use --describe for read-only selector/anchor preparation without a DB.
"""
import argparse,difflib,fnmatch,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
from urllib.parse import urlparse,unquote

parser=argparse.ArgumentParser()
parser.add_argument('--output-dir',type=Path)
parser.add_argument('--control',action='append')
parser.add_argument('--describe',action='store_true')
args=parser.parse_args()
os.umask(0o077)
root=Path(__file__).resolve().parents[1]
relative='backend/src/services/BlueprintRegistryService.ts'
suite='backend/src/__tests__/blueprintLiveContract.test.ts'
basic='D-19 review is immutable, independent publication required, retirement blocks new work but permits committed replay'
success='D-19 supersession retires v1 atomically and only v2 accepts fresh work'
atomic='D-19 supersession rolls back the pointer and both statuses when predecessor retirement fails'

def once(source,before,after):
    assert source.count(before)==1, ('Mutation anchor count',source.count(before),before[:80])
    return source.replace(before,after,1)

def review_edit(source):
    start=source.index('      if (editVersion !== undefined) {')
    end=source.index('\n      } else {',start)
    old=source[start:end]
    guard="if (current.rows[0].status !== 'draft') throw new BlueprintError(409, 'BLUEPRINT_VERSION_IMMUTABLE', 'Only a draft version is editable');"
    new=once(old,guard,"if (!['draft','review'].includes(current.rows[0].status)) throw new BlueprintError(409, 'BLUEPRINT_VERSION_IMMUTABLE', 'Only a draft version is editable');\n        const reviewEdit = current.rows[0].status === 'review';\n        if (reviewEdit) await client.query(\"UPDATE blueprint_versions SET status='draft' WHERE id=$1\", [current.rows[0].id]);")
    new+='\n        if (reviewEdit) await client.query("UPDATE blueprint_versions SET status=\'review\' WHERE id=$1", [current.rows[0].id]);'
    # ONE contiguous production branch replacement. The ordinary DB trigger
    # stays enabled: the mutant implements an unauthorized implicit withdraw/
    # edit/resubmit inside its existing transaction, making real content editable.
    return source[:start]+new+source[end:]

previous="""const previous = await client.query(`UPDATE blueprint_versions SET status='retired',status_note=$2,status_changed_at=now()
            WHERE id=$1 RETURNING version`, [parent.published_version_id, `superseded by version ${version}`]);"""
controls=[
    {'name':'d19-draft-publish','selector':basic,'oracle':'draft409-to200',
     'mutate':lambda s:once(s,"if (row.status !== required) throw new BlueprintError(409, 'BLUEPRINT_VERSION_STATE', `Required version state: ${required}`);","if (row.status !== required && !(act === 'publish' && row.status === 'draft')) throw new BlueprintError(409, 'BLUEPRINT_VERSION_STATE', `Required version state: ${required}`);")},
    {'name':'d19-author-publish','selector':basic,'oracle':'author403-to200',
     'mutate':lambda s:once(s,"if (act === 'publish' && row.author_principal_id === caller.actor.principalId) throw new BlueprintError(403, 'BLUEPRINT_SELF_REVIEW_REFUSED', 'Publication requires independent judgement');",'// mutation: publication author check removed')},
    {'name':'d19-review-edit','selector':basic,'oracle':'changed-review-content','mutate':review_edit},
    {'name':'d19-predecessor-status','selector':success,'oracle':'stored-predecessor-published',
     'mutate':lambda s:once(s,previous,"const previous = await client.query('SELECT version FROM blueprint_versions WHERE id=$1', [parent.published_version_id]);")},
    {'name':'d19-predecessor-second-transaction','selector':atomic,'oracle':'committed-pointer-after-refusal',
     'mutate':lambda s:once(s,'if (parent.published_version_id) {',"if (parent.published_version_id) {\n          await client.query('COMMIT');\n          await client.query('BEGIN');")},
]
assert not args.control or set(args.control)<=set(c['name'] for c in controls),'Unknown control'
selected=[c for c in controls if not args.control or c['name'] in args.control]
original=(root/relative).read_text()
for c in selected:
    mutated=c['mutate'](original)
    assert mutated!=original
if args.describe:
    print(json.dumps([{k:c[k] for k in ('name','selector','oracle')} for c in selected],indent=2))
    raise SystemExit(0)
assert args.output_dir,'--output-dir is required'
u=urlparse(os.environ.get('RELAYHALL_TEST_DB_URL',''));database=unquote(u.path.lstrip('/'))
assert u.hostname in ['127.0.0.1','localhost','::1','postgres'] and database not in ['relayhall','relayhall_dev','relayhall_tst','relayhall_prod','clawboard','clawboard_dev','clawboard_prod'] and (re.search('test|contract|fixture',database,re.I) or (u.hostname=='postgres' and database=='relayhall_ci')),'Explicit disposable DB URL required'
out=args.output_dir.resolve()
assert out!=root and root not in out.parents,'Evidence must stay outside source'
out.mkdir(parents=True,exist_ok=False)
digest=lambda b:hashlib.sha256(b).hexdigest()
env=os.environ.copy()
for key in list(env):
    if key.startswith(('DB_','PG')) or key in ['DATABASE_URL','BOOT_CHECK']:env.pop(key,None)
env['NODE_ENV']='test'
receipts=[]

def input_hashes(tree):
    ignored=('__pycache__','*.log','.env*')
    files={str(p.relative_to(tree)):digest(p.read_bytes()) for directory in ['backend/src','cli','docs/blueprints'] for p in (tree/directory).rglob('*') if p.is_file() and not any(fnmatch.fnmatch(part,pattern) for part in p.relative_to(tree).parts for pattern in ignored)}
    for name in ['package.json','package-lock.json','tsconfig.json','jest.config.js']:files['backend/'+name]=digest((tree/'backend'/name).read_bytes())
    return files

def execute(label,selector,copied):
    report=out/(label+'.json')
    command=['node','node_modules/jest/bin/jest.js','--runInBand','--testPathIgnorePatterns=/node_modules/','--runTestsByPath','src/__tests__/blueprintLiveContract.test.ts','--testNamePattern',re.escape(selector),'--json','--outputFile='+str(report)]
    with (out/(label+'.log')).open('w') as log:
        run=subprocess.run(command,cwd=copied/'backend',env=env,stdout=log,stderr=subprocess.STDOUT,timeout=240)
    result=json.loads(report.read_text()) if report.exists() else {}
    assertions=[a for t in result.get('testResults',[]) for a in t.get('assertionResults',[]) if a.get('status')!='pending']
    return run.returncode,result,assertions

def intended(control,assertions,rendered_log):
    failed=[a for a in assertions if a.get('status')=='failed']
    if len(failed)!=1 or control['selector'] not in failed[0].get('fullName',''):return False
    text=re.sub(r'\x1b\[[0-9;]*m','', '\n'.join(failed[0].get('failureMessages',[])))
    if re.search(r'TS\d{4}|Test suite failed to run|SyntaxError|22P02|23514|Exceeded timeout',text):return False
    # Jest JSON preserves the semantic diff/stack, but only its rendered log
    # carries the source assertion excerpt. Require both from the same run.
    excerpt=re.sub(r'\x1b\[[0-9;]*m','',rendered_log)
    oracle=control['oracle']
    if oracle in ('draft409-to200','author403-to200'):
        expected='409' if oracle.startswith('draft') else '403'
        return bool(re.search(r'(Expected:\s*'+expected+r'|"status": '+expected+r')',text) and re.search(r'(Received:\s*200|"status": 200)',text))
    if oracle=='changed-review-content':return 'SELECT document FROM blueprint_versions' in excerpt and '.toEqual(doc)' in excerpt and bool(re.search(r'^\s*\+\s*"title": "Unreviewed changed title"',text,re.M))
    if oracle=='stored-predecessor-published':return 'retired' in text and 'published' in text and 'superseded by version 2' in text and 'state.map' in excerpt and bool(re.search(r'^\s*\+\s*"status": "published"',text,re.M))
    if oracle=='committed-pointer-after-refusal':return 'published_version_id' in excerpt and '.toBe(before)' in excerpt and len(re.findall(r'[0-9a-f]{8}-[0-9a-f-]{27,}',text))>=2
    return False

copied=Path(tempfile.mkdtemp(prefix='blueprint-lifecycle-copy-',dir=out)).resolve()
assert copied.parent==out and copied.name.startswith('blueprint-lifecycle-copy-')
try:
    for directory in ['backend/src','cli','docs/blueprints']:
        shutil.copytree(root/directory,copied/directory,ignore=shutil.ignore_patterns('__pycache__','*.log','.env*'))
    for name in ['package.json','package-lock.json','tsconfig.json','jest.config.js']:
        shutil.copy2(root/'backend'/name,copied/'backend'/name)
    (copied/'backend/node_modules').symlink_to((root/'backend/node_modules').resolve(),target_is_directory=True)
    inputs=input_hashes(copied)
    assert input_hashes(root)==inputs,'Source changed while snapshotting'
    (out/'source-sha256.json').write_text(json.dumps({'HEAD':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'driverSha256':digest(Path(__file__).read_bytes()),'inputs':inputs},indent=2))
    (out/'live-test.ts').write_bytes((copied/suite).read_bytes())
    source=copied/relative;unchanged=source.read_bytes()
    baseline={}
    for control in selected:
        name=control['name'];selector=control['selector']
        if selector not in baseline:baseline[selector]=(name+'-baseline',execute(name+'-baseline',selector,copied))
        baseline_label,(code,result,assertions)=baseline[selector]
        assert code==0 and result.get('numPassedTests')==1 and result.get('numFailedTests')==0,(name,'Baseline not green')
        row={k:control[k] for k in ('name','selector','oracle')};row.update(sourceSha256=digest(unchanged),baseline=baseline_label,baselineGreen=True)
        modified=control['mutate'](unchanged.decode()).encode()
        (out/(name+'.diff')).write_text(''.join(difflib.unified_diff(unchanged.decode().splitlines(True),modified.decode().splitlines(True),fromfile=relative,tofile=relative)))
        try:
            source.write_bytes(modified);code,result,assertions=execute(name+'-red',selector,copied)
            row.update(redExit=code,red=code!=0 and intended(control,assertions,(out/(name+'-red.log')).read_text()),failedTests=result.get('numFailedTests'),failures=[a for a in assertions if a.get('status')=='failed'])
        finally:source.write_bytes(unchanged)
        code,result,_=execute(name+'-restored',selector,copied)
        row.update(restoredGreen=code==0 and result.get('numPassedTests')==1 and result.get('numFailedTests')==0,copyRestored=source.read_bytes()==unchanged)
        row['builderUnchanged']=input_hashes(root)==inputs
        receipts.append(row);(out/'summary.json').write_text(json.dumps(receipts,indent=2))
        print(json.dumps({k:row[k] for k in ('name','red','restoredGreen','copyRestored','builderUnchanged')}),flush=True)
        assert all(row[k] for k in ('red','restoredGreen','copyRestored','builderUnchanged')),(name,'Rejected control evidence')
finally:
    assert copied.parent==out and copied.name.startswith('blueprint-lifecycle-copy-')
    shutil.rmtree(copied)
