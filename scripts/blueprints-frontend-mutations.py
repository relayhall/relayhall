#!/usr/bin/env python3
"""Bounded Blueprint frontend red controls; preserve exact source bytes after every probe."""
import argparse, hashlib, json, pathlib, subprocess, sys
parser=argparse.ArgumentParser();parser.add_argument('--root',type=pathlib.Path,required=True);parser.add_argument('--output',type=pathlib.Path,required=True);parser.add_argument('--control',action='append');args=parser.parse_args()
root=args.root.resolve();out=args.output.resolve();out.mkdir(parents=True,exist_ok=True)
w='frontend/src/components/blueprints/BlueprintUse.tsx';p='frontend/src/pages/BlueprintsPage.tsx';plan='frontend/src/components/blueprints/BlueprintPlan.tsx'
tests='src/pages/BlueprintsPage.test.tsx'
cases=[
('key-before-confirm',w,'setPreview(next); setPreviewBody(body); setStep(4);','crypto.randomUUID(); setPreview(next); setPreviewBody(body); setStep(4);','only explicit confirmation'),
('retry-key-changes',w,'void instantiate(attempt)','void instantiate({ ...attempt, key: crypto.randomUUID() })','an uncertain response retries'),
('retry-edit-unlocks',w,'{!error?.uncertain && <Button','{true && <Button','an uncertain response retries'),
('revised-body-stale',w,'const confirmed = { key, body: previewBody }','const confirmed = { key, body: previewBody.replace("INC-13", "INC-12") }','edited input requires'),
('authority-bypass',w,'preview.plan.authority.every(row => row.allowed)','true','preview diagnoses authority'),
('required-ref-bypass',w,"preview.plan.references.every(reference => reference.outcome === 'resolved')",'true','preview diagnoses reference'),
('refusal-bypass',w,'preview.plan.refusals.length === 0','true','preview diagnoses refusal'),
('archived-bypass',w,'!preview.targetArchived','true','preview diagnoses archived'),
('audience-bypass',p,'const actions = detail?.availableActions || [];',"const actions = ['instantiate', 'publish'];",'detail actions are authoritative'),
('duplicate-shared-task',plan,'plan.tasks.map(task =>','[...plan.tasks, ...plan.tasks].map(task =>','preview renders objects'),
('missing-optional-warning',plan,'Optional reference unavailable; Create requires access.','Resolved','preview renders objects'),
('lookup-project-dropped','frontend/src/components/blueprints/BlueprintParameters.tsx','encodeURIComponent(projectId!)',"encodeURIComponent('wrong-project')",'visible reference lookups'),
('ledger-null-mislabel','frontend/src/components/blueprints/BlueprintLedger.tsx','row.parameter_values == null','row.parameter_values === undefined','ledger labels'),
('local-refusal-focus-dropped',w,'document.getElementById(`blueprint-parameter-${invalid.key}`)?.focus();','void invalid;','keyboard collection'),
('server-refusal-focus-dropped',w,'if (error) errorRef.current?.focus();','if (error) void error;','server refusal focuses'),
('reject-note-bypass',p,"busy || lifecycle === 'reject' && !note.trim()",'busy','rejection requires'),
('draft-version-dropped',p,'onSelect={() => select(item.id, item.version)}','onSelect={() => select(item.id)}','registry opens the listed draft'),
('parameter-pattern-bypass','frontend/src/components/blueprints/parameterValidation.ts','if (constraints.pattern) {','if (false) {','keyboard collection'),
('import-rename-ignored',p,'{ rename: rename.trim() }','{ rename: "ignored-answer" }','import collision'),
('project-target-dropped','frontend/src/components/projects/ProjectDetailModal.tsx','/blueprints?project=${encodeURIComponent(currentProject.id)}','/blueprints?project=wrong-project','a use-capable caller enters'),
('provenance-key-dropped','frontend/src/components/projects/ProjectDetailModal.tsx','encodeURIComponent(currentProject.blueprintKey)','encodeURIComponent("wrong-key")','the immutable provenance stamp'),
]
receipts=[]
for name,path,before,after,selector in cases:
    if args.control and name not in args.control:continue
    source=root/path;original=source.read_bytes();text=original.decode();assert text.count(before)>=1,(name,text.count(before))
    receipt={'control':name,'file':path,'selector':selector,'beforeSha256':hashlib.sha256(original).hexdigest()}
    try:
        source.write_bytes(text.replace(before,after).encode())
        report=out/f'{name}.json';log=out/f'{name}.log'
        target='src/components/projects/ProjectDetailModal.test.tsx' if 'ProjectDetailModal' in path else tests
        command=['node_modules/.bin/vitest','run','--pool=forks','--maxWorkers=1','--minWorkers=1',target,'-t',selector,'--reporter=json',f'--outputFile={report}']
        with log.open('w') as stream:
            process=subprocess.run(command,cwd=root/'frontend',stdout=stream,stderr=subprocess.STDOUT,timeout=90)
        result=json.loads(report.read_text()) if report.exists() else {}
        failures=[a for t in result.get('testResults',[]) for a in t.get('assertionResults',[]) if a.get('status')=='failed']
        receipt.update(exit=process.returncode,failedTests=result.get('numFailedTests',0),assertionFailures=[{'name':a.get('fullName'),'messages':a.get('failureMessages')} for a in failures])
        receipt['red']=process.returncode!=0 and bool(failures) and any(any(marker in '\n'.join(a.get('failureMessages',[])) for marker in ['AssertionError','TestingLibraryElementError','expected ','Unable to find']) for a in failures)
    finally:
        source.write_bytes(original);receipt['restoredSha256']=hashlib.sha256(source.read_bytes()).hexdigest();receipt['restored']=source.read_bytes()==original
    receipts.append(receipt);(out/'summary.json').write_text(json.dumps(receipts,indent=2));print(json.dumps({k:receipt.get(k) for k in ['control','exit','failedTests','red','restored']}),flush=True)
    if not receipt['red'] or not receipt['restored']:sys.exit(1)
