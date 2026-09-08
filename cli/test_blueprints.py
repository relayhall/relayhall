"""Real argparse/dispatcher with fake HTTP: not live D-15/D-20/D-26 parity."""
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import urllib.error
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest import mock
import pytest

sys.path.insert(0,str(Path(__file__).parent))
spec=importlib.util.spec_from_loader('relayhall_blueprint_test',importlib.machinery.SourceFileLoader('relayhall_blueprint_test',str(Path(__file__).parent/'relayhall')))
cli=importlib.util.module_from_spec(spec);spec.loader.exec_module(cli)
import relayhall_blueprints as helper

SETUP_ID='11111111-1111-4111-8111-111111111111'
WARRANT_ID='22222222-2222-4222-8222-222222222222'
def setup_preview():
    return {'success':True,'plan':{'instantiationId':SETUP_ID,'projectId':'44444444-4444-4444-8444-444444444444','warrantId':WARRANT_ID,'tasks':[{'id':'33333333-3333-4333-8333-333333333333','revision':'a'*32,'title':'untrusted text','phaseId':None,'executionProfile':{'literal':'x'*70000}}],'allParked':True,'assignmentOnly':True,'confirmationHash':'b'*64}}

def invoke(argv, api, answers=()):
    out,err=io.StringIO(),io.StringIO();code=0
    with mock.patch.object(sys,'argv',['relayhall',*argv]),mock.patch.object(cli,'api',side_effect=api),mock.patch('builtins.input',side_effect=answers),redirect_stdout(out),redirect_stderr(err):
        try:cli.main()
        except SystemExit as failure:code=failure.code
    return code,out.getvalue(),err.getvalue()

def fixture():
    return {'blueprint':{'key':'example','version':1,'target':{'mode':'new-project'},'parameters':[{'key':'count','type':'integer','label':'Count'},{'key':'enabled','type':'boolean','label':'Enabled'},{'key':'text','type':'string','label':'Text'}], 'document':{'target':{'mode':'new-project'}}}}

def test_setup_preview_is_complete_private_output_and_no_assignment(tmp_path):
    target=tmp_path/'preview.json';api=mock.Mock(return_value=setup_preview())
    code,out,_=invoke(['blueprint','setup-preview',SETUP_ID,'--warrant',WARRANT_ID,'--out',str(target)],api)
    assert code==0 and json.loads(out)==setup_preview() and json.loads(target.read_text())==setup_preview()
    if os.name!='nt':assert target.stat().st_mode & 0o777==0o600
    assert api.call_args.args==('POST',f'/instantiations/{SETUP_ID}/setup/preview',{'warrantId':WARRANT_ID})
    assert api.call_count==1
    code,_,_=invoke(['blueprint','setup-preview',SETUP_ID,'--warrant',WARRANT_ID,'--out',str(target)],api)
    assert code==1 and json.loads(target.read_text())==setup_preview()

def test_setup_explicit_dispatch_retry_keeps_body_key_and_no_preview(tmp_path):
    file=tmp_path/'preview.json';file.write_text(json.dumps(setup_preview()));calls=[]
    safe={'success':True,'status':200,'instantiationId':SETUP_ID,'taskIds':['33333333-3333-4333-8333-333333333333'],'warrantId':WARRANT_ID,'assigned':True,'armed':False}
    def api(method,path,body=None,**kw):
        calls.append((method,path,body,kw))
        if len(calls)==1:raise TimeoutError()
        return safe
    code,out,err=invoke(['blueprint','setup',SETUP_ID,'--file',str(file),'--idempotency-key','retained-setup-key'],api)
    assert code==0 and json.loads(out)==safe and calls[0]==calls[1]
    assert calls[0][1]==f'/instantiations/{SETUP_ID}/setup'
    assert calls[0][2]=={'warrantId':WARRANT_ID,'tasks':[{'id':'33333333-3333-4333-8333-333333333333','revision':'a'*32}],'confirmationHash':'b'*64}
    assert calls[0][3]['headers']=={'Idempotency-Key':'retained-setup-key'}
    assert err.strip()=='Idempotency-Key: retained-setup-key'

@pytest.mark.parametrize('change',[{'instantiationId':'other'},{'allParked':False},{'assignmentOnly':False},{'tasks':[]},{'confirmationHash':'bad'},{'warrantId':'prefix'}])
def test_setup_rejects_wrong_or_unconfirmable_preview_before_http(tmp_path,change):
    value=setup_preview();value['plan'].update(change);file=tmp_path/'preview.json';file.write_text(json.dumps(value));api=mock.Mock()
    code,_,_=invoke(['blueprint','setup',SETUP_ID,'--file',str(file),'--idempotency-key','retained-setup-key'],api)
    assert code==1;api.assert_not_called()

def test_setup_requires_explicit_key_and_uncertainty_preserves_recovery(tmp_path):
    file=tmp_path/'preview.json';file.write_text(json.dumps(setup_preview()));api=mock.Mock(side_effect=TimeoutError())
    assert invoke(['blueprint','setup',SETUP_ID,'--file',str(file)],api)[0]!=0;api.assert_not_called()
    code,out,err=invoke(['blueprint','setup',SETUP_ID,'--file',str(file),'--idempotency-key','retained-setup-key'],api)
    assert code==1 and not out and 'Outcome uncertain' in err and 'retained-setup-key' in err and api.call_count==2

def test_setup_changed_refusal_never_refreshes_or_rekeys(tmp_path):
    file=tmp_path/'preview.json';file.write_text(json.dumps(setup_preview()));api=mock.Mock(return_value={'success':False,'status':409,'code':'BLUEPRINT_SETUP_CHANGED','error':'Task set changed'})
    code,out,err=invoke(['blueprint','setup',SETUP_ID,'--file',str(file),'--idempotency-key','retained-setup-key'],api)
    assert code==1 and not out and 'BLUEPRINT_SETUP_CHANGED' in err and api.call_count==1

@pytest.mark.parametrize('verb',['submit','withdraw','reject','publish'])
def test_lifecycle_registered_dispatcher(verb):
    calls=[]
    def api(method,path,body=None,**kwargs):calls.append((method,path,body));return {'success':True,'blueprint':{'status':'review' if verb=='submit' else 'published' if verb=='publish' else 'draft','supersededVersion':1 if verb=='publish' else None}}
    code,out,_=invoke(['blueprint',verb,'example','--version','2',*(['--note','Needs revision'] if verb=='reject' else [])],api)
    assert code==0 and len(calls)==1
    assert calls[0]==('POST',f'/blueprints/example/versions/2/{verb}',{'note':'Needs revision'} if verb=='reject' else {})
    assert json.loads(out)['blueprint']['status']==('review' if verb=='submit' else 'published' if verb=='publish' else 'draft')
    if verb=='publish':assert '"supersededVersion": 1' in out

@pytest.mark.parametrize('args',[['blueprint','reject','example','--version','2'],['blueprint','reject','example','--version','2','--note',' ']])
def test_reject_requires_note_before_http(args):
    api=mock.Mock();code,_,_=invoke(args,api);assert code!=0;api.assert_not_called()

@pytest.mark.parametrize('code',['BLUEPRINT_SELF_REVIEW_REFUSED','BLUEPRINT_VERSION_STATE'])
def test_lifecycle_named_refusal(code):
    exit,out,err=invoke(['blueprint','publish','example','--version','1'],lambda *a,**kw:{'success':False,'status':403,'code':code,'error':'Publication refused.'})
    assert exit==1 and code in err and not out

def test_exact_key_body_retry_through_dispatcher():
    writes=[]
    def api(method,path,body=None,**kw):
        if method=='GET':return fixture()
        writes.append((json.dumps(body),kw['headers']))
        if len(writes)==1:raise urllib.error.URLError('dropped')
        return {'success':True,'projectId':'project','instantiationId':'receipt','warnings':[]}
    with mock.patch.object(helper.uuid,'uuid4',return_value='generated-key-0000001') as key:
        code,out,err=invoke(['blueprint','instantiate','example','--param','count=2','--param','enabled=false','--param','text=false'],api)
    assert code==0 and writes[0]==writes[1] and key.call_count==1
    assert json.loads(writes[0][0])['parameterValues']=={'count':2,'enabled':False,'text':'false'}
    assert 'generated-key-0000001' in err and 'receipt' in out

def test_uncertain_outcome_keeps_recovery_key():
    def api(method,*a,**kw):
        if method=='GET':return fixture()
        raise TimeoutError()
    code,_,err=invoke(['blueprint','instantiate','example','--idempotency-key','explicit-key-0000001'],api)
    assert code==1 and 'Outcome uncertain' in err and 'explicit-key-0000001' in err

@pytest.mark.parametrize('confirmation',['no','instantiate'])
def test_interactive_confirmation_is_not_global_yes(confirmation):
    calls=[]
    def api(method,path,body=None,**kw):
        calls.append((method,path,body))
        if path=='/blueprints':return {'success':True,'blueprints':[]}
        if method=='GET':return {'blueprint':{**fixture()['blueprint'],'parameters':[]}}
        if path.endswith('/preview'):return {'success':True,'plan':{'refusals':[],'authority':[],'references':[],'tasks':[{'key':'parked'}]},'targetArchived':False}
        return {'success':True,'projectId':'project','instantiationId':'receipt','warnings':[]}
    with mock.patch.object(helper.uuid,'uuid4',return_value='generated-key-0000001') as key:
        code,out,err=invoke(['--yes','blueprint','instantiate','example','--interactive'],api,[confirmation])
    assert code==0 and key.call_count==(1 if confirmation=='instantiate' else 0)
    assert '4. Preview' in out and 'parked' in out
    assert len([c for c in calls if c[1].endswith('/instantiations')])==(1 if confirmation=='instantiate' else 0)

@pytest.mark.parametrize('kind',['authority','refusal','archived','reference'])
def test_interactive_preview_refusals_block_confirmation(kind):
    def api(method,path,*a,**kw):
        if path=='/blueprints':return {'blueprints':[]}
        if method=='GET':return {'blueprint':{**fixture()['blueprint'],'parameters':[]}}
        return {'targetArchived':kind=='archived','plan':{'authority':[{'allowed':False}] if kind=='authority' else [],'refusals':[{'code':'BLUEPRINT_CREATE_KIND_FORBIDDEN'}] if kind=='refusal' else [],'references':[{'outcome':'missing-required'}] if kind=='reference' else []}}
    with mock.patch.object(helper.uuid,'uuid4') as key:
        code,out,err=invoke(['blueprint','instantiate','example','--interactive'],api)
    assert code==1 and 'cannot be confirmed' in err;key.assert_not_called()

def test_existing_project_conflict_is_local_refusal():
    doc=fixture();doc['blueprint']['target']={'mode':'existing-project'};doc['blueprint']['document']['target']={'project':'{{project}}'};doc['blueprint']['parameters']=[{'key':'project','type':'project-ref'}]
    api=mock.Mock(return_value=doc)
    code,_,err=invoke(['blueprint','preview','example','--project','one','--param','project=two'],api)
    assert code==1 and 'conflicts' in err and api.call_count==1

def test_bare_plural_and_version_read():
    calls=[]
    def api(method,path,*a,**kw):calls.append(path);return {}
    assert invoke(['blueprints'],api)[0]==0
    assert invoke(['blueprint','get','key/unsafe','--version','2'],api)[0]==0
    assert calls==['/blueprints','/blueprints/key%2Funsafe?version=2']

def test_json_import_explicit_rename_is_draft_only(tmp_path):
    file=tmp_path/'bp.json';file.write_text('{"schemaVersion":"rh.blueprint/1.0"}')
    calls=[]
    def api(method,path,body,**kw):calls.append((path,body));return {'success':True,'blueprint':{'status':'draft'}}
    code,out,_=invoke(['blueprint','import','--file',str(file),'--as','renamed'],api)
    assert code==0 and 'draft' in out and calls==[('/blueprints/import',{'document':{'schemaVersion':'rh.blueprint/1.0'},'rename':'renamed'})]

@pytest.mark.parametrize('text',['{"a":1,"a":2}','{"a":NaN}'])
def test_hostile_json_refused_before_http(tmp_path,text):
    file=tmp_path/'bp.json';file.write_text(text);api=mock.Mock()
    assert invoke(['blueprint','import','--file',str(file)],api)[0]==1;api.assert_not_called()

@pytest.mark.parametrize('text',['a: &node 1\nb: *node','a: !!python/object:os.system {}','a: 1\na: 2','a: {<<: {b: 1}}'])
def test_hostile_yaml_refused_before_http(tmp_path,text):
    pytest.importorskip('yaml');file=tmp_path/'bp.yaml';file.write_text(text);api=mock.Mock()
    assert invoke(['blueprint','import','--from-yaml',str(file)],api)[0]==1;api.assert_not_called()

def test_plain_yaml_becomes_json_document(tmp_path):
    pytest.importorskip('yaml');file=tmp_path/'bp.yaml';file.write_text('schemaVersion: rh.blueprint/1.0\nblueprint:\n  key: sample\n')
    calls=[]
    def api(method,path,body,**kw):calls.append(body);return {}
    assert invoke(['blueprint','import','--from-yaml',str(file)],api)[0]==0
    assert calls==[{'document':{'schemaVersion':'rh.blueprint/1.0','blueprint':{'key':'sample'}}}]

def test_bounded_pattern_and_typed_constraints():
    parameter={'type':'string','required':True,'constraints':{'pattern':'^INC-[0-9]{1,6}$'}}
    assert helper.answer(parameter,'INC-12')=='INC-12'
    for value in ['INC-','INC-1234567','prefixINC-12','']:
        with pytest.raises(ValueError):helper.answer(parameter,value)
    with pytest.raises(ValueError):helper.matches_pattern('^(a+)+$','a'*1000)
    with pytest.raises(ValueError):helper.answer({'type':'integer','constraints':{'max':4}},'5')

def test_interview_collects_ordered_prompts_and_generates_key_after_confirmation():
    doc=fixture();doc['blueprint']['parameters']=[{'key':'later','type':'boolean','label':'Later','order':2},{'key':'first','type':'string','promptText':'First prompt','label':'First','order':1}]
    writes=[];events=[]
    def api(method,path,body=None,**kw):
        if path=='/blueprints':return {'blueprints':[]}
        if method=='GET':return doc
        if path.endswith('/preview'):return {'plan':{'authority':[],'references':[],'refusals':[]},'targetArchived':False}
        writes.append(body);return {'instantiationId':'receipt','projectId':'project','warnings':[]}
    answers=iter(['answer','false','instantiate'])
    def prompt(text):events.append(text);return next(answers)
    def generated():events.append('key-generated');return 'generated-key-0000001'
    with mock.patch.object(sys,'argv',['relayhall','blueprint','instantiate','example','--interactive']),mock.patch.object(cli,'api',side_effect=api),mock.patch('builtins.input',side_effect=prompt),mock.patch.object(helper.uuid,'uuid4',side_effect=generated),redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):cli.main()
    assert events[0].startswith('First prompt') and events[1].startswith('Later')
    assert events[-2].startswith('Type instantiate') and events[-1]=='key-generated'
    assert writes==[{'target':{'mode':'new-project'},'parameterValues':{'first':'answer','later':False}}]


def test_capture_uses_canonical_authoring_route_and_no_instantiation():
    calls=[]
    def api(method,path,body=None,**kwargs):
        calls.append((method,path,body))
        return {'success':True,'blueprint':{'id':'captured','version':1,'status':'draft'}}
    code,out,_=invoke(['blueprint','capture','--phase','phase-one','--name','Reusable work'],api)
    assert code==0 and 'draft' in out
    assert calls==[('POST','/blueprints/capture',{'phaseId':'phase-one','name':'Reusable work'})]
