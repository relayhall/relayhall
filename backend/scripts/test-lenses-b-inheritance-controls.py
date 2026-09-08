#!/usr/bin/env python3
"""Replay LENSES-b creation-default controls on copied source and owned DB copies.
The supplied disposable DB is a read-only template source, never reset or edited.
No source-worktree files are mutated. --describe checks anchors without a DB.
"""
import argparse,fnmatch,hashlib,json,os,re,secrets,shutil,subprocess,tempfile
from pathlib import Path
from urllib.parse import urlparse,urlunparse
p=argparse.ArgumentParser();p.add_argument('--output-dir',type=Path);p.add_argument('--describe',action='store_true');p.add_argument('--control',action='append');args=p.parse_args()
os.umask(0o077)
root=Path(__file__).resolve().parents[2]
MUTATIONS = [['M1 the acting-channel test drops the session-kind half (a scope-only test)', 'backend/src/services/HomeGroupService.ts', '  if (!isLoginSessionKind(actor.authMethod)) return false;', '  if (!isLoginSessionKind(actor.authMethod) && false) return false;'], ['M2 the re-derivation takes NO lock at all', 'backend/src/services/HomeGroupService.ts', "  const share = options.lockForWrite ? ' FOR SHARE' : '';", "  const share = options.lockForWrite ? '' : '';"], ['M3 the act stops re-reading featured', 'backend/src/services/HomeGroupService.ts', "  if (!state.featured) return { resolved: false, reason: 'not_featured' };", "  if (!state.featured && false) return { resolved: false, reason: 'not_featured' };"], ['M4 the act stops re-reading membership', 'backend/src/services/HomeGroupService.ts', "  if (!state.isMember) return { resolved: false, reason: 'not_a_member' };", "  if (!state.isMember && false) return { resolved: false, reason: 'not_a_member' };"], ['M5 the act stops re-reading the Account status', 'backend/src/services/HomeGroupService.ts', "  if (!state.actorActive) return { resolved: false, reason: 'actor_inactive' };", "  if (!state.actorActive && false) return { resolved: false, reason: 'actor_inactive' };"], ['M6 the pointer is not re-read under the lock', 'backend/src/services/HomeGroupService.ts', '  const stillPointing = pointer.rows.length > 0', '  const stillPointing = true || pointer.rows.length > 0'], ['M7 best-effort attachment: the grants are written on the POOL', 'backend/src/services/ProjectService.ts', '      await this.applyCreationDefault(client, id, actor);', '      await this.applyCreationDefault(pool as any, id, actor);'], ['M8 the skip reason is recorded as a free string, not against the closed set', 'backend/src/services/HomeGroupService.ts', '  if (!isCreationDefaultSkipReason(reason)) {', '  if (false && !isCreationDefaultSkipReason(reason)) {'], ['M9 principal status re-read loses its lock (pointer and membership locks retained)', 'backend/src/services/HomeGroupService.ts', '  const actorActive = await isActive(queryable, accountPrincipalId, share);', "  const actorActive = await isActive(queryable, accountPrincipalId, '');"], ['M10 REGRESSION: the pointer re-read loses its lock (round-1 shape)', 'backend/src/services/HomeGroupService.ts', '      WHERE account_principal_id = $1${share}`,', '      WHERE account_principal_id = $1`,'], ['M11 REGRESSION: the membership re-read loses its lock (round-1 shape)', 'backend/src/services/HomeGroupService.ts', '      WHERE group_id = $1 AND account_principal_id = $2${share}`,', '      WHERE group_id = $1 AND account_principal_id = $2`,'], ['M12 the Group DELETE stops locking the row before it counts pointers', 'backend/src/services/GroupService.ts', "      await client.query('SELECT 1 FROM groups WHERE id = $1 FOR UPDATE', [id]);", '      // MUTANT M12'], ['R3-lock', 'backend/src/services/HomeGroupService.ts', "'SELECT id, status FROM principals WHERE id = $1 FOR SHARE', [accountPrincipalId]", "'SELECT id, status FROM principals WHERE id = $1', [accountPrincipalId]"], ['R3-active', 'backend/src/services/HomeGroupService.ts', "if (account.rows.length === 0 || account.rows[0].status !== 'active') {", "if (false && (account.rows.length === 0 || account.rows[0].status !== 'active')) {"], ['R3-root', 'backend/src/routes/principals.ts', "if (!req.scopes?.includes('root')) {", "if (false && !req.scopes?.includes('root')) {"], ['R3-exists', 'backend/src/migrations/128_lenses_featured_home_group_grant_origin.sql', "  IF NOT EXISTS (\n    SELECT 1 FROM pg_constraint c\n    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'provenance'\n     WHERE c.conrelid = 'grants'::regclass", "  IF FALSE AND NOT EXISTS (\n    SELECT 1 FROM pg_constraint c\n    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'provenance'\n     WHERE c.conrelid = 'grants'::regclass"], ['R3-validated', 'backend/src/migrations/128_lenses_featured_home_group_grant_origin.sql', '       AND c.convalidated', '       AND (c.convalidated OR true)'], ['B-L4 contained Task loses its Project source', 'backend/src/services/AuthorizationService.ts', 'if (!inheritedProjectGrantAllows(verb, action)) continue;', "if (verb !== ('none' as GrantVerb)) continue;"], ['R4-token-set same literals lose their operator semantics', 'backend/src/migrations/128_lenses_featured_home_group_grant_origin.sql', '       AND pg_get_expr(c.conbin, c.conrelid, false) = expected_provenance_check', "       AND (SELECT array_agg(DISTINCT m[1] ORDER BY m[1]) FROM regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') AS m) = ARRAY['assignment:grant','assignment:warrant']"], ['R4-extra additional same-literal narrowing constraint ignored', 'backend/src/migrations/128_lenses_featured_home_group_grant_origin.sql', "       AND c.conname <> 'grants_provenance_shape'", "       AND FALSE AND c.conname <> 'grants_provenance_shape'"]]
EXPECTED = {'M1': ['a BEARER credential HOLDING root creates the project and writes no grant', 'and every one of them is GREEN against the live measurements'], 'M2': ['a concurrent transaction that does NOT unfeature serialises the other way: two rows', 'a concurrent unfeature serialises BEFORE the resolution: the act skips', 'and every one of them is GREEN against the live measurements', 'every named assertion the drill owes is present', 'featured cleared, holding ONLY the Group row â†’ not_featured', 'membership removed, holding ONLY the group_members row â†’ not_a_member', 'the pointer cleared, holding ONLY the account_home_groups row â†’ no_home_group'], 'M3': ['a concurrent unfeature serialises BEFORE the resolution: the act skips', 'and every one of them is GREEN against the live measurements', 'losing FEATURED makes it resolve null while the pointer survives, and restoring it needs NO re-write'], 'M4': ['and every one of them is GREEN against the live measurements', 'losing MEMBERSHIP resolves null and names that clause', 'the grant is what OPENS the project: the member reads it, the stranger does not'], 'M5': ['a DISABLED Account resolves null and names that clause', 'and every one of them is GREEN against the live measurements'], 'M6': ['and every one of them is GREEN against the live measurements'], 'M7': ['a forced failure on the SECOND grant insert leaves NO project row', 'every named assertion the drill owes is present'], 'M8': ['every reason the drill actually observed is in the enumeration', 'refuses to record a reason the enumeration does not carry, and writes nothing'], 'M9': ['and every one of them is GREEN against the live measurements'], 'M10': ['and every one of them is GREEN against the live measurements', 'every named assertion the drill owes is present', 'the pointer cleared, holding ONLY the account_home_groups row â†’ no_home_group'], 'M11': ['and every one of them is GREEN against the live measurements', 'every named assertion the drill owes is present', 'membership removed, holding ONLY the group_members row â†’ not_a_member'], 'M12': ['SET vs DELETE: the delete WAITS, then answers the NAMED count-only refusal'], 'R3-lock': ['set commits first: the production acts leave no offboarded pointer', 'terminate commits first: the production acts leave no offboarded pointer'], 'R3-active': ['an inactive target is refused even for a root session', 'terminate commits first: the production acts leave no offboarded pointer'], 'R3-root': ['an operator login cannot set another Account home pointer'], 'R3-exists': ['migration refuses an absent provenance constraint', 'migration refuses an unvalidated provenance constraint', 'migration refuses an same-literal-narrowed provenance constraint', 'migration refuses an same-literal-widened provenance constraint', 'migration refuses an third-literal-widened provenance constraint', 'migration refuses an missing-literal-narrowed provenance constraint'], 'R3-validated': ['migration refuses an unvalidated provenance constraint'], 'B-L4': ['B-L4: the home-group member reads and writes a new unrestricted Task, with live revocation and no Task Grant'], 'R4-token-set': ['migration refuses an same-literal-narrowed provenance constraint', 'migration refuses an same-literal-widened provenance constraint'], 'R4-extra': ['migration refuses an extra-same-literal-check provenance constraint']}
selected=[m for m in MUTATIONS if not args.control or m[0].split()[0] in args.control]
assert not args.control or len(selected)==len(set(args.control)), 'Unknown control'
for label,file,before,after in selected:assert (root/file).read_text().count(before)==1,(label,'anchor mismatch')
if args.describe:
 print(json.dumps([{'name':m[0],'file':m[1],'expectedFailures':EXPECTED[m[0].split()[0]]} for m in selected],indent=2));raise SystemExit(0)
url=urlparse(os.environ.get('RELAYHALL_TEST_DB_URL',''));source_db=url.path.lstrip('/')
assert url.scheme in ('postgres','postgresql') and url.hostname in ('127.0.0.1','localhost','::1')
assert source_db.startswith('relayhall_lenses_b_test') and re.fullmatch('[a-z0-9_]+',source_db),'Explicit owned loopback test database required'
assert args.output_dir;out=args.output_dir.resolve();assert out!=root and root not in out.parents;out.mkdir(parents=True,exist_ok=False)
suffix=secrets.token_hex(6);template='relayhall_lenses_b_test_template_'+suffix;working='relayhall_lenses_b_test_work_'+suffix
assert source_db not in (template,working)
env=os.environ.copy();env.pop('PGOPTIONS',None)
admin_env=env.copy();admin_env['RELAYHALL_CONTROL_ADMIN_URL']=urlunparse(url._replace(path='/postgres'))
env.update(DB_NAME=working,RELAYHALL_TEST_DB_URL=urlunparse(url._replace(path='/'+working)))
def sql(command):
 code="const {Client}=require('pg'); const c=new Client({connectionString:process.env.RELAYHALL_CONTROL_ADMIN_URL}); (async()=>{await c.connect(); try {await c.query(process.argv[1]);} finally {await c.end();}})().catch(e=>{console.error(e.code||'PG_CONTROL_FAILED');process.exitCode=1});"
 subprocess.run(['node','-e',code,command],cwd=root/'backend',env=admin_env,check=True,stdout=subprocess.DEVNULL,timeout=30)
def reset():
 sql('DROP DATABASE IF EXISTS '+working+' WITH (FORCE)');sql('CREATE DATABASE '+working+' TEMPLATE '+template)
def fingerprints(tree):
 result={}
 for path in tree.rglob('*'):
  if path.is_file() and not any(fnmatch.fnmatch(part,pat) for part in path.relative_to(tree).parts for pat in ('.git','graphify-out','node_modules','dist','coverage','__pycache__','.pytest_cache','*.log','.env*')):
   result[str(path.relative_to(tree))]=hashlib.sha256(path.read_bytes()).hexdigest()
 return result
original=fingerprints(root);(out/'inputs.json').write_text(json.dumps(original,indent=2))
copy=Path(tempfile.mkdtemp(prefix='rh-lenses-b-proof-'));(out/'copy-path.txt').write_text(str(copy));receipts=[];template_created=False
try:
 shutil.copytree(root,copy,dirs_exist_ok=True,ignore=shutil.ignore_patterns('.git','graphify-out','node_modules','dist','coverage','.env*','*.log','__pycache__','.pytest_cache'))
 (copy/'backend/node_modules').symlink_to((root/'backend/node_modules').resolve(),target_is_directory=True)
 assert fingerprints(copy)==original
 sql('CREATE DATABASE '+template+' TEMPLATE '+source_db);template_created=True
 def execute(label):
  reset();path=out/(label+'.json')
  with (out/(label+'.log')).open('w') as log:
   rc=subprocess.run(['node','node_modules/jest/bin/jest.js','--runInBand','--testPathIgnorePatterns=/node_modules/','--runTestsByPath','src/__tests__/lensesCreationDefaultLive.test.ts','--json','--outputFile='+str(path)],cwd=copy/'backend',env=env,stdout=log,stderr=subprocess.STDOUT,timeout=300).returncode
  assert path.exists(),label+' produced no assertion receipt'
  data=json.loads(path.read_text());assert data['numTotalTests']==58 and data['numPendingTests']==0,label+' must execute all58'
  failed={a['title'].lstrip('. '):a for suite in data['testResults'] for a in suite['assertionResults'] if a['status']=='failed'}
  assert (rc==0)==(not failed),label+' non-assertion runner failure'
  errors='\n'.join('\n'.join(a.get('failureMessages',[])) for a in failed.values())
  assert not re.search(r'TS\d{4}|SyntaxError|Test suite failed to run|Exceeded timeout|ECONNREFUSED|22P02|23503',errors),label+' unrelated fixture/compiler failure'
  return failed,errors
 failed,_=execute('baseline');assert not failed
 for description,file,before,after in selected:
  name=description.split()[0];target=copy/file;original_bytes=target.read_bytes();text=original_bytes.decode();assert text.count(before)==1
  try:
   target.write_text(text.replace(before,after,1));failed,errors=execute(name+'-red')
   assert set(failed)==set(EXPECTED[name]),(name,sorted(failed),EXPECTED[name])
   assert 'expect(received)' in errors,name+' did not reach an assertion oracle'
  finally:target.write_bytes(original_bytes)
  failed,_=execute(name+'-restored');assert not failed,(name,'restoration failed')
  receipts.append({'name':name,'description':description,'expectedFailures':sorted(EXPECTED[name]),'semanticRed':True,'fullRestored':58});(out/'receipts.json').write_text(json.dumps(receipts,indent=2));print(name,'exact red/full58 restored PASS',flush=True)
 failed,_=execute('final-restored');assert not failed
 assert fingerprints(root)==original and fingerprints(copy)==original
finally:
 if template_created:
  sql('DROP DATABASE IF EXISTS '+working+' WITH (FORCE)');sql('DROP DATABASE '+template+' WITH (FORCE)')
 assert copy.parent==Path(tempfile.gettempdir()) and copy.name.startswith('rh-lenses-b-proof-')
 shutil.rmtree(copy)
 (out/'closure.json').write_text(json.dumps({'sourceUnchanged':fingerprints(root)==original,'copyRemoved':not copy.exists(),'ownedDatabaseCopiesRemoved':template_created,'sourceDatabaseNeverReset':source_db,'controls':len(receipts)},indent=2))
assert len(receipts)==len(selected)
