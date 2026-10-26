#!/usr/bin/env python3
"""Offline fixture-budget and safe-log evidence tests. No DB or child launch."""
import ast,contextlib,importlib.util,io,json,pathlib,stat,subprocess,tempfile,unittest
from unittest.mock import patch
SOURCE=pathlib.Path(__file__).with_name('blueprints-examples-live.py')
spec=importlib.util.spec_from_file_location('blueprint_examples_budget_subject',SOURCE)
subject=importlib.util.module_from_spec(spec);spec.loader.exec_module(subject)
SAFE_A='137_native_generation_coordination.sql';SAFE_B='138_task_report_workflow.sql'
SECRET='TEST_ONLY_SECRET_TOKEN_ABC123'
class BudgetTests(unittest.TestCase):
 def exercise(self,behavior,label='a-migrate',timeout=300):
  with tempfile.TemporaryDirectory() as tmp:
   folder=pathlib.Path(tmp);stdout=io.StringIO();seen=[];error=None
   def fake(command,**kw):
    seen.append(kw['timeout']);kw['stdout'].write(('▶️  Running: '+SAFE_A+'\n✅ Completed: '+SAFE_A+'\n▶️  Running: '+SAFE_B+'\n'+SECRET+'\n').encode())
    if isinstance(behavior,BaseException):raise behavior
    return subprocess.CompletedProcess(command,behavior)
   with patch.object(subject.subprocess,'run',side_effect=fake),patch.object(subject.subprocess,'Popen',side_effect=AssertionError('Offline tests cannot launch')),contextlib.redirect_stdout(stdout):
    try:value=subject.run_phase(label,['npm','run','migrate'],{'DB_PASSWORD':SECRET},folder,folder,timeout,{SAFE_A,SAFE_B})
    except BaseException as caught:error=caught;value=None
   log=folder/(label+'.log');raw=log.read_bytes();mode=stat.S_IMODE(log.stat().st_mode)
   events=[json.loads(line)['fixturePhase'] for line in stdout.getvalue().splitlines()]
   self.assertNotIn(SECRET,stdout.getvalue());self.assertEqual(mode,0o600);self.assertIn(SECRET.encode(),raw)
   return value,error,events,seen
 def test_success_retains_actual_exit_and_safe_progress(self):
  value,error,events,seen=self.exercise(0)
  self.assertEqual(value,0);self.assertIsNone(error);self.assertEqual(seen,[300]);self.assertEqual(events[-1]['exitCode'],0)
  self.assertEqual(events[-1]['lastCompleted'],SAFE_A);self.assertEqual(events[-1]['lastRunning'],SAFE_B);self.assertEqual(events[-1]['completionCount'],1)
  self.assertGreaterEqual(events[-1]['elapsedSeconds'],0);self.assertEqual(events[0]['event'],'start');self.assertEqual(events[-1]['outcome'],'exit')
 def test_nonzero_remains_nonzero_not_success(self):
  value,error,events,seen=self.exercise(7)
  self.assertEqual(value,7);self.assertIsNone(error);self.assertEqual(events[-1]['exitCode'],7);self.assertEqual(len(seen),1)
 def test_timeout_preserves_exception_before_cleanup_and_never_retries(self):
  failure=subprocess.TimeoutExpired(['npm','run','migrate'],300,output=SECRET,stderr=SECRET)
  value,error,events,seen=self.exercise(failure)
  self.assertIs(error,failure);self.assertIsNone(value);self.assertEqual(seen,[300]);self.assertEqual(events[-1]['outcome'],'timeout');self.assertIsNone(events[-1]['exitCode']);self.assertEqual(events[-1]['lastRunning'],SAFE_B)
 def test_startup_error_does_not_publish_message(self):
  failure=OSError(SECRET);value,error,events,seen=self.exercise(failure)
  self.assertIs(error,failure);self.assertEqual(events[-1]['outcome'],'startup-error');self.assertIsNone(events[-1]['exitCode'])
 def test_generic_init_and_jest_remain180(self):
  for label in ['a-init','b-tests']:
   value,error,events,seen=self.exercise(0,label,180);self.assertEqual(seen,[180]);self.assertNotIn('lastRunning',events[-1])
 def test_actual_main_only_migration_call_gets900(self):
  # Card 696f3bb8: 300 s did not cover a saturated runner (CI run 5685 job 14990).
  tree=ast.parse(SOURCE.read_text());calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='run']
  self.assertEqual(len(calls),3)
  migration=[n for n in calls if any(isinstance(k.value,ast.Constant) and k.arg=='timeout' and k.value.value==900 for k in n.keywords)]
  self.assertEqual(len(migration),1);self.assertIn('-migrate',ast.unparse(migration[0].args[0]))
  self.assertEqual(sum(not n.keywords for n in calls),2)
 def test_progress_refuses_unknown_names_payload_suffix_and_sql(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=pathlib.Path(tmp)/'migration.log';p.write_text('▶️  Running: '+SAFE_A+'\n✅ Completed: '+SAFE_A+'\n✅ Completed: '+SAFE_A+'\n▶️  Running: 999_'+SECRET.lower()+'.sql\n✅ Completed: '+SAFE_B+' '+SECRET+'\nSQL password='+SECRET+'\n')
   result=subject.migration_progress(p,{SAFE_A,SAFE_B})
   self.assertEqual(result,{'logAvailable':True,'lastRunning':SAFE_A,'lastCompleted':SAFE_A,'completionCount':1});self.assertNotIn(SECRET,json.dumps(result))
 def test_missing_log_is_safe_diagnostic_not_secondary_failure(self):
  with tempfile.TemporaryDirectory() as tmp:self.assertEqual(subject.migration_progress(pathlib.Path(tmp)/'absent',{SAFE_A}),{'logAvailable':False,'lastRunning':None,'lastCompleted':None,'completionCount':0})
 def test_phase_label_is_closed_before_child(self):
  with patch.object(subject.subprocess,'run',side_effect=AssertionError('must not dispatch')):
   with self.assertRaises(AssertionError):subject.run_phase(SECRET,[],{},pathlib.Path('/absent'),pathlib.Path('/absent'))
 def test_existing_ci_admission_still_refuses_wrong_database(self):
  good=dict(zip(subject.KEYS,['postgres','5432','relayhall_ci','relayhall_ci','fixture-only']))
  self.assertEqual(subject.admit('ci',good,'true'),good)
  with self.assertRaises(ValueError):subject.admit('ci',{**good,'DB_NAME':'relayhall_prod'},'true')
class AdminSqlTests(unittest.TestCase):
 root=pathlib.Path('/absent-root');env={'DB_PASSWORD':SECRET}
 def call(self,returncode=0,stdout='[]',stderr='',failure=None):
  seen=[];printed=io.StringIO();error=None;value=None
  def fake(command,**kw):
   seen.append((command,kw))
   if failure is not None:raise failure
   return subprocess.CompletedProcess(command,returncode,stdout,stderr)
  with patch.object(subject.subprocess,'run',side_effect=fake),contextlib.redirect_stdout(printed):
   try:value=subject.admin_sql(self.root,self.env,'SELECT 1',[1])
   except BaseException as caught:error=caught
  return value,error,printed.getvalue(),seen
 def test_success_returns_rows_and_sends_the_statement_on_stdin_only(self):
  value,error,printed,seen=self.call(stdout='[{"n":0}]')
  self.assertEqual(value,[{'n':0}]);self.assertIsNone(error);self.assertEqual(printed,'')
  command,kw=seen[0];self.assertEqual(kw['timeout'],30);self.assertEqual(kw['cwd'],self.root/'backend');self.assertIs(kw['env'],self.env)
  self.assertEqual(json.loads(kw['input']),{'sql':'SELECT 1','params':[1]});self.assertFalse(any('SELECT 1' in part for part in command))
 def test_driver_code_is_carried_on_the_error_and_is_the_only_thing_printed(self):
  value,error,printed,seen=self.call(1,stderr='Fixture admin SQL failed: 3D000\n')
  self.assertIsInstance(error,subject.FixtureAdminError);self.assertIsInstance(error,AssertionError);self.assertEqual(error.code,'3D000')
  self.assertEqual(json.loads(printed),{'fixtureAdminFailure':'3D000','exit':1});self.assertEqual(str(error),'Fixture admin SQL failed (no deployment fallback)')
 def test_server_text_is_never_parsed_or_published(self):
  for stderr in ['error: database "x" does not exist 3D000 '+SECRET,'Fixture admin SQL failed: password authentication failed for user "x" '+SECRET,'Fixture admin SQL failed: '+'A'*65,'Fixture admin SQL failed: 3D000\nextra '+SECRET,'']:
   value,error,printed,seen=self.call(1,stderr=stderr)
   self.assertIsInstance(error,subject.FixtureAdminError);self.assertEqual(error.code,'UNCLASSIFIED')
   self.assertEqual(json.loads(printed),{'fixtureAdminFailure':'UNCLASSIFIED','exit':1})
   for surface in [printed,str(error),repr(error.args),error.code]:self.assertNotIn(SECRET,surface)
 def test_timeout_propagates_as_itself(self):
  failure=subprocess.TimeoutExpired('node',30);value,error,printed,seen=self.call(failure=failure)
  self.assertIs(error,failure);self.assertEqual(printed,'')
class CauseTests(unittest.TestCase):
 # Card 696f3bb8: the cleanup record and error name the failure that led to
 # cleanup, and never carry a child's text.
 def test_timeout_names_the_phase_and_its_budget(self):
  failure=subprocess.TimeoutExpired(['npm','run','migrate'],900,output=SECRET,stderr=SECRET)
  self.assertEqual(subject.failure_cause(failure,'a-migrate'),'a-migrate timed out after 900 s')
  # subprocess.run reports the time that remained, a hair under the budget.
  self.assertEqual(subject.failure_cause(subprocess.TimeoutExpired('npm',899.9999),'b-migrate'),'b-migrate timed out after 900 s')
 def test_admin_failure_names_only_the_bounded_code(self):
  self.assertEqual(subject.failure_cause(subject.FixtureAdminError('3D000'),None),'scenario setup: FixtureAdminError 3D000')
 def test_own_assertion_text_is_kept_and_other_text_is_not(self):
  self.assertEqual(subject.failure_cause(AssertionError('Fixture migration failed'),'b-migrate'),'b-migrate: AssertionError: Fixture migration failed')
  for failure in [OSError(SECRET),RuntimeError(SECRET),ValueError(SECRET)]:
   cause=subject.failure_cause(failure,'c-tests');self.assertNotIn(SECRET,cause);self.assertEqual(cause,'c-tests: '+type(failure).__name__)
class Clock:
 # Virtual time: sleeping advances it, so the polling budget runs without waiting.
 def __init__(self):self.now=1000.0;self.slept=[]
 def monotonic(self):return self.now
 def sleep(self,seconds):self.slept.append(seconds);self.now+=seconds
class CleanupTests(unittest.TestCase):
 # The poll is pinned to the numbers the card names (every 2 s, up to 120 s)
 # as literals, so the tests cannot be edited to agree with a changed constant.
 def setUp(self):
  self.clock=Clock();self.name=subject.NAMES['c']
  for target,replacement in [('sleep',self.clock.sleep),('monotonic',self.clock.monotonic)]:
   patcher=patch.object(subject.time,target,replacement);patcher.start();self.addCleanup(patcher.stop)
 def script(self,*steps):
  # One step per call, in order, the last repeating. An exception is raised; anything else is the rows.
  calls=[]
  def sql(statement,params=None):
   calls.append((statement,params));step=steps[min(len(calls),len(steps))-1]
   if isinstance(step,Exception):raise step
   return step
  return sql,calls
 def drop(self,sql):return subject.drop_owned_database(sql,self.name,[{'database':self.name}])
 def assertOneDropThenReads(self,calls):
  # Exactly one DROP, never repeated; everything after it reads pg_database for this name only.
  self.assertTrue(calls[0][0].startswith('DROP DATABASE "'+self.name+'"'))
  for statement,params in calls[1:]:self.assertTrue(statement.startswith('SELECT'));self.assertEqual(params,[self.name])
 def assertBudgetSpent(self,calls):
  self.assertEqual(len(calls),len(self.clock.slept)+2);self.assertEqual(set(self.clock.slept),{2})
  self.assertGreaterEqual(sum(self.clock.slept),120);self.assertLess(sum(self.clock.slept),122)
 def test_timeout_absence_is_confirmed_without_second_drop(self):
  sql,calls=self.script(subprocess.TimeoutExpired('drop',30),[{'n':0}])
  self.assertEqual(self.drop(sql),'absence-confirmed-after-timeout')
  self.assertEqual(len(calls),2);self.assertOneDropThenReads(calls);self.assertEqual(self.clock.slept,[])
 def test_timeout_row_that_disappears_on_a_later_poll_is_absence(self):
  sql,calls=self.script(subprocess.TimeoutExpired('drop',30),[{'n':1}],[{'n':1}],[{'n':0}])
  self.assertEqual(self.drop(sql),'absence-confirmed-after-timeout')
  self.assertEqual(len(calls),4);self.assertOneDropThenReads(calls);self.assertEqual(self.clock.slept,[2,2])
 def test_timeout_slow_readbacks_are_not_evidence_either_way(self):
  sql,calls=self.script(subprocess.TimeoutExpired('drop',30),subprocess.TimeoutExpired('read',30),subprocess.TimeoutExpired('read',30),[{'n':0}])
  self.assertEqual(self.drop(sql),'absence-confirmed-after-timeout')
  self.assertEqual(len(calls),4);self.assertOneDropThenReads(calls);self.assertEqual(self.clock.slept,[2,2])
 def test_timeout_row_present_past_the_budget_remains_failure(self):
  for rows in [[{'n':1}],[],[{'n':'0'}],subprocess.TimeoutExpired('read',30)]:
   self.clock.now=1000.0;self.clock.slept.clear();failure=subprocess.TimeoutExpired('drop',30)
   sql,calls=self.script(failure,rows)
   with self.assertRaises(subprocess.TimeoutExpired) as caught:self.drop(sql)
   self.assertIs(caught.exception,failure);self.assertOneDropThenReads(calls);self.assertBudgetSpent(calls)
 def test_unobservable_cleanup_remains_failure(self):
  sql,calls=self.script(subprocess.TimeoutExpired('drop',30),RuntimeError('unavailable'))
  with self.assertRaises(RuntimeError):self.drop(sql)
  self.assertEqual(len(calls),2);self.assertEqual(self.clock.slept,[])
 def test_3d000_for_an_owned_unrecorded_database_is_absence_not_an_error(self):
  sql,calls=self.script(subject.FixtureAdminError('3D000'),[{'n':0}])
  self.assertEqual(self.drop(sql),'absent-before-drop')
  self.assertEqual(len(calls),2);self.assertOneDropThenReads(calls);self.assertEqual(self.clock.slept,[])
 def test_3d000_contradicted_by_a_present_row_remains_failure(self):
  failure=subject.FixtureAdminError('3D000');sql,calls=self.script(failure,[{'n':1}])
  with self.assertRaises(subject.FixtureAdminError) as caught:self.drop(sql)
  self.assertIs(caught.exception,failure);self.assertOneDropThenReads(calls);self.assertBudgetSpent(calls)
 def test_3d000_with_an_unreadable_catalog_remains_failure(self):
  sql,calls=self.script(subject.FixtureAdminError('3D000'),subject.FixtureAdminError('3D000'))
  with self.assertRaises(subject.FixtureAdminError):self.drop(sql)
  self.assertEqual(len(calls),2);self.assertEqual(self.clock.slept,[])
 def test_other_driver_codes_are_not_absence(self):
  for code in ['57014','28P01','ECONNREFUSED','UNCLASSIFIED','3D001','3d000']:
   failure=subject.FixtureAdminError(code);sql,calls=self.script(failure)
   with self.assertRaises(subject.FixtureAdminError) as caught:self.drop(sql)
   self.assertIs(caught.exception,failure);self.assertEqual(len(calls),1);self.assertEqual(self.clock.slept,[])
 def test_ownership_is_counted_per_creation_so_a_recorded_drop_is_not_absent(self):
  row={'database':self.name};calls=[]
  def forbidden(*args):calls.append(args);return [{'n':0}]
  for created,dropped in [([row],[row]),([row,row],[row,row])]:
   with self.assertRaises(AssertionError):subject.drop_owned_database(forbidden,self.name,created,dropped)
  self.assertEqual(calls,[])
  sql,calls=self.script(subject.FixtureAdminError('3D000'),[{'n':0}])
  self.assertEqual(subject.drop_owned_database(sql,self.name,[row,row],[row]),'absent-before-drop');self.assertEqual(len(calls),2)
 def test_foreign_or_unowned_name_never_executes(self):
  for name,created in [('production',[{'database':'production'}]),(subject.NAMES['a'],[])]:
   with patch.object(subject.subprocess,'run',side_effect=AssertionError('no child')):
    def denied(*args):self.fail('unauthorized SQL')
    with self.assertRaises(AssertionError):subject.drop_owned_database(denied,name,created)
 def test_success_has_no_readback(self):
  calls=[];name=subject.NAMES['a']
  self.assertEqual(subject.drop_owned_database(lambda *args:calls.append(args),name,[{'database':name}]),'drop-confirmed')
  self.assertEqual(len(calls),1);self.assertEqual(self.clock.slept,[])

if __name__=='__main__':unittest.main()
