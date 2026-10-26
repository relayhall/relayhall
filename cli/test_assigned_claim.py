import ast,contextlib,io,json,unittest
from pathlib import Path
from types import SimpleNamespace
source=Path(__file__).with_name('relayhall')
node=next(n for n in ast.parse(source.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='cmd_task_claim')
class Claim(unittest.TestCase):
 def test_epoch_and_legacy_transport(self):
  for epoch,expected in [('7',{'expectedAssignmentEpoch':'7'}),(None,{})]:
   calls=[];ns={'json':json,'resolve_task_id':lambda _: 'task','api':lambda *a:calls.append(a) or {'success':True}}
   exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),ns)
   with contextlib.redirect_stdout(io.StringIO()):ns['cmd_task_claim'](SimpleNamespace(id='task',expected_assignment_epoch=epoch))
   self.assertEqual(calls,[('POST','/tasks/task/claim',expected)])
if __name__=='__main__':unittest.main()
