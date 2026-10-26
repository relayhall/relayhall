import json,pathlib,hashlib,copy
from jsonschema import Draft202012Validator
d=pathlib.Path(__file__).parent
schema=json.loads((d/'selector-v2.schema.json').read_text())
Draft202012Validator.check_schema(schema)
def valid(definition,value):
 s=copy.deepcopy(schema);s.pop('oneOf');s['$ref']='#/$defs/'+definition
 return not list(Draft202012Validator(s).iter_errors(value))
base={'protocol_version':2,'q':'test'}
fixtures=[
 ('query-basic','query',base,True),
 ('query-empty-category','query',{**base,'categories':[]},False),
 ('query-empty-kinds','query',{**base,'kinds':[]},False),
 ('query-unknown-kind','query',{**base,'kinds':['tickets']},False),
 ('query-version','query',{**base,'protocol_version':1},False),
 ('query-limit','query',{**base,'limitPerSource':26},False),
 ('query-hard-category','query',{**base,'categories':['relaybrain:note']},True),
 ('query-unnamespaced-category','query',{**base,'categories':['note']},False),
 ('filter-canonical','filter',{'version':2,'kinds':['code','docs']},True),
 ('filter-empty','filter',{'version':2,'kinds':[]},False),
 ('filter-authority-injection','filter',{'version':2,'kinds':['docs'],'allowed_principals':['all']},False),
 ('retrieval-complete','retrieval',{'status':'complete','reasons':[]},True),
 ('retrieval-partial','retrieval',{'status':'partial','reasons':['store-unavailable']},True),
 ('retrieval-false-complete','retrieval',{'status':'complete','reasons':['deadline']},False),
 ('retrieval-empty-partial','retrieval',{'status':'partial','reasons':[]},False),
 ('retrieval-unknown-reason','retrieval',{'status':'partial','reasons':['secret-store']},False),
 ('get-initial','getRequest',{'protocol_version':2,'handle':'abc.def'},True),
 ('get-exclusive','getRequest',{'protocol_version':2,'handle':'abc.def','continuation':'abc.def','ifNoneMatch':'a'*64},False),
 ('get-legacy-offset','getRequest',{'protocol_version':2,'handle':'abc.def','continueFrom':5},False),
]

uuid='00000000-0000-4000-8000-000000000001'
getbase={'protocol_version':2,'ref':'rb://source/doc@hash','compartment_id':uuid,'filter':{'version':2,'kinds':['docs']},'limitBytes':262144}
descriptor={'protocol_version':2,'compartment_mode':'dynamic-opaque','classes':[{'key':'docs','content':'docs'}],'categories':['relaybrain:note']}
result={'ref':'rb://source/doc@hash','title':'t','snippet':'s','contentKind':'docs','category':'relaybrain:note','compartment':{'id':uuid},'score':0.5}
fixtures += [
 ('descriptor-valid','descriptor',descriptor,True),
 ('descriptor-mode','descriptor',{**descriptor,'compartment_mode':'static'},False),
 ('descriptor-empty-vocabulary','descriptor',{**descriptor,'categories':[]},False),
 ('result-valid','result',result,True),
 ('result-opaque-id','result',{**result,'compartment':{'id':'person-name'}},False),
 ('result-angle-ref','result',{**result,'ref':'<unsafe>'},False),
 ('search-request-valid','sourceSearchRequest',{'protocol_version':2,'q':'test','limit':8,'filter':{'version':2,'kinds':['docs']}},True),
 ('search-request-no-filter','sourceSearchRequest',{'protocol_version':2,'q':'test','limit':8},False),
 ('search-response-valid','sourceSearchResponse',{'protocol_version':2,'results':[result],'retrieval':{'status':'complete','reasons':[]}},True),
 ('search-response-no-retrieval','sourceSearchResponse',{'protocol_version':2,'results':[]},False),
 ('get-source-valid','sourceGetRequest',getbase,True),
 ('get-source-continuation','sourceGetRequest',{**getbase,'continueFrom':5,'contentHash':'a'*64},True),
 ('get-source-offset-alone','sourceGetRequest',{**getbase,'continueFrom':5},False),
 ('get-source-hash-alone','sourceGetRequest',{**getbase,'contentHash':'a'*64},False),
 ('get-source-continuation-etag','sourceGetRequest',{**getbase,'continueFrom':5,'contentHash':'a'*64,'ifNoneMatch':'a'*64},False),
 ('get-source-notModified','sourceGetResponse',{'protocol_version':2,'status':'notModified'},True),
 ('get-source-refused','sourceGetResponse',{'protocol_version':2,'status':'refused','code':'refused'},True),
 ('get-source-unknown-refusal','sourceGetResponse',{'protocol_version':2,'status':'refused','code':'secret'},False),
]
def normalize_query(raw):
 assert len(json.dumps(raw).encode())<=65536
 allowed=set(schema['$defs']['query']['properties'])
 assert set(raw)<=allowed
 out=copy.deepcopy(raw)
 for dimension in ['sources','kinds','categories']:
  if dimension not in raw:continue
  values=raw[dimension]
  assert isinstance(values,list) and 1<=len(values)<=256 and all(isinstance(x,str) for x in values)
  out[dimension]=sorted(set(values))
 out.setdefault('kinds',['code','data','docs'])
 assert valid('query',out)
 return out
for dimension,value in [('sources',uuid),('kinds','docs'),('categories','relaybrain:note')]:
 got=normalize_query({**base,dimension:[value,value]})
 assert got[dimension]==[value]
for bad in [
 {**base,'sources':[f'00000000-0000-4000-8000-{i:012d}' for i in range(17)]},
 {**base,'categories':[f'relaybrain:c{i}' for i in range(33)]},
 {**base,'categories':['relaybrain:note']*257},
 {**base,'categories':[]},
 {**base,'categories':['relaybrain:note',1]},
]:
 try:normalize_query(bad)
 except AssertionError:pass
 else:raise AssertionError('normalization accepted bounded-invalid input')
assert len(normalize_query({**base,'categories':[f'relaybrain:c{i}' for i in range(32)]})['categories'])==32
(d/'fixtures-v1.1.json').write_text(json.dumps([{'id':a,'definition':b,'input':c,'valid':e} for a,b,c,e in fixtures],indent=2)+'\n')
for name,definition,value,expected in fixtures:assert valid(definition,value)==expected,name
# Adapters produce shared arrays; canonicalization is ASCII-only subset of RFC8785.
def normalize(x):
 out={'version':2,'kinds':sorted(set(x.get('kinds',['code','docs','data'])))}
 if 'categories' in x:out['categories']=sorted(set(x['categories']))
 return json.dumps(out,separators=(',',':'),sort_keys=True)
surfaces={
 'REST':{'kinds':['docs','code'],'categories':['relaybrain:note','relayhall:report']},
 'MCP':{'kinds':['code','docs'],'categories':['relayhall:report','relaybrain:note']},
 'CLI':{'kinds':['docs','code'],'categories':['relayhall:report','relaybrain:note']},
 'GUI':{'kinds':['code','docs'],'categories':['relaybrain:note','relayhall:report']}}
normalized=[normalize(x) for x in surfaces.values()]
assert len(set(normalized))==1
assert normalize({})!=normalize({'categories':['relaybrain:note']})
receipt={'schema_self_validation':'pass','structural_fixtures':len(fixtures),'normalization_duplicate_cases':3,'normalization_negative_cases':5,'normalization_surfaces':list(surfaces),'normalization_hash':hashlib.sha256(normalized[0].encode()).hexdigest(),'runtime_security_tests_executed':False}
(d/'validation-receipt-v1.1.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
