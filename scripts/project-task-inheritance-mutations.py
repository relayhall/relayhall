#!/usr/bin/env python3
"""Exact Project inheritance controls in disposable byte copies; real PG required.
Never starts/stops a database. Never edits the source worktree or its tests.
--describe validates literal mutation anchors without database access.
"""
import argparse,fnmatch,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
from urllib.parse import urlparse,unquote
parser=argparse.ArgumentParser();parser.add_argument('--output-dir',type=Path);parser.add_argument('--describe',action='store_true');parser.add_argument('--control',action='append');args=parser.parse_args()
os.umask(0o077)
root=Path(__file__).resolve().parents[1]
service='backend/src/services/AuthorizationService.ts';repo='backend/src/services/AuthorizationRepository.ts';grants='backend/src/services/GrantService.ts'
suite='src/__tests__/projectTaskGrantInheritanceLive.test.ts'
def once(s,a,b):
 assert s.count(a)==1,('anchor count',s.count(a),a[:90]);return s.replace(a,b,1)
controls=[
 ('list-inheritance-omitted',repo,'render: (paramOffset: number) => authorizationService.sqlCondition(actor, action, resource, paramOffset),',"render: (paramOffset: number) => authorizationService.sqlCondition(actor, action, { ...resource, inheritanceAnchor: 'FALSE' }, paramOffset),",'point, paginated SQL list, HTTP search and selector coverage agree before and after revocation','2','0'),
 ('read-inheritance-widened',service,"grantAllows(verb === 'admin' ? 'write' : verb, action)","grantAllows(verb === 'admin' || verb === 'read' ? 'write' : verb, action)",'read Project Grant gives precisely its ordinary Task read/write subset','403','200'),
 ('admin-inheritance-widened',service,"return (verb === 'read' || verb === 'write' || verb === 'admin')\n    && grantAllows('write', action)\n    && grantAllows(verb === 'admin' ? 'write' : verb, action);","return grantAllows(verb, action);",'Project admin remains a read/write source at the canonical selector-only boundary','false','true'),
 ('inheritance-removed',service,"if (!inheritedProjectGrantAllows(verb, action)) continue;","if (verb !== ('none' as GrantVerb)) continue;",'read Project Grant gives precisely its ordinary Task read/write subset','200','404'),
 ('wildcard-project',grants,'(options.exactOnly','(false && options.exactOnly','exact-only source excludes wildcard Project Grants, Project Profiles and Project ownership','404','200'),
 ('project-profile-inherited',service,"params.push(...seam.bind(principalId, 'project', verb));","params.push(...seam.bind(principalId, 'project', verb));\n          const extra = accessProfileService.activeProfileCondition(paramOffset + params.length);\n          parts.push(renderAuthoritySeam(extra.sql, resource.project));\n          params.push(...extra.bind(principalId, 'project', verb));",'exact-only source excludes wildcard Project Grants, Project Profiles and Project ownership','404','200'),
 ('project-owner-inherited',service,"params.push(...seam.bind(principalId, 'project', verb));","params.push(...seam.bind(principalId, 'project', verb));\n          parts.push(`p.owner_principal_id = ${nextParam(principalId)}`);",'exact-only source excludes wildcard Project Grants, Project Profiles and Project ownership','404','200'),
 ('task-restriction',repo,"restrictedAccess: '(t.restricted_access OR COALESCE(ph.restricted_access, FALSE))'","restrictedAccess: '(FALSE OR COALESCE(ph.restricted_access, FALSE))'",'Task and Phase restrictions disable only inheritance and preserve exact Task grants','404','200'),
 ('phase-restriction',repo,"restrictedAccess: '(t.restricted_access OR COALESCE(ph.restricted_access, FALSE))'","restrictedAccess: '(t.restricted_access OR FALSE)'",'Task and Phase restrictions disable only inheritance and preserve exact Task grants','404','200'),
 ('archived-project',repo,'inheritanceAnchor: "t.project_id IS NOT NULL AND p.status = \'active\'"','inheritanceAnchor: "t.project_id IS NOT NULL"','uses the current own Project, never Phase ancestry, and requires an active existing Project','404','200'),
 ('expiry-ignored',grants,'`AND (g.expires_at IS NULL OR g.expires_at > NOW()))`','`AND TRUE)`','revocation and expiry remove subsequent access without creating Task Grants or changing ownership','404','200'),
 ('membership-ignored',grants,'`WHERE gm.account_principal_id = ${p1}))) `','`WHERE (${p1} IS NOT NULL)))) `','Group membership is live and a disabled principal loses resource access','404','200'),
 ('own-ceiling-bypassed',service,"sides.push(`(${capSql} AND (${sourceParts.join(' OR ')}))`);","sides.push(`(${capSql} OR (${sourceParts.join(' OR ')}))`);",'Connector scopes and every link Task object ceiling intersect inherited authority','404','200'),
 ('agent-bound-cap-bypassed',service,'sql = `(${sql} AND ${resource.id} = ${bound})`;','sql = `(${sql} OR ${resource.id} = ${bound})`;','ordinary Agent mint retains its bound Task write cap after live parent authority changes','403','200'),
 ('intermediate-link-bypassed',service,'for (let index = 0; index < chain.length; index += 1) {','for (let index = 0; index < chain.length; index += 1) {\n      if (chain.length === 3 && index === 1 && chain[0].kind === \'agent\') continue;','a legitimately minted three-link Agent remains bounded by its intermediate Connector','404','200'),
]
selected=[c for c in controls if not args.control or c[0] in args.control]
assert not args.control or len(selected)==len(set(args.control)),'Unknown control'
for _,file,a,b,*_ in selected:once((root/file).read_text(),a,b)
if args.describe:
 print(json.dumps([{'name':c[0],'file':c[1],'selector':c[4],'expected':c[5],'mutant':c[6]} for c in selected],indent=2));raise SystemExit(0)
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
 def execute(label,selector=None):
  report=out/(label+'.json');command=['node','node_modules/jest/bin/jest.js','--runInBand','--testPathIgnorePatterns=/node_modules/','--runTestsByPath',suite,'--json','--outputFile='+str(report)]
  if selector:command+=['--testNamePattern',re.escape(selector)]
  with (out/(label+'.log')).open('w') as log:code=subprocess.run(command,cwd=copy/'backend',stdout=log,stderr=subprocess.STDOUT,timeout=240).returncode
  result=json.loads(report.read_text()) if report.exists() else {}
  active=[a for f in result.get('testResults',[]) for a in f.get('assertionResults',[]) if a.get('status')!='pending']
  return code,result,active
 code,result,active=execute('baseline');assert code==0 and active and all(a['status']=='passed' for a in active),'Baseline is not green'
 baseline_titles={a['title'] for a in active}
 # Predeclared class-wide effects. Shared source invariants necessarily
 # participate in multiple assertions; execute all of them and require the
 # exact failing set, with every other assertion remaining green.
 expected_sets={
  'inheritance-removed':baseline_titles-{'exact-only source excludes wildcard Project Grants, Project Profiles and Project ownership'},
  'admin-inheritance-widened':{'admin Project Grant gives precisely its ordinary Task read/write subset','Project admin remains a read/write source at the canonical selector-only boundary'},
  'task-restriction':{'Task and Phase restrictions disable only inheritance and preserve exact Task grants','point, paginated SQL list, HTTP search and selector coverage agree before and after revocation'},
  'agent-bound-cap-bypassed':{'ordinary Agent mint retains its bound Task write cap after live parent authority changes','a legitimately minted three-link Agent remains bounded by its intermediate Connector'},
 }
 for control in selected:expected_sets.setdefault(control[0],{control[4]})
 assert all(titles<=baseline_titles for titles in expected_sets.values()),'A declared oracle is absent'
 (out/'expected-failing-sets.json').write_text(json.dumps({k:sorted(v) for k,v in expected_sets.items()},indent=2))
 for name,file,a,b,selector,expected,actual in selected:
  target=copy/file;source=target.read_text();target.write_text(once(source,a,b))
  try:
   code,result,active=execute(name+'-red')
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
  code,result,active=execute(name+'-restored',selector);assert code==0 and len(active)==1 and active[0]['status']=='passed',name+' restoration failed'
  receipts.append({'name':name,'selector':selector,'semanticRed':True,'expectedFailures':sorted(expected_sets[name]),'restored':True});(out/'receipts.json').write_text(json.dumps(receipts,indent=2));print(name,'red/restored PASS',flush=True)
 code,result,active=execute('final-restored');assert code==0 and {a['title'] for a in active}==baseline_titles and all(a['status']=='passed' for a in active),'Final full restoration is not green'
 assert fingerprints(root)==original and fingerprints(copy)==original,'Input bytes/file set changed'
finally:
 assert copy.parent==Path(tempfile.gettempdir()) and copy.name.startswith('rh-inheritance-proof-')
 shutil.rmtree(copy)
 (out/'closure.json').write_text(json.dumps({'sourceUnchanged':fingerprints(root)==original,'copyRemoved':not copy.exists(),'controls':len(receipts)},indent=2))
