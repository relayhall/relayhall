#!/usr/bin/env python3
"""Blueprint runtime real-red controls in a disposable source copy.

Requires an explicit disposable database URL; never starts/stops a database.
The baseline, each named assertion and restored baseline must complete. A
compiler/import/process failure is not a production negative-control receipt.
"""
import argparse, hashlib, json, os, shutil, subprocess, tempfile
from pathlib import Path
from urllib.parse import urlparse, unquote
parser=argparse.ArgumentParser();parser.add_argument('--output-dir',required=True,type=Path);parser.add_argument('--control',action='append');args=parser.parse_args()
root=Path(__file__).resolve().parents[1];out=args.output_dir.resolve()
assert root != out and root not in out.parents, 'Evidence must stay outside source'
u=urlparse(os.environ.get('RELAYHALL_TEST_DB_URL',''));database=unquote(u.path.lstrip('/'))
assert u.hostname in ['127.0.0.1','localhost','::1','postgres'] and database not in ['relayhall','relayhall_dev','relayhall_tst','relayhall_prod','clawboard','clawboard_dev','clawboard_prod'] and (any(x in database.lower() for x in ['test','contract','fixture']) or (u.hostname=='postgres' and database=='relayhall_ci')), 'Explicit disposable DB URL required'
out.mkdir(parents=True,exist_ok=False);digest=lambda data:hashlib.sha256(data).hexdigest()
inst='backend/src/services/BlueprintInstantiationService.ts';plan='backend/src/services/BlueprintPlanService.ts'
controls=[
 ('d4-authority-inside-write-loop',inst,"      enforceBlueprintPlan(plan);\n      // The same descriptor validator as the manual task route runs before\n      // any canonical object write, after invoke authority is admitted.\n      for (const task of plan.tasks) if (task.executionProfile) task.executionProfile = await validateConnectorProfile(task.executionProfile);\n      const created: { projectId: string; phases: Record<string,string>; tasks: Record<string,string>; reports: Record<string,string> } = {\n        projectId: target?.id ?? '', phases: {}, tasks: {}, reports: {},\n      };\n      if (plan.project) {\n        const project = await projectService.create({ name: plan.project.name, description: plan.project.description, goal: plan.project.goal },\n          { authorization: caller.actor, principalId: caller.actor.principalId, authMethod: caller.taskActor.authMethod, scopes: caller.actor.scopes, audit: caller.audit }, transaction, allocatedProjectId);\n        created.projectId = project.id;\n      }\n      for (const phase of plan.phases) {\n        created.phases[phase.key] = (await phaseService.create({ projectId: created.projectId, name: phase.name, goal: phase.goal, position: phase.position, status: phase.status }, transaction)).id;\n      }\n      const projectTarget: AuthorizedProjectTarget = async (projectIdentifier, queryable) => {\n        if (projectIdentifier !== created.projectId) return null;\n        const allowed = await authorizationRepository.authorizedIds(caller.actor, 'project', [created.projectId], 'read', queryable);\n        return allowed.has(created.projectId) ? created.projectId : null;\n      };\n      for (const task of plan.tasks) {\n","      enforceBlueprintPlan({...plan,authority:plan.authority.filter(item=>!item.localKey)});\n      // The same descriptor validator as the manual task route runs before\n      // any canonical object write, after invoke authority is admitted.\n      for (const task of plan.tasks) if (task.executionProfile) task.executionProfile = await validateConnectorProfile(task.executionProfile);\n      const created: { projectId: string; phases: Record<string,string>; tasks: Record<string,string>; reports: Record<string,string> } = {\n        projectId: target?.id ?? '', phases: {}, tasks: {}, reports: {},\n      };\n      if (plan.project) {\n        const project = await projectService.create({ name: plan.project.name, description: plan.project.description, goal: plan.project.goal },\n          { authorization: caller.actor, principalId: caller.actor.principalId, authMethod: caller.taskActor.authMethod, scopes: caller.actor.scopes, audit: caller.audit }, transaction, allocatedProjectId);\n        created.projectId = project.id;\n      }\n      for (const phase of plan.phases) {\n        created.phases[phase.key] = (await phaseService.create({ projectId: created.projectId, name: phase.name, goal: phase.goal, position: phase.position, status: phase.status }, transaction)).id;\n      }\n      const projectTarget: AuthorizedProjectTarget = async (projectIdentifier, queryable) => {\n        if (projectIdentifier !== created.projectId) return null;\n        const allowed = await authorizationRepository.authorizedIds(caller.actor, 'project', [created.projectId], 'read', queryable);\n        return allowed.has(created.projectId) ? created.projectId : null;\n      };\n      for (const task of plan.tasks) {\n        enforceBlueprintPlan({...plan,authority:plan.authority.filter(item=>item.localKey===task.key)});\n",'D-4 fifth of ten'),
 ('d16-instantiate-only-default',inst,"priority: task.priority ?? 'normal',","priority: task.priority ?? 'high',",'D-16 preview'),
 ('d1-task-system-actor',inst,'}, caller.taskActor, projectTarget, transaction);',"}, {principalId:null,handle:'system',authMethod:'system'}, projectTarget, transaction);",'D-1 identity:'),
 ('d10-optional-key',inst,"if (typeof key !== 'string' || key.length < 16 || key.length > 128)","if (key != null && (typeof key !== 'string' || key.length < 16 || key.length > 128))",'D-10 required key'),
 ('d10-raw-request-bytes',inst,'const hash = blueprintRequestHash(version.id, canonicalTarget, values);','void blueprintRequestHash; const hash = blueprintDigest({ version: version.id, raw: JSON.stringify(input) });','D-10 required key'),
 ('d11-replay-before-target',inst,'if (target) this.activeTarget(target);',"const historicalParent = await this.registry.resolve(identifier, caller, 'use', client, true);\n      const historicalReplay = (await client.query('SELECT response_snapshot FROM blueprint_instantiation_requests WHERE caller=$1 AND blueprint_id=$2 AND idempotency_key=$3', [caller.actor.principalId,historicalParent.id,key])).rows[0];\n      if (historicalReplay) return historicalReplay.response_snapshot;\n      if (target) this.activeTarget(target);",'D-11 existing target archive'),
 ('reference-outcomes-json',inst,'caller.actor.principalId,values,projection,JSON.stringify(plan.references),response,JSON.stringify(executionDefaults)]);','caller.actor.principalId,values,projection,plan.references,response,JSON.stringify(executionDefaults)]);','D-1 identity:'),
 ('d1-feed-actor','backend/src/services/ReportManager.ts','actorPrincipalId: transaction?.actor.principalId ?? null,','actorPrincipalId: null,','D-1 identity:'),
 ('d4-whole-plan-authority',plan,'const requirement = plan.authority.find(item => !item.allowed);','const requirement = plan.authority.find(item => false && !item.allowed);','D-4/D-20 use-only preview'),
 ('d10-required-key',inst,"if (typeof key !== 'string' || key.length < 16 || key.length > 128)","if (typeof key !== 'string')",'D-10 required key'),
 ('d10-request-identity',plan,'return blueprintDigest({ blueprintVersionId, target, parameterValues });','void parameterValues; return blueprintDigest({ blueprintVersionId, target });','D-10 required key'),
 ('d11-archive-before-replay',inst,"if (target.status === 'archived')","if (false && target.status === 'archived')",'D-11 existing target archive'),
 ('d17-root-concealment',inst,'const root = await this.target(existing.response_snapshot.projectId, caller, client, true);',"const root = { status: 'active' };",'D-17 new-root replay'),
 ('d22-hash-before-screen',inst,'const values = validateBlueprintValues(document, input.parameterValues, input.target.mode);','blueprintRequestHash(version.id, {}, input.parameterValues); const values = validateBlueprintValues(document, input.parameterValues, input.target.mode);','D-22 refused runtime value'),
 ('d23-raw-value-redaction','backend/src/services/BlueprintLedgerService.ts','CASE WHEN i.actor_principal_id::text=$2 OR $3::boolean THEN i.parameter_values','CASE WHEN TRUE OR i.actor_principal_id::text=$2 OR $3::boolean THEN i.parameter_values','D-23 nonroot author'),
 ('atomic-success-log','backend/src/services/ReportManager.ts','if (transaction) transaction.afterCommit(announce); else announce();','announce();','atomic rollback includes canonical objects'),
]
assert not args.control or set(args.control)<={x[0] for x in controls}, 'Unknown control'
env=os.environ.copy()
for key in list(env):
 if key.startswith(('DB_','PG')) or key=='DATABASE_URL':env.pop(key,None)
env['NODE_ENV']='test';receipts=[]
with tempfile.TemporaryDirectory(prefix='rh-blueprint-runtime-') as temporary:
 copied=Path(temporary)/'source';copied.mkdir()
 for directory in ['backend','cli']:
  shutil.copytree(root/directory,copied/directory,ignore=shutil.ignore_patterns('node_modules','dist','coverage','.env*','*.log','__pycache__'))
 (copied/'backend/node_modules').symlink_to((root/'backend/node_modules').resolve(),target_is_directory=True)
 sources={str(p.relative_to(root)):digest(p.read_bytes()) for p in (root/'backend/src').rglob('*.ts') if '__tests__' not in p.parts}
 sources['backend/src/__tests__/blueprintLiveContract.test.ts']=digest((root/'backend/src/__tests__/blueprintLiveContract.test.ts').read_bytes())
 (out/'source-sha256.json').write_text(json.dumps(sources,indent=2))
 def invoke(label,selector=None):
  report=out/(label+'.json');log=out/(label+'.log')
  command=['node',str(copied/'backend/node_modules/jest/bin/jest.js'),'--runInBand','--testPathIgnorePatterns=/node_modules/','--runTestsByPath','src/__tests__/blueprintLiveContract.test.ts','--json','--outputFile',str(report)]
  if selector:command.extend(['--testNamePattern',selector])
  with log.open('w') as stream:result=subprocess.run(command,cwd=copied/'backend',env=env,stdout=stream,stderr=subprocess.STDOUT,timeout=180)
  assert report.exists(),label+': missing structured Jest result'
  data=json.loads(report.read_text());failures=[a for suite in data.get('testResults',[]) for a in suite.get('assertionResults',[]) if a.get('status')=='failed'];return result.returncode,data,failures
 code,data,failures=invoke('baseline');assert code==0 and data['numPassedTests']>=18 and not failures,'Baseline must be green';baseline_count=data['numPassedTests']
 for name,relative,old,new,selector in controls:
  if args.control and name not in args.control:continue
  p=copied/relative;original=p.read_bytes();text=original.decode();assert text.count(old)==1,(name,'Anchor not unique');row={'control':name,'selector':selector,'beforeSha256':digest(original)}
  try:
   p.write_text(text.replace(old,new,1));row['mutatedSha256']=digest(p.read_bytes());code,data,failures=invoke(name,selector)
   row.update(exit=code,failed=data.get('numFailedTests'),assertions=[{'name':f['fullName'],'messages':f['failureMessages']} for f in failures]);row['red']=code!=0 and len(failures)==1 and selector in failures[0]['fullName'] and any('expect(' in m or 'Expected:' in m for m in failures[0]['failureMessages']);assert row['red'],name+': intended assertion did not fail'
   if name=='d4-authority-inside-write-loop':assert any('Received number of calls: 4' in m for m in failures[0]['failureMessages']), 'Four canonical calls must be the sole failing authority-plan assertion'
   if name=='d1-task-system-actor':assert any('Received: null' in m for m in failures[0]['failureMessages']), 'Task caller principal equality must fail'
   if name=='d16-instantiate-only-default':assert any(chr(34)+'priority'+chr(34)+': '+chr(34)+'high'+chr(34) in m for m in failures[0]['failureMessages']), 'Stored default must differ from preview'
   if name=='d11-replay-before-target':assert any('PROJECT_ARCHIVED' in m for m in failures[0]['failureMessages']), 'Archive assertion itself must fail'
   if name=='d10-optional-key':assert any('IDEMPOTENCY_KEY_REQUIRED' in m for m in failures[0]['failureMessages']), 'Missing-key code assertion itself must fail'
  finally:
   p.write_bytes(original);row['restored']=p.read_bytes()==original;receipts.append(row);(out/'receipt.json').write_text(json.dumps(receipts,indent=2))
 code,data,failures=invoke('restored');assert code==0 and data['numPassedTests']>=18 and not failures,'Restored baseline must be green'
 assert all(digest((root/p).read_bytes())==sha for p,sha in sources.items()),'Live source changed during copied-tree evidence'
 print(json.dumps({'controls':len(receipts),'baseline':baseline_count,'restored':data['numPassedTests'],'liveSourceUnchanged':True}))
