#!/usr/bin/env python3
"""FEAT-A transport controls, copied source only; never connects to PostgreSQL."""
import difflib,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
os.umask(0o077)
root=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('RELAYHALL_FEATA_MCP_DRILL_OUT',str(root/'tmp/feata-mcp-red-proofs'))).resolve()
out.mkdir(parents=True,exist_ok=True)
run_dir=Path(tempfile.mkdtemp(prefix='run-',dir=out)).resolve()
copy=run_dir/'source';copy.mkdir()
registry='src/mcp/registry.ts';spec='src/openapi/spec.ts'
def once(source,before,after):
 assert source.count(before)==1,('Mutation anchor count',source.count(before),before[:90])
 return source.replace(before,after,1)
create="return taskWriteResult(`Created Task ${id8(task.id)} — ${String(task.title ?? '')} (${String(task.status ?? '?')})\\nfull id: ${String(task.id ?? '?')}`, envelope);"
update="return taskWriteResult(`Updated Task ${id8(task.id ?? taskId)} — fields: ${Object.keys(body).join(', ')}${warning}`, envelope);"
create_selector='MCP Task create deadline receipt carries every canonical receipt value: Europe/Warsaw 2026-09-07T19:00:00.123456'
update_selector=create_selector.replace('create','update',1)
controls=[
 ('create-receipt',registry,create_selector,create,create.replace('return taskWriteResult(`','return `').replace('`, envelope);','`;'),'receipt'),
 ('update-receipt',registry,update_selector,update,update.replace('return taskWriteResult(`','return `').replace('`, envelope);','`;'),'receipt'),
 ('open-object',registry,'one exact advertised Task deadline shape refuses malformed structural input: {"local":"2026-09-07T19:00:00","zone":"Europe/Warsaw","instant":"invented"}',"{ type: 'object', additionalProperties: false, required: ['local', 'zone'],","{ type: 'object', additionalProperties: true, required: ['local', 'zone'],",'shape'),
 ('missing-key',registry,'one exact advertised Task deadline shape refuses malformed structural input: {}',"required: ['local', 'zone'],","required: [],",'shape'),
 ('local-type',registry,'one exact advertised Task deadline shape refuses malformed structural input: {"local":1,"zone":"Europe/Warsaw"}',"properties: { local: { type: 'string' }, zone: { type: 'string' } }","properties: { local: {}, zone: { type: 'string' } }",'shape'),
 ('zone-type',registry,'one exact advertised Task deadline shape refuses malformed structural input: {"local":"2026-09-07T19:00:00","zone":null}',"properties: { local: { type: 'string' }, zone: { type: 'string' } }","properties: { local: { type: 'string' }, zone: {} }",'shape'),
 ('fold-wording',spec,'one exact advertised Task deadline shape OpenAPI describes the measured PostgreSQL policy without an earlier-fold promise','PostgreSQL AT TIME ZONE using the post-transition offset','PostgreSQL AT TIME ZONE using the EARLIER occurrence','wording'),
]
env=os.environ.copy()
for key in list(env):
 if key.startswith(('DB_','PG')) or key in ['DATABASE_URL','RELAYHALL_TEST_DB_URL','BOOT_CHECK']:env.pop(key,None)
env.update(DB_HOST='127.0.0.1',DB_PORT='59999',DB_NAME='feata_mcp_none',DB_USER='none',DB_PASSWORD='none',NODE_ENV='test',FORCE_COLOR='0')
digest=lambda data:hashlib.sha256(data).hexdigest()
def hashes(tree):
 return {str(p.relative_to(tree)):digest(p.read_bytes()) for p in (tree/'src').rglob('*') if p.is_file()}
def execute(label,selector):
 report=run_dir/(label+'.json')
 cmd=['node','node_modules/jest/bin/jest.js','--runInBand','--runTestsByPath','src/__tests__/mcpTaskDueAtContract.test.ts','--testNamePattern','^'+re.escape(selector)+'$','--json','--outputFile='+str(report)]
 with (run_dir/(label+'.log')).open('w') as log:result=subprocess.run(cmd,cwd=copy,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180)
 data=json.loads(report.read_text()) if report.exists() else {}
 active=[a for t in data.get('testResults',[]) for a in t.get('assertionResults',[]) if a['status']!='pending']
 return result.returncode,data,active
receipts=[]
try:
 shutil.copytree(root/'backend/src',copy/'src')
 for name in ['package.json','package-lock.json','jest.config.js','tsconfig.json']:shutil.copy2(root/'backend'/name,copy/name)
 (copy/'node_modules').symlink_to((root/'backend/node_modules').resolve(),target_is_directory=True)
 inputs=hashes(copy);assert hashes(root/'backend')==inputs
 (run_dir/'source-sha256.json').write_text(json.dumps({'HEAD':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'driver':digest(Path(__file__).read_bytes()),'inputs':inputs},indent=2))
 for name,relative,selector,before,after,oracle in controls:
  source=copy/relative;original=source.read_bytes();modified=once(original.decode(),before,after).encode()
  code,data,_=execute(name+'-baseline',selector)
  assert code==0 and data.get('numPassedTests')==1 and data.get('numFailedTests')==0,(name,'Baseline not green')
  (run_dir/(name+'.diff')).write_text(''.join(difflib.unified_diff(original.decode().splitlines(True),modified.decode().splitlines(True),fromfile=relative,tofile=relative)))
  try:
   source.write_bytes(modified);code,data,active=execute(name+'-red',selector)
   failed=[a for a in active if a['status']=='failed'];text=re.sub(r'\x1b\[[0-9;]*m','', '\n'.join(failed[0]['failureMessages'])) if len(failed)==1 else ''
   semantic = ('Expected substring:' in text and 'dueAtResolution' in text and 'Received string:' in text) if oracle=='receipt' else ('Expected: false' in text and 'Received: true' in text) if oracle=='shape' else ('Expected substring:' in text and 'post-transition offset' in text and 'EARLIER occurrence' in text)
   red=code!=0 and len(failed)==1 and failed[0]['fullName']==selector and semantic and not re.search(r'TS\d{4}|Test suite failed to run|SyntaxError|ECONNREFUSED|Exceeded timeout',text)
  finally:source.write_bytes(original)
  restored,result,_=execute(name+'-restored',selector)
  row={'name':name,'selector':selector,'baselineGreen':True,'red':red,'redExit':code,'failure':text,'restoredGreen':restored==0 and result.get('numPassedTests')==1 and result.get('numFailedTests')==0,'copyRestored':source.read_bytes()==original,'builderUnchanged':hashes(root/'backend')==inputs}
  receipts.append(row);(run_dir/'summary.json').write_text(json.dumps(receipts,indent=2));print(json.dumps({k:row[k] for k in ['name','red','restoredGreen','copyRestored','builderUnchanged']}),flush=True)
  assert all(row[k] for k in ['red','restoredGreen','copyRestored','builderUnchanged']),(name,'Rejected control evidence')
finally:
 assert copy.parent==run_dir and run_dir.parent==out and copy.name=='source'
 shutil.rmtree(copy)
print('Evidence:',run_dir)
