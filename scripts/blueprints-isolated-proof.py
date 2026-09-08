#!/usr/bin/env python3
"""Run UI/transport mutation drivers against a temporary source-only copy."""
import argparse,hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--kind',choices=['frontend','transport'],required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('controls',nargs='*');args=p.parse_args()
root=Path(__file__).resolve().parents[1];out=args.output.resolve();assert root!=out and root not in out.parents,'Evidence must be outside source';out.mkdir(parents=True,exist_ok=False)
env=os.environ.copy()
for key in list(env):
 if key.startswith(('DB_','PG')) or key in ['DATABASE_URL','RELAYHALL_TEST_DB_URL']:env.pop(key,None)
env['NODE_ENV']='test'
with tempfile.TemporaryDirectory(prefix='rh-blueprint-'+args.kind+'-') as temporary:
 copied=Path(temporary)/'source';copied.mkdir();fingerprints={}
 for directory in (['frontend'] if args.kind=='frontend' else ['backend','cli']):
  shutil.copytree(root/directory,copied/directory,ignore=shutil.ignore_patterns('node_modules','dist','coverage','.env*','*.log','__pycache__','.pytest_cache'))
  dependency=root/directory/'node_modules'
  if dependency.exists():(copied/directory/'node_modules').symlink_to(dependency.resolve(),target_is_directory=True)
  for source in (copied/directory).rglob('*'):
   if source.is_file() and 'node_modules' not in source.parts:fingerprints[str(source.relative_to(copied))]=hashlib.sha256(source.read_bytes()).hexdigest()
 (out/'source-sha256.json').write_text(json.dumps(fingerprints,indent=2))
 if args.kind=='frontend':
  command=['python3',str(root/'scripts/blueprints-frontend-mutations.py'),'--root',str(copied),'--output',str(out/'controls')]
  for control in args.controls:command.extend(['--control',control])
 else:command=['python3',str(root/'scripts/blueprints-transport-mutations.py'),str(copied),str(out/'controls'),*args.controls]
 result=subprocess.run(command,env=env,check=False)
 assert all(hashlib.sha256((root/name).read_bytes()).hexdigest()==sha for name,sha in fingerprints.items()),'Live source changed during proof'
 assert all(hashlib.sha256((copied/name).read_bytes()).hexdigest()==sha for name,sha in fingerprints.items()),'Source mutation was not restored'
 raise SystemExit(result.returncode)
