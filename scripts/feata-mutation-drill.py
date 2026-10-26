#!/usr/bin/env python3
"""FEAT-A controls: prove a green baseline, then one red mutation at a time.

Run from any directory, with the same disposable DB environment as
test:task-write-fields. Every edited file is restored from its exact original
bytes in finally; this never checks out, resets or discards a working tree.
JSON assertion receipts and logs default to the ignored tmp directory.
A run that ends the drill without a red proof (a baseline that is not green,
no JSON, a runtime error) first prints its failed assertions and the tail of
its log, because no CI job keeps that directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BE = 'backend/src/utils/taskWriteFields.ts'
PG = 'backend/src/utils/dueAtResolver.ts'
DB = 'backend/src/services/TaskManagerDB.ts'
INPUT = 'frontend/src/components/tasks/taskFieldEditors.tsx'
DETAIL = 'frontend/src/pages/TaskDetailPage.tsx'
CREATE = 'frontend/src/pages/TaskCreatePage.tsx'

# Each tuple names the control class, command group, focused assertion selector,
# and exact source replacement(s). Anchors must exist exactly once.
MUTATIONS = [
 ('create-drops-notes','backend','notes',[(DB,'          (data.notes as string | null | undefined) ?? null,','          null,')]),
 ('create-drops-due','backend','dueAt',[(DB,'          data.dueAt ?? null,','          null,')]),
 ('update-drops-due','backend','dueAt',[(DB,"      if (updates.dueAt !== undefined) addField('due_at', updates.dueAt);",'      // Mutation: omit the update')]),
 ('read-truncates-microseconds','backend','every canonical read path',[(DB,'  return row.due_at_iso;',"  return new Date(String(row.due_at)).toISOString();")]),
 ('truncate-written-fraction','backend','microsecond instant|sub-second digits',[(BE,"  const micros = (fraction ?? '').padEnd(DUE_AT_FRACTIONAL_DIGITS, '0');","  const micros = (fraction ?? '').slice(0, 3).padEnd(DUE_AT_FRACTIONAL_DIGITS, '0');")]),
 ('admit-too-fine-precision','backend','one digit past the column|seventh digit',[(BE,'fraction.length > DUE_AT_FRACTIONAL_DIGITS','fraction.length > 9')]),
 ('corrupt-both-notes-surfaces','backend','notes',[(BE,'  return value;',"  return value + 'corrupted';")]),
 ('omit-gap-round-trip','backend','local time that names NO instant',[(BE,'  return candidate.backLocal === parts.canonicalLocal;','  return candidate.backLocal.length > 0 && parts.canonicalLocal.length > 0;')]),
 ('omit-range-refusal','backend','ends of the calendar',[(PG,'offsetSeconds, inRange: row.in_range === true','offsetSeconds, inRange: true')]),
 ('change-fold-policy','backend','local time that names TWO instants',[(PG,'wall AT TIME ZONE zone AS t',"((wall - interval '26 hours') AT TIME ZONE zone) + interval '26 hours' AS t")]),
 ('round-historical-offset','backend','historical offset carrying SECONDS',[(PG,'wall AT TIME ZONE zone AS t',"wall AT TIME ZONE zone + make_interval(secs => mod(EXTRACT(EPOCH FROM ((wall AT TIME ZONE zone AT TIME ZONE zone) - (wall AT TIME ZONE zone AT TIME ZONE 'UTC')))::integer, 60)) AS t")]),
 ('restore-narrow-offset-parser','backend','complete accepted numeric offset domain',[(BE,'    parts.sqlLocal,','    `${parts.sqlLocal}${offsetInterval.slice(0, 6)}`, '),(PG,'$1::timestamp AT TIME ZONE $2::interval AS t','$1::timestamptz AS t')]),
 ('restore-browser-conversion','timezone','browser constructs no instant|submitted|CLOCK',[(INPUT,"          onChange({ local: canonicalDateTimeLocal(next), zone: browserTimeZone() });","          onChange(new Date(canonicalDateTimeLocal(next)).toISOString());")]),
 ('restore-offset-api','timezone','timezone OFFSET',[(INPUT,"          onChange({ local: canonicalDateTimeLocal(next), zone: browserTimeZone() });","          void new Date(next).getTimezoneOffset();\n          onChange({ local: canonicalDateTimeLocal(next), zone: browserTimeZone() });")]),
 ('reinterpret-unchanged-deadline','timezone','deadline nobody edited',[(INPUT,'if (value && canonicalDateTimeLocal(next) === canonicalDateTimeLocal(rendered))','if (false && value && canonicalDateTimeLocal(next) === canonicalDateTimeLocal(rendered))')]),
 ('limit-unchanged-year-width','timezone','year9999',[(INPUT,r'/^\d{4,}-',r'/^\d{4}-')]),
 ('guess-unknown-zone','frontend','missing browser timezone',[(INPUT,"return zone && zone.length > 0 ? zone : '';","return zone && zone.length > 0 ? zone : 'UTC';")]),
 ('close-editor-before-refusal','frontend','refusal keeps the typed deadline',[(DETAIL,'update({ dueAt: dueDraft }, endEditor);','update({ dueAt: dueDraft }); endEditor();')]),
 ('drop-create-resolution-receipt','frontend','server-selected offset to the destination',[(CREATE,'navigate(`/tasks/${data.task.id}`, { state: { dueAtResolution: data.dueAtResolution } });','navigate(`/tasks/${data.task.id}`);')]),
 ('drop-refusal-description','frontend','refusal keeps the typed deadline',[(INPUT,'aria-describedby={refusal ? refusalId : (value ? absoluteId : undefined)}','aria-describedby={value ? absoluteId : undefined}')]),
]

# Card d4315f28: how much of a failing runner's evidence reaches the CI log.
# The failed assertions carry the diagnosis; the log tail carries whatever
# happened outside an assertion (a suite that did not load, a crash).
FAILURE_MESSAGE_LINES = 80
LOG_TAIL_LINES = 200

# Card 696f3bb8: the budget of ONE runner invocation. The frontend baseline is
# the Task details suite plus two small files; once that suite stopped failing
# fast at its old 5000 ms test budget, its baseline outlived the former 600 s
# on one core shared four ways (the card's starvation drill). Each CI job's
# own timeout still bounds the step.
RUN_TIMEOUT_SECONDS = 1800

def clip(text, limit):
 lines = text.splitlines()
 if len(lines) <= limit: return text
 return '\n'.join(lines[:limit] + [f'... ({len(lines) - limit} more lines)'])

def command(group, output, selector=None):
 if group == 'backend':
  cmd=['npm','run','test:task-write-fields','--','--silent','--json','--outputFile',str(output)]
 else:
  cmd=['npm','run','test:unit:tz' if group == 'timezone' else 'test:unit','--',
       '--reporter=json','--outputFile',str(output)]
  if group == 'frontend':
   cmd += ['--run','src/pages/TaskDetailPage.test.tsx','src/pages/TaskCreatePage.test.tsx',
           'src/components/tasks/taskDueDate.test.tsx']
 if selector: cmd += ['--testNamePattern',selector]
 return cmd

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--suite',choices=['backend','frontend','all'],default='all')
 parser.add_argument('--output',default=os.environ.get('RELAYHALL_FEATA_DRILL_OUT',str(ROOT/'tmp/feata-red-proofs')))
 parser.add_argument('--only',help='Run one named mutation after its green baseline')
 parser.add_argument('--from-mutation',help='Resume at a named mutation after fresh baselines')
 args=parser.parse_args()
 selected=[m for m in MUTATIONS if (args.suite=='all' or (m[1]=='backend')==(args.suite=='backend')) and (not args.only or m[0]==args.only)]
 if args.from_mutation:
  start=next(i for i,m in enumerate(selected) if m[0]==args.from_mutation)
  selected=selected[start:]
 if not selected: raise RuntimeError('No mutations selected')
 out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
 paths={rel for m in selected for rel,_,_ in m[3]}
 originals={rel:(ROOT/rel).read_bytes() for rel in paths}
 fingerprint={rel:hashlib.sha256(data).hexdigest() for rel,data in originals.items()}
 env=os.environ.copy();env.update(RELAYHALL_DUE_ZONE_SEED='16092026',RELAYHALL_DUE_SEED='16092026')
 receipts=[]
 def explain(label,code):
  # Card d4315f28: print what the runner said, so a red run is diagnosable
  # from the CI log alone. It reads only the files run() wrote, and a fault in
  # it is printed rather than raised, so the caller's own error still follows.
  print(f'---- {label}: runner exit {code}; its output follows ----',flush=True)
  try:
   result_file=out/(label+'.json')
   try:
    result=json.loads(result_file.read_text()) if result_file.exists() else None
   except ValueError as error:
    result=None;print(f'{result_file.name} is not JSON: {error}')
   if result is None:
    print(f'{result_file.name}: no runner JSON')
   else:
    for suite in result.get('testResults',[]):
     failed=[a for a in suite.get('assertionResults',[]) if a.get('status')=='failed']
     if suite.get('status')=='failed' and not failed and suite.get('message'):
      print(f'SUITE FAILED {suite.get("name")}\n{clip(suite["message"],FAILURE_MESSAGE_LINES)}')
     for a in failed:
      print(f'FAILED {a.get("fullName")}')
      for message in a.get('failureMessages') or []:print(clip(message,FAILURE_MESSAGE_LINES))
   log=out/(label+'.log')
   lines=log.read_bytes().decode('utf-8','replace').splitlines() if log.exists() else []
   print(f'---- {log.name}: last {min(len(lines),LOG_TAIL_LINES)} of {len(lines)} lines ----')
   for line in lines[-LOG_TAIL_LINES:]:print(line)
  except Exception as error:
   print(f'could not print the {label} output: {error!r}')
  print(f'---- end of {label} output ----',flush=True)
 def run(label,group,selector=None):
  result_file=out/(label+'.json')
  if result_file.exists():result_file.unlink()
  print(f'{label}: starting',flush=True)
  with (out/(label+'.log')).open('wb') as log:
   process=subprocess.run(command(group,result_file,selector),cwd=ROOT/('backend' if group=='backend' else 'frontend'),
                          env=env,stdout=log,stderr=subprocess.STDOUT,timeout=RUN_TIMEOUT_SECONDS)
  if not result_file.exists():
   explain(label,process.returncode)
   raise RuntimeError(label+': runner produced no JSON assertions')
  result=json.loads(result_file.read_text())
  if result.get('numRuntimeErrorTestSuites',0):
   explain(label,process.returncode)
   raise RuntimeError(label+': runtime error is not a red proof')
  names=sorted(a['fullName'] for f in result['testResults'] for a in f.get('assertionResults',[]) if a['status']=='failed')
  passed=sum(a['status']=='passed' for f in result['testResults'] for a in f.get('assertionResults',[]))
  return process.returncode,names,passed
 try:
  for group in sorted({m[1] for m in selected}):
   code,names,passed=run('baseline-'+group,group)
   if code or names or not passed:
    explain('baseline-'+group,code)
    raise RuntimeError(group+': baseline is not green')
   print(f'{group}: baseline {passed} passed',flush=True)
  for name,group,selector,changes in selected:
   for rel,data in originals.items():
    if (ROOT/rel).read_bytes()!=data:raise RuntimeError('Source changed outside mutation boundary: '+rel)
   try:
    for rel,old,new in changes:
     path=ROOT/rel;s=path.read_text()
     if s.count(old)!=1:raise RuntimeError(name+': anchor is not unique in '+rel)
     path.write_text(s.replace(old,new))
    code,names,passed=run(name,group,selector)
   finally:
    for rel,data in originals.items():(ROOT/rel).write_bytes(data)
   if code==0 or not names:raise RuntimeError(name+': mutation reddened no assertion')
   receipt={'mutation':name,'group':group,'selector':selector,'failed':names,'passed':passed}
   receipts.append(receipt)
   (out/'SUMMARY.json').write_text(json.dumps({'sourceSha256':fingerprint,'mutations':receipts},indent=2))
   print(f'{name}: {len(names)} red assertions, {passed} passed',flush=True)
  print(f'DRILL OK: {len(receipts)} individually applied mutations; original source bytes restored',flush=True)
 finally:
  for rel,data in originals.items():
   if (ROOT/rel).read_bytes()!=data:raise RuntimeError('Source restoration failed: '+rel)

if __name__=='__main__':
 try:
  main()
 except Exception as error:
  print(f'DRILL FAILED: {error}',flush=True)
  raise
