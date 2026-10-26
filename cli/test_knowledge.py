import importlib.machinery, importlib.util, sys
from pathlib import Path
def load():
 s=importlib.util.spec_from_loader('knowledge_cli',importlib.machinery.SourceFileLoader('knowledge_cli',str(Path(__file__).parent/'relayhall')))
 m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def test_search_dimensions(monkeypatch,capsys):
 cli=load();calls=[]
 monkeypatch.setattr(cli,'api',lambda *a,**k:calls.append((a,k)) or {'coverage':{},'groups':[]})
 monkeypatch.setattr(sys,'argv',['relayhall','knowledge','search','needle','--category','relaybrain:note','--kind','docs'])
 cli.main()
 assert calls[0][0][0:2]==('POST','/knowledge-queries')
 assert calls[0][0][2]=={'protocol_version':2,'q':'needle','categories':['relaybrain:note'],'kinds':['docs'],'limitPerSource':8,'timeoutMs':8000}
 assert 'coverage' in capsys.readouterr().out
def test_get_continuation(monkeypatch):
 cli=load();calls=[]
 monkeypatch.setattr(cli,'api',lambda *a,**k:calls.append(a) or {})
 monkeypatch.setattr(sys,'argv',['relayhall','knowledge','get','sealed.key','--continuation','page.key'])
 cli.main()
 assert calls[0]==('GET','/knowledge-contents?handle=sealed.key&continuation=page.key')

def test_refusal_audit_reference(monkeypatch,capsys):
 import io,json,pytest,urllib.error
 cli=load()
 audit_ref='ka_'+'a'*32
 monkeypatch.setattr(cli,'get_api_url',lambda:'https://example.invalid/api')
 monkeypatch.setattr(cli,'get_token',lambda:'synthetic')
 def refuse(*args,**kwargs):
  raise urllib.error.HTTPError('https://example.invalid',422,'refused',{},io.BytesIO(json.dumps({'error':'Narrow the authorized source selection to at most 16 sources.','auditRef':audit_ref}).encode()))
 monkeypatch.setattr(cli.urllib.request,'urlopen',refuse)
 with pytest.raises(SystemExit):
  cli.api('POST','/knowledge-queries',{'q':'needle'})
 assert 'Audit reference: '+audit_ref in capsys.readouterr().err

# Card 40e0e542 (owner ruling E127 (5)): the default scope is current knowledge;
# --include-archive is the one explicit opt-in, sent as includeArchive and
# nothing else.
def test_search_include_archive(monkeypatch):
 cli=load();calls=[]
 monkeypatch.setattr(cli,'api',lambda *a,**k:calls.append(a) or {'coverage':{},'groups':[]})
 monkeypatch.setattr(sys,'argv',['relayhall','knowledge','search','needle','--include-archive'])
 cli.main()
 assert calls[0][0:2]==('POST','/knowledge-queries')
 assert calls[0][2]=={'protocol_version':2,'q':'needle','includeArchive':True,'limitPerSource':8,'timeoutMs':8000}
def test_search_default_scope_sends_no_flag(monkeypatch):
 cli=load();calls=[]
 monkeypatch.setattr(cli,'api',lambda *a,**k:calls.append(a) or {'coverage':{},'groups':[]})
 monkeypatch.setattr(sys,'argv',['relayhall','knowledge','search','needle'])
 cli.main()
 assert 'includeArchive' not in calls[0][2]
