import importlib.util
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import SimpleNamespace
loader=SourceFileLoader('task_report_cli',str(Path(__file__).with_name('relayhall')))
spec=importlib.util.spec_from_loader(loader.name,loader)
cli=importlib.util.module_from_spec(spec);loader.exec_module(cli)
def test_task_report_edit_preserves_cas_and_task_endpoint(monkeypatch):
 calls=[]
 monkeypatch.setattr(cli,'resolve_task_id',lambda value:'task-full')
 monkeypatch.setattr(cli,'api',lambda method,path,data=None,headers=None:calls.append((method,path,data)) or {'success':True})
 cli.cmd_task_report(SimpleNamespace(id='task',title='Progress',content='Evidence',content_file=None,report_id='report-full',expected_content_hash='a'*64,reconcile=False,idempotency_key='logical-save-key-001'))
 assert calls==[('POST','/tasks/task-full/reports',{'title':'Progress','content':'Evidence','reportId':'report-full','expectedContentHash':'a'*64})]
def test_task_report_list_uses_task_scoped_read(monkeypatch):
 calls=[]
 monkeypatch.setattr(cli,'resolve_task_id',lambda value:'task-full')
 monkeypatch.setattr(cli,'api',lambda method,path:calls.append((method,path)) or {'reports':[]})
 cli.cmd_task_reports(SimpleNamespace(id='task'))
 assert calls==[('GET','/tasks/task-full/reports')]

def test_task_reports_page_flags_reach_the_bounded_route(monkeypatch):
 calls=[]
 monkeypatch.setattr(cli,'resolve_task_id',lambda value:'task-full')
 monkeypatch.setattr(cli,'api',lambda method,path:calls.append((method,path)) or {'reports':[]})
 cli.cmd_task_reports(SimpleNamespace(id='task',scope='progress',limit=7,cursor='rc1.abc',pinned=True,all=False))
 assert calls==[('GET','/tasks/task-full/reports?scope=progress&limit=7&cursor=rc1.abc&pinned=true')]

def test_task_reports_all_follows_the_board_cursor_to_the_last_page(monkeypatch,capsys):
 import json
 pages={None:{'taskId':'task-full','scope':'linked','reports':[{'id':'r3'},{'id':'r2'}],'pinned':{'reports':[],'total':0,'returned':0,'hasMore':False},
   'pagination':{'limit':50,'offset':0,'total':3,'returned':2,'hasMore':True,'nextCursor':'rc1.next'}},
  'rc1.next':{'taskId':'task-full','scope':'linked','reports':[{'id':'r1'}],'pinned':{'reports':[],'total':0,'returned':0,'hasMore':False},
   'pagination':{'limit':50,'offset':2,'total':3,'returned':1,'hasMore':False,'nextCursor':None}}}
 calls=[]
 def api(method,path):
  calls.append(path)
  cursor=path.split('cursor=')[1] if 'cursor=' in path else None
  return pages[cursor]
 monkeypatch.setattr(cli,'resolve_task_id',lambda value:'task-full')
 monkeypatch.setattr(cli,'api',api)
 cli.cmd_task_reports(SimpleNamespace(id='task',scope=None,limit=None,cursor=None,pinned=False,all=True))
 assert calls==['/tasks/task-full/reports?limit=50','/tasks/task-full/reports?limit=50&cursor=rc1.next']
 out=json.loads(capsys.readouterr().out)
 assert [row['id'] for row in out['reports']]==['r3','r2','r1']
 assert out['pagination']=={'total':3,'returned':3,'hasMore':False,'pages':2}

def test_task_reports_all_refuses_a_repeated_cursor_instead_of_looping(monkeypatch):
 import pytest
 page={'reports':[{'id':'r'}],'pagination':{'total':9,'hasMore':True,'nextCursor':'rc1.same'}}
 monkeypatch.setattr(cli,'resolve_task_id',lambda value:'task-full')
 monkeypatch.setattr(cli,'api',lambda method,path:page)
 with pytest.raises(SystemExit):
  cli.cmd_task_reports(SimpleNamespace(id='task',scope=None,limit=None,cursor=None,pinned=False,all=True))

def test_task_reports_parser_offers_the_bounded_flags():
 parser_source=Path(__file__).with_name('relayhall').read_text(encoding='utf-8')
 for flag in ('"--scope"','"--limit"','"--cursor"','"--pinned"','"--all"','"--report"'):
  assert 'p_task_reports.add_argument('+flag in parser_source

# Card 50b5e9c4 round-1 B1: a claimant continues its own progress Report from the
# Task-authority read, which needs tasks:read only.
def test_task_reports_report_reads_one_progress_report_through_the_task_route(monkeypatch,capsys):
 import json
 report='0b5e9c40-0000-4000-8000-000000000001'
 calls=[]
 monkeypatch.setattr(cli,'resolve_task_id',lambda value:'task-full')
 monkeypatch.setattr(cli,'api',lambda method,path:calls.append((method,path)) or {'success':True,'taskId':'task-full','report':{'id':report,'content':'body','content_hash':'a'*64}})
 cli.cmd_task_reports(SimpleNamespace(id='task',scope=None,limit=None,cursor=None,pinned=False,all=False,report=report))
 assert calls==[('GET',f'/tasks/task-full/reports/{report}')]
 assert json.loads(capsys.readouterr().out)['report']['content_hash']=='a'*64

def test_task_reports_report_refuses_page_flags_and_prefixes_without_a_call(monkeypatch):
 import pytest
 calls=[]
 monkeypatch.setattr(cli,'resolve_task_id',lambda value:'task-full')
 monkeypatch.setattr(cli,'api',lambda method,path:calls.append(path))
 report='0b5e9c40-0000-4000-8000-000000000001'
 for extra in ({'scope':'progress'},{'all':True},{'cursor':'rc1.x'},{'pinned':True},{'limit':5}):
  args=dict(id='task',scope=None,limit=None,cursor=None,pinned=False,all=False,report=report);args.update(extra)
  with pytest.raises(SystemExit):
   cli.cmd_task_reports(SimpleNamespace(**args))
 with pytest.raises(SystemExit):
  cli.cmd_task_reports(SimpleNamespace(id='task',scope=None,limit=None,cursor=None,pinned=False,all=False,report='0b5e9c40'))
 assert calls==[]

def test_reconcile_uses_same_key_and_exact_request_hash_without_post(monkeypatch):
 import hashlib,json
 calls=[];body={'title':'Progress','content':'Evidence','summary':None,'reportId':None,'expectedContentHash':None}
 digest=hashlib.sha256(json.dumps(body,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
 monkeypatch.setattr(cli,'resolve_task_id',lambda value:'task-full')
 monkeypatch.setattr(cli,'api',lambda method,path:calls.append((method,path)) or {'operation':{'key':'logical-save-key-001','requestHash':digest}})
 cli.cmd_task_report(SimpleNamespace(id='task',title='Progress',content='Evidence',content_file=None,report_id=None,expected_content_hash=None,reconcile=True,idempotency_key='logical-save-key-001'))
 assert calls==[('GET','/tasks/task-full/report-operations/logical-save-key-001?requestHash='+digest)]
