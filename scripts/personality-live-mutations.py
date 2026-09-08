#!/usr/bin/env python3
"""Run exact semantic controls over byte copies and fresh disposable database copies.

Requires a migrated disposable baseline with no active connections; it is never
changed. Each mutation uses its own PostgreSQL template copy and source copy.
"""
from pathlib import Path
import argparse,hashlib,json,os,re,shutil,subprocess,urllib.parse
ROOT=Path(__file__).resolve().parents[1]
TEST='src/__tests__/personalityVersionLive.test.ts'
# Source mutations exercise the service/SQL boundaries through the live tests.
CASES=[
 ('version-projection','backend/src/utils/personalityVersion.ts','version: resolved_version','version: 1','PV-L10'),
 ('all-content-fields','backend/src/migrations/130_personality_versions.sql',"IF personality_content_snapshot(NEW) IS DISTINCT FROM personality_content_snapshot(OLD) THEN","IF NEW.content IS DISTINCT FROM OLD.content THEN",'PV-L2'),
 ('no-op-preservation','backend/src/migrations/130_personality_versions.sql',"IF personality_content_snapshot(NEW) IS DISTINCT FROM personality_content_snapshot(OLD) THEN","IF TRUE THEN",'PV-L3'),
 ('history-update','backend/src/migrations/130_personality_versions.sql',"IF TG_OP='INSERT' AND pg_trigger_depth()=2 THEN RETURN NEW; END IF;","IF TG_OP='UPDATE' OR (TG_OP='INSERT' AND pg_trigger_depth()=2) THEN RETURN NEW; END IF;",'PV-L4'),
 ('history-insert','backend/src/migrations/130_personality_versions.sql',"IF TG_OP='INSERT' AND pg_trigger_depth()=2 THEN RETURN NEW; END IF;","IF TG_OP='INSERT' THEN RETURN NEW; END IF;",'PV-L4'),
 ('history-delete','backend/src/migrations/130_personality_versions.sql',"IF TG_OP='INSERT' AND pg_trigger_depth()=2 THEN RETURN NEW; END IF;","IF TG_OP='DELETE' THEN RETURN OLD; END IF; IF TG_OP='INSERT' AND pg_trigger_depth()=2 THEN RETURN NEW; END IF;",'PV-L4'),
 ('history-truncate','backend/src/migrations/130_personality_versions.sql',"IF TG_OP='INSERT' AND pg_trigger_depth()=2 THEN RETURN NEW; END IF;","IF TG_OP='TRUNCATE' THEN RETURN NULL; END IF; IF TG_OP='INSERT' AND pg_trigger_depth()=2 THEN RETURN NEW; END IF;",'PV-L4'),
 ('pointer-control','backend/src/migrations/130_personality_versions.sql',"    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.current_version IS DISTINCT FROM OLD.current_version THEN\n      RAISE EXCEPTION 'Personality identity and version pointer are maintained by the database';\n    END IF;",'', 'PV-L5'),
 ('parent-retention','backend/src/migrations/130_personality_versions.sql','  FOR EACH STATEMENT EXECUTE FUNCTION personality_guard_history();','  FOR EACH STATEMENT EXECUTE FUNCTION personality_guard_history();\nALTER TABLE personality_versions DROP CONSTRAINT personality_versions_personality_id_fkey;', 'PV-L5'),
 ('sequence','backend/src/migrations/130_personality_versions.sql','NEW.current_version := OLD.current_version+1;','NEW.current_version := OLD.current_version+2;','PV-L6'),
 ('retirement-write','backend/src/services/PersonalityService.ts',"WHERE id = $1 AND source = 'managed' AND retired_at IS NULL RETURNING *","WHERE id = $1 AND source = 'managed' RETURNING *",'PV-L7'),
 ('feed-commit','backend/src/services/PersonalityService.ts',"      if (current) {\n        await feedEventService.emit(client, {\n          name: 'personality.updated'","      if (current) {\n        await client.query('COMMIT');\n        await feedEventService.emit(client, {\n          name: 'personality.updated'",'PV-L8'),
 ('replay-preservation','backend/src/migrations/130_personality_versions.sql','UPDATE personalities SET current_version=1 WHERE current_version IS NULL;','UPDATE personalities SET current_version=1;','PV-L9'),
]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output-dir',required=True);args=parser.parse_args()
 raw=os.environ.get('RELAYHALL_TEST_DB_URL','');url=urllib.parse.urlparse(raw);db=url.path.lstrip('/')
 if not (url.hostname in ['127.0.0.1','localhost'] or (url.hostname=='postgres' and os.environ.get('CI')=='true')) or not (re.fullmatch(r'personality_contract_[a-z0-9_]+',db) or (db=='relayhall_ci' and os.environ.get('CI')=='true' and url.hostname=='postgres')):raise RuntimeError('Explicit contract baseline required')
 out=Path(args.output_dir).resolve();out.mkdir(mode=0o700,parents=True,exist_ok=False)
 before={str(p.relative_to(ROOT)):sha(p) for p in (ROOT/'backend/src').rglob('*') if p.is_file()}
 copy=out/'private-copy';copy.mkdir()
 tracked=subprocess.check_output(['git','ls-files','-z'],cwd=ROOT).decode().split('\0')
 for relative in filter(None,tracked):
  source=ROOT/relative;destination=copy/relative
  if source.is_file():destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,destination)
 (copy/'backend/node_modules').symlink_to((ROOT/'backend/node_modules').resolve(),target_is_directory=True)
 env={k:v for k,v in os.environ.items() if not k.startswith(('DB_','PG')) and k not in ['DATABASE_URL','RELAYHALL_TEST_DB_URL']}
 env.update(PGHOST=url.hostname,PGPORT=str(url.port or 5432),PGUSER=urllib.parse.unquote(url.username or ''),PGPASSWORD=urllib.parse.unquote(url.password or ''))
 node_sql="""const {Client}=require(process.argv[1]);
const c=new Client({host:process.env.PGHOST,port:Number(process.env.PGPORT),user:process.env.PGUSER,password:process.env.PGPASSWORD,database:process.argv[2]});
(async()=>{await c.connect();try{await c.query(process.argv[3]==='file'?require('fs').readFileSync(process.argv[4],'utf8'):process.argv[4]);}finally{await c.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});"""
 def sql(database,query,is_file=False):
  subprocess.run(['node','-e',node_sql,str(ROOT/'backend/node_modules/pg'),database,'file' if is_file else 'sql',query],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 controls=[];active=None
 def fresh(label):
  nonlocal active
  active='personality_contract_mut_'+os.urandom(6).hex()
  sql('postgres',f'CREATE DATABASE "{active}" TEMPLATE "{db}"')
  env.update(DB_HOST=url.hostname,DB_PORT=str(url.port or 5432),DB_USER=env['PGUSER'],DB_PASSWORD=env['PGPASSWORD'],DB_NAME=active,
    RELAYHALL_TEST_DB_URL=urllib.parse.urlunparse(url._replace(path='/'+active)),NODE_ENV='test')
 def drop():
  nonlocal active
  if active:sql('postgres',f'DROP DATABASE IF EXISTS "{active}"');active=None
 def test(label,selector=None):
  cmd=['node','node_modules/jest/bin/jest.js','--runInBand','--testPathIgnorePatterns=/node_modules/','--runTestsByPath',TEST,'--cacheDirectory='+str(out/'jest-cache'),'--json','--outputFile='+str(out/(label+'.json'))]
  if selector:cmd += ['--testNamePattern','^'+selector+' ']
  with (out/(label+'.log')).open('w') as log:rc=subprocess.run(cmd,cwd=copy/'backend',env=env,stdout=log,stderr=subprocess.STDOUT).returncode
  data=json.loads((out/(label+'.json')).read_text());return rc,data
 try:
  fresh('baseline');rc,data=test('baseline');assert rc==0 and data['numPassedTests']==12;drop()
  for label,rel,old,new,selector in CASES:
   p=copy/rel;original=p.read_bytes();text=original.decode();assert text.count(old)==1,(label,'anchor')
   p.write_text(text.replace(old,new,1));fresh(label)
   if rel.endswith('.sql') and label!='replay-preservation':
    # Replacing trigger bodies in the disposable database activates the
    # exact mutated migration; no author baseline database is changed.
    sql(active,str(p),True)
   rc,data=test(label,selector)
   failed=[a for result in data['testResults'] for a in result.get('assertionResults',[]) if a['status']=='failed']
   assert rc!=0 and len(failed)==1 and failed[0]['fullName'].startswith(selector+' '),(label,'wrong failure set')
   message=re.sub(r'\x1b\[[0-9;]*m','',''.join(failed[0].get('failureMessages',[])))
   tokens={'version-projection':['Expected: 2','Received: 1'],'all-content-fields':['Expected: 2','Received: 1'],
     'no-op-preservation':['Expected: 1','Received: 3'],'sequence':['Expected: 3','Received: 5'],
     'retirement-write':['toBeNull'],'feed-commit':['content','fail'],
     'replay-preservation':['Personality identity and version pointer']}.get(label,['resolved instead of rejected'])
   assert all(token.lower() in message.lower() for token in tokens),(label,'semantic failure mismatch',message[:300])
   controls.append({'name':label,'assertion':failed[0]['fullName'],'red':True});drop();p.write_bytes(original)
   fresh(label+'-restored');rc,data=test(label+'-restored',selector);assert rc==0 and data['numPassedTests']==1;drop()
  fresh('restored');rc,data=test('restored');assert rc==0 and data['numPassedTests']==12;drop()
  after={str(p.relative_to(ROOT)):sha(p) for p in (ROOT/'backend/src').rglob('*') if p.is_file()};assert after==before
  (out/'receipt.json').write_text(json.dumps({'status':'PASS','controls':controls,'baseline':12,'restored':12,'authorInputsUnchanged':True,'sourceHashes':before,'scriptSha256':sha(Path(__file__))},indent=2))
 finally:
  try:drop()
  finally:
   assert copy.parent==out and copy.name=='private-copy';shutil.rmtree(copy)
 print('PASS: 12 baseline/restored and '+str(len(CASES))+' exact live semantic controls; source and baseline database unchanged')
if __name__=='__main__':main()
