import ast,contextlib,io,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
source=Path(__file__).with_name('relayhall')
node=next(n for n in ast.parse(source.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='cmd_native_generation')
class Contract(unittest.TestCase):
 def test_routes_and_one_transport_call(self):
  task='11111111-1111-4111-8111-111111111111';gen='22222222-2222-4222-8222-222222222222'
  for action,suffix in [('reserve','/generations'),('read','/generations/'+gen),('consume','/generations/'+gen+'/consume'),('publication-intent','/generations/'+gen+'/publication-intent'),('quarantine','/quarantine'),('quarantine-dry-run','/quarantine/dry-run'),('quarantine-read','/quarantine/'+gen)]:
   with self.subTest(action=action),tempfile.TemporaryDirectory() as d:
    f=Path(d)/'payload.json';f.write_text('{"schemaVersion":2}');calls=[]
    ns={'Path':Path,'json':json,'resolve_task_id':lambda _:task,'api':lambda *a:calls.append(a) or {'success':True}}
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),ns)
    with contextlib.redirect_stdout(io.StringIO()):ns['cmd_native_generation'](SimpleNamespace(id=task,action=action,generation_id=gen,quarantine_id=gen,payload_file=str(f)))
    self.assertEqual(len(calls),1);self.assertEqual(calls[0][1],'/tasks/'+task+'/native-executions'+suffix);self.assertEqual(calls[0][0],'GET' if action in ('read','quarantine-read') else 'POST')
 def test_bad_payload_never_transports(self):
  for raw in ['[]','{', '"token"']:
   with tempfile.TemporaryDirectory() as d:
    f=Path(d)/'payload';f.write_text(raw);calls=[];ns={'Path':Path,'json':json,'resolve_task_id':lambda _: 'task','api':lambda *a:calls.append(a)}
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),ns)
    with self.assertRaises((ValueError,json.JSONDecodeError)):ns['cmd_native_generation'](SimpleNamespace(id='task',action='reserve',generation_id=None,quarantine_id=None,payload_file=str(f)))
    self.assertEqual(calls,[])
 def test_generic_finish_uses_shared_route_and_never_retries_quarantine(self):
  finish=next(n for n in ast.parse(source.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='cmd_task_finish')
  for inline in [False,True]:
   calls=[]
   def refuse(*args):
    calls.append(args);raise RuntimeError('NATIVE_GENERATION_IMPORT_HOLD')
   ns={'Path':Path,'json':json,'resolve_task_id':lambda _: 'task','_read_optional_text_arg':lambda text,_:text,'api':refuse}
   exec(compile(ast.Module(body=[finish],type_ignores=[]),str(source),'exec'),ns)
   args=SimpleNamespace(id='task',handover='Held handover',handover_file=None,report_content='Inline bytes' if inline else None,report_file=None,report_id=None if inline else 'report',report_title='Inline title',dry_run=False,native_generation_file=None)
   with self.assertRaisesRegex(RuntimeError,'NATIVE_GENERATION_IMPORT_HOLD'):ns['cmd_task_finish'](args)
   self.assertEqual(len(calls),1);self.assertEqual(calls[0][:2],('POST','/tasks/task/finish'));self.assertNotIn('nativeGeneration',calls[0][2])
if __name__=='__main__':unittest.main()
