#!/usr/bin/env python3
"""Exact Project inheritance controls in disposable byte copies; real PG required.
Never starts/stops a database. Never edits the source worktree or its tests.
--describe validates literal mutation anchors without database access.
Each control names the live suite it reddens (an optional eighth field; the
default is the inheritance suite). The Phase-list controls (card 1e0f3bd4)
drive listPointParity: a restricted Phase suppresses what its Project lends
(ruling 44ee41f2), and every list that reaches Phase rows must answer what the
Phase point route answers. The Project-anchor control (card bdf7b876) drives
listPointParity too: a Warrant's linkage names a Project anchor only when the
Project point route reads it. The Brief controls (owner ruling E338) drive
listPointParity: a Task Brief shows its Phase only to a caller the Phase point
route answers, at the task altitude (REST, AGENTS.md, MCP) and the project
altitude. Every suite a selected control names gets its own green baseline, red
run and final restoration.
"""
import argparse,fnmatch,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
from urllib.parse import urlparse,unquote
parser=argparse.ArgumentParser();parser.add_argument('--output-dir',type=Path);parser.add_argument('--describe',action='store_true');parser.add_argument('--control',action='append');args=parser.parse_args()
os.umask(0o077)
root=Path(__file__).resolve().parents[1]
service='backend/src/services/AuthorizationService.ts';repo='backend/src/services/AuthorizationRepository.ts';grants='backend/src/services/GrantService.ts'
suite='src/__tests__/projectTaskGrantInheritanceLive.test.ts';parity='src/__tests__/listPointParity.test.ts'
phase_list='a Project reader holding phases:read lists exactly the Phases GET /phases/{id} answers'
phase_list_plain='a Project reader without phases:read still lists the open Phase and never a restricted one'
phase_anchor='GET /warrants/{id}/linkage names an open Phase anchor and conceals a restricted one'
phase_grantee='an exact Phase grantee lists the restricted Phase GET /phases/{id} answers it'
phase_owner='a Project owner lists the restricted Phase of its own Project, and a plain reader of it does not'
project_anchor='GET /warrants/{id}/linkage names a readable Project anchor and conceals an unreadable one'
brief_task='POST /tasks/{id}/brief shows the Phase exactly when GET /phases/{id} answers the same caller'
brief_agentsmd='the AGENTS.md shape conceals the same way'
brief_mcp='relayhall_brief_compile (MCP, taskId) answers as the point route does for Connectors and Agents, in both formats'
brief_project='POST /projects/{id}/brief with the taskId conceals the Phase from a Project reader, and shows it to root'
def once(s,a,b):
 assert s.count(a)==1,('anchor count',s.count(a),a[:90]);return s.replace(a,b,1)
controls=[
 ('list-inheritance-omitted',repo,'render: (paramOffset: number) => authorizationService.sqlCondition(actor, action, resource, paramOffset),',"render: (paramOffset: number) => authorizationService.sqlCondition(actor, action, { ...resource, inheritanceAnchor: 'FALSE' }, paramOffset),",'point, paginated SQL list, HTTP search and selector coverage agree before and after revocation','2','0'),
 ('read-inheritance-widened',service,"grantAllows(verb === 'admin' ? 'write' : verb, action)","grantAllows(verb === 'admin' || verb === 'read' ? 'write' : verb, action)",'read Project Grant gives precisely its ordinary Task read/write subset','403','200'),
 ('admin-inheritance-widened',service,"return (verb === 'read' || verb === 'write' || verb === 'admin')\n    && grantAllows('write', action)\n    && grantAllows(verb === 'admin' ? 'write' : verb, action);","return grantAllows(verb, action);",'Project admin remains a read/write source at the canonical selector-only boundary','false','true'),
 ('inheritance-removed',service,"if (!inheritedProjectGrantAllows(verb, action)) continue;","if (verb !== ('none' as GrantVerb)) continue;",'read Project Grant gives precisely its ordinary Task read/write subset','200','404'),
 ('wildcard-project',grants,'(options.exactOnly','(false && options.exactOnly','exact-only source excludes wildcard Project Grants and Profiles; explicit Task ownership wins over Project ownership','404','200'),
 ('project-profile-inherited',service,"params.push(...seam.bind(principalId, 'project', verb));","params.push(...seam.bind(principalId, 'project', verb));\n          const extra = accessProfileService.activeProfileCondition(paramOffset + params.length);\n          parts.push(renderAuthoritySeam(extra.sql, resource.project));\n          params.push(...extra.bind(principalId, 'project', verb));",'exact-only source excludes wildcard Project Grants and Profiles; explicit Task ownership wins over Project ownership','404','200'),
 ('project-owner-inherited',service,"params.push(...seam.bind(principalId, 'project', verb));","params.push(...seam.bind(principalId, 'project', verb));\n          parts.push(`p.owner_principal_id = ${nextParam(principalId)}`);",'exact-only source excludes wildcard Project Grants and Profiles; explicit Task ownership wins over Project ownership','404','200'),
 ('task-restriction',repo,"restrictedAccess: '(t.restricted_access OR COALESCE(ph.restricted_access, FALSE))'","restrictedAccess: '(FALSE OR COALESCE(ph.restricted_access, FALSE))'",'Task and Phase restrictions disable only inheritance and preserve exact Task grants','404','200'),
 ('phase-restriction',repo,"restrictedAccess: '(t.restricted_access OR COALESCE(ph.restricted_access, FALSE))'","restrictedAccess: '(t.restricted_access OR FALSE)'",'Task and Phase restrictions disable only inheritance and preserve exact Task grants','404','200'),
 ('archived-project',repo,'inheritanceAnchor: "t.project_id IS NOT NULL AND p.status = \'active\'"','inheritanceAnchor: "t.project_id IS NOT NULL"','uses the current own Project, never Phase ancestry, and requires an active existing Project','404','200'),
 ('expiry-ignored',grants,'`AND (g.expires_at IS NULL OR g.expires_at > NOW()) ` +','`AND TRUE ` +','revocation and expiry remove subsequent access without creating Task Grants or changing ownership','404','200'),
 ('membership-ignored',grants,'`WHERE gm.account_principal_id = ${p1}))) `','`WHERE (${p1} IS NOT NULL)))) `','Group membership is live and a disabled principal loses resource access','404','200'),
 ('own-ceiling-bypassed',service,"sides.push(`(${capSql} AND (${sourceParts.join(' OR ')}))`);","sides.push(`(${capSql} OR (${sourceParts.join(' OR ')}))`);",'Connector scopes and every link Task object ceiling intersect inherited authority','404','200'),
 ('agent-bound-cap-bypassed',service,'sql = `(${sql} AND ${resource.id} = ${bound})`;','sql = `(${sql} OR ${resource.id} = ${bound})`;','ordinary Agent mint retains its bound Task write cap after live parent authority changes','403','200'),
 ('intermediate-link-bypassed',service,'for (let index = 0; index < chain.length; index += 1) {','for (let index = 0; index < chain.length; index += 1) {\n      if (chain.length === 3 && index === 1 && chain[0].kind === \'agent\') continue;','a legitimately minted three-link Agent remains bounded by its intermediate Connector','404','200'),
 # 1e0f3bd4: the nested Phase list computes the Phase read decision and then
 # discards it (compiles; the shared helper stays imported and called).
 ('project-phase-list-unfiltered','backend/src/routes/projects.ts','const phases = await filterReadablePhases(req as AuthRequest, listedPhases);','const phases = await filterReadablePhases(req as AuthRequest, listedPhases).then(() => listedPhases);',phase_list,'"listed beyond the point-allowed set (includeArchived=false): "','"listed beyond the point-allowed set (includeArchived=false): sealed"',parity),
 ('warrant-phase-anchor-unconcealed','backend/src/routes/warrants.ts',"|| (row.anchor_type === 'phase' && !readableAnchorPhases.has(String(row.anchor_id)));","|| (row.anchor_type === 'phase' && !readableAnchorPhases.has(String(row.anchor_id)) && false);",phase_anchor,'"sealed anchor concealed: true"','"sealed anchor concealed: false"',parity),
 # bdf7b876: the Project read decision is computed for every Project anchor
 # and then ignored (compiles; the predicate stays called).
 ('warrant-project-anchor-unconcealed','backend/src/routes/warrants.ts',"|| (row.anchor_type === 'project' && !readableAnchorProjects.has(String(row.anchor_id)))","|| (row.anchor_type === 'project' && !readableAnchorProjects.has(String(row.anchor_id)) && false)",project_anchor,'"sealed project anchor concealed: true"','"sealed project anchor concealed: false"',parity),
 # E338: the one resolver asks the Phase read decision and then ignores it
 # (compiles; the decision stays called), so every Brief altitude shows it.
 ('brief-phase-decision-ignored','backend/src/utils/briefPhase.ts',"return readable.has(id) ? { kind: 'readable', phase } : { kind: 'restricted', id };","return readable.has(id) || id.length > 0 ? { kind: 'readable', phase } : { kind: 'restricted', id };",brief_task,'"task-only account leaked: "','"task-only account leaked: parity brief sealed phase',parity),
 # E338: the task altitude decides as root instead of as its caller.
 ('task-brief-decides-as-root','backend/src/utils/promptTemplate.ts',"await resolveBriefPhase(task.phaseId, options.actor, task.id);","await resolveBriefPhase(task.phaseId, options.actor ? { ...options.actor, scopes: ['root'] } : options.actor, task.id);",brief_task,'"task-only account leaked: "','"task-only account leaked: parity brief sealed phase',parity),
 # E338: the project altitude decides as root instead of as its caller.
 ('project-brief-decides-as-root','backend/src/routes/projects.ts',"authReq.authorizationActor ?? actorFromRequest(authReq), taskId);","{ ...(authReq.authorizationActor ?? actorFromRequest(authReq)), scopes: ['root'] }, taskId);",brief_project,'"project reader leaked: "','"project reader leaked: parity brief sealed phase',parity),
]
controls=[c if len(c)==8 else (*c,suite) for c in controls]
selected=[c for c in controls if not args.control or c[0] in args.control]
assert not args.control or len(selected)==len(set(args.control)),'Unknown control'
for _,file,a,b,*_ in selected:once((root/file).read_text(),a,b)
suites=sorted({c[7] for c in selected},key=lambda path:(path!=suite,path))
if args.describe:
 print(json.dumps([{'name':c[0],'file':c[1],'suite':c[7],'selector':c[4],'expected':c[5],'mutant':c[6]} for c in selected],indent=2));raise SystemExit(0)
u=urlparse(os.environ.get('RELAYHALL_TEST_DB_URL',''));database=unquote(u.path.lstrip('/'))
assert u.scheme in ['postgres','postgresql'] and database not in ['relayhall','relayhall_dev','relayhall_tst','relayhall_prod']
assert (u.hostname in ['127.0.0.1','localhost','::1'] and re.search('test|contract|fixture',database)) or (os.environ.get('CI')=='true' and u.hostname=='postgres' and database=='relayhall_ci'),'Explicit disposable DB required'
assert args.output_dir
out=args.output_dir.resolve();assert out!=root and root not in out.parents
out.mkdir(parents=True,exist_ok=False)
def fingerprints(tree):
 files={}
 for p in tree.rglob('*'):
  if p.is_file() and not any(fnmatch.fnmatch(part,pat) for part in p.relative_to(tree).parts for pat in ['.git','graphify-out','node_modules','dist','coverage','__pycache__','.pytest_cache','*.log','.env*']):files[str(p.relative_to(tree))]=hashlib.sha256(p.read_bytes()).hexdigest()
 return files
original=fingerprints(root);(out/'inputs.json').write_text(json.dumps(original,indent=2))
copy=Path(tempfile.mkdtemp(prefix='rh-inheritance-proof-'))
(out/'copy-path.txt').write_text(str(copy))
receipts=[]
try:
 shutil.copytree(root,copy,dirs_exist_ok=True,ignore=shutil.ignore_patterns('.git','graphify-out','node_modules','dist','coverage','.env*','*.log','__pycache__','.pytest_cache'))
 (copy/'backend/node_modules').symlink_to((root/'backend/node_modules').resolve(),target_is_directory=True)
 # Include root guidance/version assets used by actual Agent Brief compilation.
 assert fingerprints(copy)==original,'Copied input set differs'
 def execute(label,selector=None,target_suite=suite):
  report=out/(label+'.json');command=['node','node_modules/jest/bin/jest.js','--runInBand','--testPathIgnorePatterns=/node_modules/','--runTestsByPath',target_suite,'--json','--outputFile='+str(report)]
  if selector:command+=['--testNamePattern',re.escape(selector)]
  # listPointParity sweeps the point route per fixture and carries its own
  # 180 s hook budget, so its run gets the wider subprocess ceiling.
  with (out/(label+'.log')).open('w') as log:code=subprocess.run(command,cwd=copy/'backend',stdout=log,stderr=subprocess.STDOUT,timeout=240 if target_suite==suite else 600).returncode
  result=json.loads(report.read_text()) if report.exists() else {}
  active=[a for f in result.get('testResults',[]) for a in f.get('assertionResults',[]) if a.get('status')!='pending']
  return code,result,active
 baselines={}
 for target_suite in suites:
  label='baseline' if target_suite==suite else 'baseline-'+Path(target_suite).stem
  code,result,active=execute(label,target_suite=target_suite);assert code==0 and active and all(a['status']=='passed' for a in active),label+' is not green'
  baselines[target_suite]={a['title'] for a in active}
 baseline_titles=baselines.get(suite,set())
 # Predeclared class-wide effects. Shared source invariants necessarily
 # participate in multiple assertions; execute all of them and require the
 # exact failing set, with every other assertion remaining green.
 expected_sets={
  'inheritance-removed':baseline_titles-{'exact-only source excludes wildcard Project Grants and Profiles; explicit Task ownership wins over Project ownership'},
  'admin-inheritance-widened':{'admin Project Grant gives precisely its ordinary Task read/write subset','Project admin remains a read/write source at the canonical selector-only boundary'},
  'task-restriction':{'Task and Phase restrictions disable only inheritance and preserve exact Task grants','point, paginated SQL list, HTTP search and selector coverage agree before and after revocation'},
  'agent-bound-cap-bypassed':{'ordinary Agent mint retains its bound Task write cap after live parent authority changes','a legitimately minted three-link Agent remains bounded by its intermediate Connector'},
 }
 # The nested list mutation reddens every list assertion: the phases:read
 # reader's point-anchored equality (primary), the plain Project reader's, and
 # (bdf7b876) the grantee's and the owner case's negative control, each of
 # which an unfiltered list hands a Phase its point route refuses.
 expected_sets['project-phase-list-unfiltered']={phase_list,phase_list_plain,phase_grantee,phase_owner}
 # E338: the shared resolver serves both altitudes, so ignoring its decision
 # reddens every Brief assertion; the task altitude's own caller swap reddens
 # the three task-altitude transports and leaves the project altitude green.
 expected_sets['brief-phase-decision-ignored']={brief_task,brief_agentsmd,brief_mcp,brief_project}
 expected_sets['task-brief-decides-as-root']={brief_task,brief_agentsmd,brief_mcp}
 for control in selected:expected_sets.setdefault(control[0],{control[4]})
 assert all(expected_sets[c[0]]<=baselines[c[7]] for c in selected),'A declared oracle is absent'
 (out/'expected-failing-sets.json').write_text(json.dumps({k:sorted(v) for k,v in expected_sets.items()},indent=2))
 for name,file,a,b,selector,expected,actual,target_suite in selected:
  baseline_titles=baselines[target_suite]
  target=copy/file;source=target.read_text();target.write_text(once(source,a,b))
  try:
   code,result,active=execute(name+'-red',target_suite=target_suite)
   failed=[a for a in active if a['status']=='failed']
   primary=[a for a in failed if a['title']==selector]
   errors='\n'.join(m for a in failed for m in a.get('failureMessages',[]));errors=re.sub(r'\x1b\[[0-9;]*m','',errors)
   primary_errors=re.sub(r'\x1b\[[0-9;]*m','', '\n'.join(m for a in primary for m in a.get('failureMessages',[])))
   valid=code!=0 and {a['title'] for a in active}==baseline_titles and {a['title'] for a in failed}==expected_sets[name] and len(primary)==1
   valid=valid and f'Expected: {expected}' in primary_errors and f'Received: {actual}' in primary_errors
   valid=valid and all('expect(received)' in '\n'.join(a.get('failureMessages',[])) for a in failed)
   valid=valid and not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED|22P02|23503|23514',errors)
   assert valid, name+' did not fail at its intended HTTP/state assertion'
  finally:target.write_text(source)
  code,result,active=execute(name+'-restored',selector,target_suite);assert code==0 and len(active)==1 and active[0]['status']=='passed',name+' restoration failed'
  receipts.append({'name':name,'suite':target_suite,'selector':selector,'semanticRed':True,'expectedFailures':sorted(expected_sets[name]),'restored':True});(out/'receipts.json').write_text(json.dumps(receipts,indent=2));print(name,'red/restored PASS',flush=True)
 for target_suite in suites:
  label='final-restored' if target_suite==suite else 'final-restored-'+Path(target_suite).stem
  code,result,active=execute(label,target_suite=target_suite);assert code==0 and {a['title'] for a in active}==baselines[target_suite] and all(a['status']=='passed' for a in active),label+' is not green'
 assert fingerprints(root)==original and fingerprints(copy)==original,'Input bytes/file set changed'
finally:
 assert copy.parent==Path(tempfile.gettempdir()) and copy.name.startswith('rh-inheritance-proof-')
 shutil.rmtree(copy)
 (out/'closure.json').write_text(json.dumps({'sourceUnchanged':fingerprints(root)==original,'copyRemoved':not copy.exists(),'controls':len(receipts)},indent=2))
