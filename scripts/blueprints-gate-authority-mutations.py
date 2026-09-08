#!/usr/bin/env python3
"""Real-PG gate controls in a source-only copy. Never mutate a builder's tree.

Usage: script ROOT OUTPUT [CONTROL ...]
RELAYHALL_TEST_DB_URL is mandatory and must identify a disposable local DB.
The live suite applies the full guard before loading any database code.
Each selected test must pass its baseline before a mutation can count as red.
"""
import hashlib,json,os,pathlib,shutil,subprocess,sys,tempfile
root=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
if not os.environ.get('RELAYHALL_TEST_DB_URL'):raise SystemExit('RELAYHALL_TEST_DB_URL is required; no inherited deployment DB is used.')
copy=pathlib.Path(tempfile.mkdtemp(prefix='blueprint-gate-copy-',dir=out)).resolve()
assert copy.parent==out and copy.name.startswith('blueprint-gate-copy-')
inst='backend/src/services/BlueprintInstantiationService.ts';plan='backend/src/services/BlueprintPlanService.ts';registry='backend/src/services/BlueprintRegistryService.ts';task='backend/src/services/TaskManagerDB.ts'
controls=[
('D6-privileged-reference','backend/src/services/BlueprintResolutionService.ts','WHERE ${predicate} AND ${condition.sql} ORDER BY','WHERE ${predicate} AND (${condition.sql} OR TRUE) ORDER BY','D6 invisible Skill'),
('D7-created-armed',inst,'phaseId: task.phaseId ?? created.phases[task.phaseKey] ?? null, autoStart: false,','phaseId: task.phaseId ?? created.phases[task.phaseKey] ?? null, autoStart: true,','D7a-b D24a'),
('D7-duplicate-shared-arm',inst,'for (const task of plan.tasks) {\n        const createdTask','for (const task of [...plan.tasks, ...plan.tasks.filter(task => plan.humanGates.some(gate => gate.arms.filter((arm: any) => arm.tasks.includes(task.key)).length > 1))]) {\n        const createdTask','D7a-b D24a'),
('D7-completion-auto-arms',task,"if (updates.status && updates.status !== current.status) {\n        await lifecyclePolicyService.evaluate", "if (updates.status === 'completed') await client.query('UPDATE tasks SET auto_start=TRUE WHERE id IN (SELECT task_id FROM task_dependencies WHERE depends_on_task_id=$1)', [id]);\n      if (updates.status && updates.status !== current.status) {\n        await lifecyclePolicyService.evaluate",'D7c-e-f'),
('D7-gate-edge-dropped',plan,'const dependencies = expandedDependencies(document);','const dependencies = expandedDependencies(document).filter(edge => !document.humanGates.some(gate => gate.key === edge.dependsOn));','D7d parked arm'),
('D7-ordinary-arm-forwarding','backend/src/routes/tasks.ts','const updates = await resolveExecutionProfileWrite({ ...req.body }, req);','const updates = await resolveExecutionProfileWrite({ ...req.body }, req); delete updates.autoStart;','D7c-e-f'),
('D24-shepherd-binding-dropped',plan,'task.roles.shepherdPrincipalId = decider.id;','task.roles.shepherdPrincipalId = null;','D7a-b D24a|D24c role-bound Shepherd'),
('D24-role-plan-dropped',plan,'if (principalIds.length) requirements.push','if (false) requirements.push','D24d missing'),
('D20-preview-authority-gate',inst,'return { blueprint: { id: parent.id, key: parent.key, version: version.version }, plan, targetArchived:', 'enforceBlueprintPlan(plan); return { blueprint: { id: parent.id, key: parent.key, version: version.version }, plan, targetArchived:','D20 use-only'),
('D20-target-concealment-dropped',inst,'WHERE (p.id::text=$1 OR p.name=$1) AND ${condition.sql} ORDER BY','WHERE (p.id::text=$1 OR p.name=$1) AND (${condition.sql} OR TRUE) ORDER BY','D20 use-only'),
('D20-use-only-read-gate',registry,"async get(identifier: string, caller: BlueprintReader, version?: number): Promise<any> {\n    const read = blueprintScope(caller, 'blueprints:read');","async get(identifier: string, caller: BlueprintReader, version?: number): Promise<any> {\n    const read = blueprintScope(caller, 'blueprints:read'); requireBlueprintScope(caller, 'blueprints:read');",'D20 use-only'),
('D20-draft-disclosure',registry,'if (!read && row.id !== parent.published_version_id) return blueprintNotFound();',"if (!read && row.id !== parent.published_version_id) return { id:parent.id, key:parent.key, version:row.version, ...this.describe(row.document), projection:'use' };",'D20 use-only'),
('D14-defensive-layer-dropped',registry,"if (admin && (caller.actor.delegation?.links[0]?.kind === 'agent' || caller.actor.role === 'agent')) throw new BlueprintError(403, 'BLUEPRINT_AGENT_ADMIN_REFUSED', 'Agent-layer principals cannot administer Blueprint publication');",'// mutation: defensive layer guard removed','D14 defensive transition'),
]
results=[]
def run(name,selector):
    report=out/f'{name}.json';log=out/f'{name}.log'
    command=['node','node_modules/jest/bin/jest.js','--runInBand','--testPathIgnorePatterns=/node_modules/','--runTestsByPath','src/__tests__/blueprintGateAuthorityLive.test.ts','-t',selector,'--json',f'--outputFile={report}']
    with log.open('w') as stream:process=subprocess.run(command,cwd=copy/'backend',stdout=stream,stderr=subprocess.STDOUT,timeout=180)
    value=json.loads(report.read_text()) if report.exists() else {}
    failed=[a for suite in value.get('testResults',[]) for a in suite.get('assertionResults',[]) if a.get('status')=='failed']
    return process.returncode,value,failed
try:
    shutil.copytree(root/'backend/src',copy/'backend/src')
    for filename in ['package.json','tsconfig.json','jest.config.js']:
        shutil.copy2(root/'backend'/filename,copy/'backend'/filename)
    shutil.copytree(root/'docs/blueprints/examples',copy/'docs/blueprints/examples')
    (copy/'backend/node_modules').symlink_to((root/'backend/node_modules').resolve(),target_is_directory=True)
    baseline={}
    for name,file,before,after,selector in controls:
        if len(sys.argv)>3 and name not in sys.argv[3:]:continue
        source=copy/file;original=source.read_bytes();live_hash=hashlib.sha256((root/file).read_bytes()).hexdigest();text=original.decode();assert text.count(before)>=1,(name,text.count(before))
        row={'control':name,'file':file,'sourceSha256':hashlib.sha256(original).hexdigest(),'selector':selector}
        if selector not in baseline:baseline[selector]=run('baseline-'+name,selector)
        code,value,failed=baseline[selector]
        if code!=0 or value.get('numPassedTests',0)<1:
            row.update(status='BASELINE_FAILED_NO_RED_CLAIM',failedTests=value.get('numFailedTests'),failures=[a.get('fullName') for a in failed]);results.append(row);(out/'summary.json').write_text(json.dumps(results,indent=2));print(json.dumps(row),flush=True);continue
        try:
            source.write_bytes(text.replace(before,after,1).encode());code,value,failed=run(name,selector)
            row.update(exit=code,failedTests=value.get('numFailedTests',0),red=code!=0 and bool(failed),failures=[{'name':a.get('fullName'),'messages':a.get('failureMessages')} for a in failed])
        finally:
            source.write_bytes(original);row['copyRestored']=source.read_bytes()==original;row['builderUnchanged']=hashlib.sha256((root/file).read_bytes()).hexdigest()==live_hash
        restored_code,restored_value,_=run(name+'-restored',selector)
        row['restoredGreen']=restored_code==0 and restored_value.get('numPassedTests',0)>0
        results.append(row);(out/'summary.json').write_text(json.dumps(results,indent=2));print(json.dumps({k:row.get(k) for k in ['control','red','copyRestored','builderUnchanged']}),flush=True)
        if not row.get('red') or not row['copyRestored'] or not row['builderUnchanged'] or not row['restoredGreen']:raise SystemExit(1)
finally:
    assert copy.parent==out and copy.name.startswith('blueprint-gate-copy-')
    shutil.rmtree(copy)
if any(row.get('status')=='BASELINE_FAILED_NO_RED_CLAIM' for row in results):raise SystemExit(2)
