"""Blueprint CLI projection; all authority and writes stay in the canonical API."""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import uuid
from pathlib import Path


def register(sub):
    sub.add_parser('blueprints', help='List visible Blueprints')
    parser = sub.add_parser('blueprint', help='Blueprint registry and instantiation')
    verbs = parser.add_subparsers(dest='blueprint_command', required=True)
    verbs.add_parser('list')
    capture = verbs.add_parser('capture', help='Save a readable Phase as a draft Blueprint')
    capture.add_argument('--phase', required=True)
    capture.add_argument('--name')
    capture.add_argument('--key')
    for verb in ['get', 'export']:
        command = verbs.add_parser(verb); command.add_argument('blueprint')
        command.add_argument('--version', type=int, required=verb == 'export')
        if verb == 'export': command.add_argument('--out')
    for verb in ['create', 'version']:
        command = verbs.add_parser(verb)
        if verb == 'version': command.add_argument('blueprint')
        command.add_argument('--file', required=True)
    # D-26 registration boundary: deleting these four entries must fail their dispatcher tests.
    for verb in ['submit', 'withdraw', 'reject', 'publish', 'retire']:
        command = verbs.add_parser(verb); command.add_argument('blueprint')
        command.add_argument('--version', type=int, required=True)
        command.add_argument('--note', required=verb == 'reject')
    command = verbs.add_parser('import'); source = command.add_mutually_exclusive_group(required=True)
    source.add_argument('--file'); source.add_argument('--from-yaml'); command.add_argument('--as', dest='rename')
    for verb in ['preview', 'instantiate']:
        command = verbs.add_parser(verb); command.add_argument('blueprint'); command.add_argument('--param', action='append', default=[])
        command.add_argument('--project')
        if verb == 'instantiate':
            command.add_argument('--idempotency-key'); command.add_argument('--interactive', action='store_true')
    command = verbs.add_parser('setup-preview', help='Show the exact separate assignment plan; arms nothing')
    command.add_argument('instantiation'); command.add_argument('--warrant', required=True); command.add_argument('--out')
    command = verbs.add_parser('setup', help='Explicitly confirm the displayed setup file; arms nothing')
    command.add_argument('instantiation'); command.add_argument('--file', required=True); command.add_argument('--idempotency-key', required=True)


def setup_body(envelope, instantiation):
    """Project only the displayed confirmation; no profiles or authority are accepted."""
    plan = envelope.get('plan') if isinstance(envelope, dict) and envelope.get('success') is True else None
    if not isinstance(plan, dict) or plan.get('instantiationId') != instantiation or plan.get('allParked') is not True or plan.get('assignmentOnly') is not True:
        raise ValueError('Use the complete setup preview for this instantiation; it must be assignment-only and all parked.')
    def valid_id(value):
        return isinstance(value, str) and bool(re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', value))
    tasks = plan.get('tasks')
    if not valid_id(plan.get('warrantId')) or not isinstance(tasks, list) or not 1 <= len(tasks) <= 100 or any(not isinstance(task, dict) or not valid_id(task.get('id')) or not isinstance(task.get('revision'), str) or not re.fullmatch(r'[0-9a-f]{32}', task['revision']) for task in tasks):
        raise ValueError('The setup preview must contain its existing Warrant and exact Task versions.')
    if len({task['id'] for task in tasks}) != len(tasks) or not isinstance(plan.get('confirmationHash'), str) or not re.fullmatch(r'[0-9a-f]{64}', plan['confirmationHash']):
        raise ValueError('The setup preview has an invalid Task set or confirmation hash.')
    return {'warrantId': plan['warrantId'], 'tasks': [{'id': task['id'], 'revision': task['revision']} for task in tasks], 'confirmationHash': plan['confirmationHash']}


def portable(path, yaml=False):
    raw = Path(path).read_bytes()
    if len(raw) > 64 * 1024: raise ValueError('Blueprint input exceeds 64 KiB; the server may impose a smaller effective cap.')
    text = raw.decode('utf-8')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result: raise ValueError('Duplicate document key refused.')
            result[key] = value
        return result
    if not yaml:
        value = json.loads(text, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-JSON numeric constant refused.')))
    else:
        try: import yaml as parser
        except ImportError: raise ValueError('YAML import requires the supported PyYAML parser; use canonical JSON with --file instead.')
        try:
            for token in parser.scan(text):
                if isinstance(token, (parser.tokens.AnchorToken, parser.tokens.AliasToken, parser.tokens.TagToken)):
                    raise ValueError('YAML anchors, aliases and tags are refused.')
        except parser.YAMLError: raise ValueError('Invalid YAML document.')
        class StrictLoader(parser.SafeLoader): pass
        def mapping(loader, node):
            pairs = []
            for key_node, value_node in node.value:
                if key_node.value == '<<': raise ValueError('YAML merge keys are refused.')
                key = loader.construct_object(key_node, deep=True)
                if not isinstance(key, str) or key == '<<': raise ValueError('YAML mapping keys must be strings; merge keys are refused.')
                pairs.append((key, loader.construct_object(value_node, deep=True)))
            return unique(pairs)
        StrictLoader.add_constructor(parser.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
        try: value = parser.load(text, Loader=StrictLoader)
        except (parser.YAMLError, RecursionError): raise ValueError('Invalid or excessively nested YAML document.')
    if not isinstance(value, dict): raise ValueError('A Blueprint document must be a JSON object.')
    try: json.dumps(value, allow_nan=False)
    except (TypeError, ValueError): raise ValueError('Document contains a value JSON cannot represent; quote YAML calendar dates.')
    return value


def matches_pattern(pattern, value):
    """Linear bounded-token matcher; never executes a document regex."""
    def invalid(): raise ValueError('Unsupported bounded parameter pattern.')
    if len(pattern)>200 or not pattern.startswith('^') or not pattern.endswith('$'): invalid()
    source=pattern[1:-1];tokens=[];index=0
    while index<len(source):
        if source[index]=='[':
            end=source.find(']',index+1)
            if end<0: invalid()
            body=source[index+1:end]
            if not body or re.search(r'[^A-Za-z0-9 _-]',body): invalid()
            allowed=set();cursor=0
            while cursor<len(body):
                if cursor+2<len(body) and body[cursor+1]=='-':
                    low,high=ord(body[cursor]),ord(body[cursor+2])
                    if high<low or high-low>128: invalid()
                    allowed.update(chr(n) for n in range(low,high+1));cursor+=3
                else: allowed.add(body[cursor]);cursor+=1
            index=end+1
        else:
            literal=source[index];index+=1
            if literal=='\\':
                if index>=len(source) or source[index] not in '-_. ': invalid()
                literal=source[index];index+=1
            elif not re.fullmatch(r'[A-Za-z0-9 _-]',literal): invalid()
            allowed={literal}
        minimum=maximum=1
        if index<len(source) and source[index]=='{':
            end=source.find('}',index);bounds=re.fullmatch(r'\{([0-9]{1,4})(?:,([0-9]{1,4}))?\}',source[index:end+1])
            if not bounds: invalid()
            minimum=int(bounds[1]);maximum=int(bounds[2] or bounds[1])
            if minimum>maximum or maximum>8192: invalid()
            index=end+1
        elif index<len(source) and source[index]=='?':minimum=0;index+=1
        tokens.append((allowed,minimum,maximum))
    if len(value)>8192:return False
    positions={0}
    for allowed,minimum,maximum in tokens:
        reachable=[0]*(len(value)+2)
        for index in range(len(value)+1):reachable[index+1]=reachable[index]+int(index in positions)
        positions=set();start=0
        for end in range(len(value)+1):
            if end>0 and value[end-1] not in allowed:start=end
            low=max(start,end-maximum);high=end-minimum
            if high>=low and reachable[high+1]>reachable[low]:positions.add(end)
    return len(value) in positions


def answer(parameter, text):
    kind = parameter['type']; rules = parameter.get('constraints') or {}
    if kind == 'integer':
        if not re.fullmatch(r'-?[0-9]+', text): raise ValueError('Expected an integer.')
        value = int(text)
        if abs(value) > 9007199254740991: raise ValueError('Integer exceeds the portable exact range.')
        if 'min' in rules and value < rules['min'] or 'max' in rules and value > rules['max']: raise ValueError('Integer is outside the declared bounds.')
    elif kind == 'boolean':
        if text not in ['true', 'false']: raise ValueError('Expected true or false.')
        value = text == 'true'
    else:
        value = text
        if not text and parameter.get('required'): raise ValueError('An answer is required.')
        if kind == 'date':
            if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', text): raise ValueError('Expected calendar YYYY-MM-DD.')
        if kind == 'enum' and text not in rules.get('enum', []): raise ValueError('Choose one of the declared enum values.')
        if 'minLength' in rules and len(text) < rules['minLength'] or 'maxLength' in rules and len(text) > rules['maxLength']: raise ValueError('Text is outside the declared length bounds.')
        if rules.get('pattern') and not matches_pattern(rules['pattern'],text):raise ValueError('Text does not match the declared format.')
    return value


def run(args, api):
    def request(method, path, body=None, headers=None):
        result = api(method, path, body, headers=headers, exit_on_error=False)
        if isinstance(result, dict) and result.get('success') is False:
            print(json.dumps(result, ensure_ascii=False), file=sys.stderr)
            raise SystemExit(1)
        return result
    def emit(value): print(json.dumps(value, ensure_ascii=False, indent=2))
    verb = 'list' if args.command == 'blueprints' else args.blueprint_command
    identifier = urllib.parse.quote(getattr(args, 'blueprint', ''), safe='')
    base = '/blueprints/' + identifier
    try:
        if verb in ['setup-preview', 'setup']:
            if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', args.instantiation): raise ValueError('Use the complete instantiation UUID.')
            path = '/instantiations/' + urllib.parse.quote(args.instantiation, safe='') + '/setup'
            if verb == 'setup-preview':
                if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', args.warrant): raise ValueError('Use an existing Warrant UUID.')
                result = request('POST', path + '/preview', {'warrantId': args.warrant})
                setup_body(result, args.instantiation)
                if args.out:
                    # A new private file only: never truncate an existing path or follow a symlink.
                    descriptor = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
                        output.write(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
                return emit(result)
            body = setup_body(json.loads(Path(args.file).read_text(encoding='utf-8')), args.instantiation)
            key = args.idempotency_key
            if not 16 <= len(key) <= 128 or not key.strip(): raise ValueError('Idempotency key must contain 16–128 characters.')
            print('Idempotency-Key: ' + key, file=sys.stderr)
            for attempt in range(2):
                try:
                    result = api('POST', path, body, headers={'Idempotency-Key': key}, exit_on_error=False)
                    if isinstance(result, dict) and result.get('success') is False:
                        if result.get('status', 0) >= 500 and attempt == 0: continue
                        print(json.dumps(result, ensure_ascii=False), file=sys.stderr); raise SystemExit(1)
                    return emit(result)
                except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError):
                    if attempt == 0: continue
                    print('Outcome uncertain. Retry the identical preview file using retained Idempotency-Key: ' + key, file=sys.stderr); raise SystemExit(1)
        if verb == 'capture':
            body = {'phaseId': args.phase}
            if args.name is not None: body['name'] = args.name
            if args.key is not None: body['key'] = args.key
            return emit(request('POST', '/blueprints/capture', body))
        if verb == 'list': return emit(request('GET', '/blueprints'))
        if verb in ['get','export']:
            version = args.version
            if version is not None and version < 1: raise ValueError('Version must be positive.')
            path = base + (f'/versions/{version}/export' if verb == 'export' else f'?version={version}' if version is not None else '')
            result = request('GET', path)
            if verb == 'export' and args.out: Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            else: emit(result)
            return
        if verb in ['create','version','import']:
            document = portable(args.from_yaml if verb == 'import' and args.from_yaml else args.file, yaml=verb == 'import' and bool(args.from_yaml))
            body = {'document': document, **({'rename':args.rename} if args.rename is not None else {})} if verb == 'import' else document
            return emit(request('POST', '/blueprints/import' if verb == 'import' else base + '/versions' if verb == 'version' else '/blueprints', body))
        if verb in ['submit','withdraw','reject','publish','retire']:
            if args.version < 1: raise ValueError('Version must be positive.')
            if verb == 'reject' and not args.note.strip(): raise ValueError('Reject requires a nonempty note.')
            return emit(request('POST', f'{base}/versions/{args.version}/{verb}', {'note':args.note} if args.note is not None else {}))
        interactive = verb == 'instantiate' and args.interactive
        if interactive: print('1. Discover'); emit(request('GET','/blueprints'))
        blueprint = request('GET', base)['blueprint']
        if interactive: print('2. Describe'); emit(blueprint); print('3. Collect')
        parameters = blueprint['parameters']; declarations = {p['key']:p for p in parameters}; values = {}
        for entry in args.param:
            if '=' not in entry: raise ValueError('Each --param must be key=value.')
            key, text = entry.split('=',1)
            if key not in declarations or key in values: raise ValueError('Unknown or repeated parameter key.')
            values[key] = answer(declarations[key], text)
        target = {'mode':'existing-project' if args.project and blueprint['document']['target'].get('allowExisting') else blueprint['target']['mode']}
        if target['mode'] == 'existing-project':
            if not args.project: raise ValueError('This Blueprint requires --project.')
            target['project'] = args.project
            declaration = blueprint['document']['target']['project']
            if isinstance(declaration,str):
                match = re.fullmatch(r'\{\{([a-z][a-z0-9_]*)\}\}', declaration)
                if not match: raise ValueError('The existing Project declaration is invalid.')
                key = match.group(1)
                if key in values and values[key] != args.project: raise ValueError('--project conflicts with its declared parameter.')
                values[key] = args.project
        elif args.project: raise ValueError('--project is only valid for an existing-project Blueprint.')
        if interactive:
            doc=blueprint['document']
            non_target=json.dumps({key:doc.get(key,[]) for key in ['tasks','phases','humanGates','reports']})
            new_project=json.dumps(doc['target'].get('project'))
            for parameter in sorted(parameters, key=lambda p:(not p.get('required',False),p.get('order',0))):
                binding='{{'+parameter['key']+'}}'
                if target['mode']=='existing-project' and doc['target'].get('allowExisting') and binding in new_project and binding not in non_target: continue
                key=parameter['key']
                if key in values: continue
                print(parameter.get('help') or '')
                if parameter['type'].endswith('-ref'):
                    kind=parameter['type'][:-4];surface={'principal':'principals','project':'projects','phase':'phases','skill':'skills','personality':'personalities','service':'services'}[kind]
                    path='/'+surface+(('?projectId='+urllib.parse.quote(args.project,safe='')) if kind=='phase' and args.project else '')
                    if kind != 'phase' or args.project:
                        visible=request('GET',path).get(surface,[])
                        emit([{k:row[k] for k in ['id','name','handle','slug'] if k in row} for row in visible])
                while True:
                    text=input((parameter.get('promptText') or parameter['label'])+' ('+parameter['type']+'): ')
                    if not text and (not parameter.get('required') or parameter.get('default') is not None): break
                    try: values[key]=answer(parameter,text); break
                    except ValueError as error: print(str(error),file=sys.stderr)
        body={'target':target,'parameterValues':values}
        if verb == 'preview' or interactive:
            if interactive: print('4. Preview')
            plan=request('POST',base+'/instantiations/preview',body);emit(plan)
            if verb == 'preview': return
            data=plan['plan']
            if plan.get('targetArchived') or not isinstance(data.get('refusals'),list) or data['refusals'] or any(not row['allowed'] for row in data['authority']) or any(row['outcome']!='resolved' for row in data['references']):
                raise ValueError('The preview cannot be confirmed; resolve its diagnostics first.')
            print('5. Confirm: all tasks stay parked; choosing a human gate arm grants no authority.')
            if input('Type instantiate to confirm this exact preview: ') != 'instantiate': print('Cancelled.');return
        key = args.idempotency_key or str(uuid.uuid4())
        if not 16 <= len(key) <= 128 or not key.strip(): raise ValueError('Idempotency key must contain 16–128 characters.')
        print('Idempotency-Key: '+key,file=sys.stderr)
        if interactive: print('6. Instantiate')
        for attempt in range(2):
            try:
                result=api('POST',base+'/instantiations',body,headers={'Idempotency-Key':key},exit_on_error=False)
                if isinstance(result,dict) and result.get('success') is False:
                    if result.get('status',0)>=500 and attempt==0: continue
                    print(json.dumps(result,ensure_ascii=False),file=sys.stderr);raise SystemExit(1)
                if interactive: print('7. Report')
                emit(result);return
            except (urllib.error.URLError,TimeoutError,ConnectionError,json.JSONDecodeError):
                if attempt==0: continue
                print('Outcome uncertain. Retry the identical request using retained Idempotency-Key: '+key,file=sys.stderr);raise SystemExit(1)
    except (ValueError,OSError,RecursionError) as error:
        print(str(error),file=sys.stderr);raise SystemExit(1)
