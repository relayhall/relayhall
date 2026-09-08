"""Bounded source controls; exact source restore even on failed probe."""
import hashlib,json,pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
registry='backend/src/mcp/registry.ts';cli='cli/relayhall_blueprints.py'
cases=[
('D26-four-registrations',cli,"for verb in ['submit', 'withdraw', 'reject', 'publish', 'retire']:","for verb in ['retire']:",'cli','test_lifecycle_registered_dispatcher',4),
('D15-forbidden-MCP-publish',registry,'export const MCP_TOOLS: McpTool[] = [',"export const MCP_TOOLS: McpTool[] = [\n  {name:'relayhall_blueprint_publish',plane:'work',description:'Forbidden probe',inputSchema:{},handler:async()=> 'probe'},",'mcp','exactly six approved work-plane',1),
('MCP-required-key',registry,"const id = req(args, 'blueprintId'); const key = req(args, 'idempotencyKey');\n      if (key.length < 16 || key.length > 128)","const id = req(args, 'blueprintId'); const key = req(args, 'idempotencyKey');\n      if (false)",'mcp','runtime refuses invalid key',2),
('MCP-header-forwarding',registry,"headers: { 'Idempotency-Key': key }, requiredScope: 'blueprints:use and plan authorities'","headers: { 'Idempotency-Key': 'wrong-key-for-probe' }, requiredScope: 'blueprints:use and plan authorities'",'mcp','full .* receipt',2),
('MCP-complete-receipt',registry,"return responseFormatOf(args) === 'detailed' ? json(envelope) : untrusted(label, json(envelope));","return responseFormatOf(args) === 'detailed' ? json({ projectId: envelope.projectId }) : untrusted(label, json({ projectId: envelope.projectId }));",'mcp','full .* receipt',2),
('MCP-target-closed',registry,"rejectUnknown(record, record.mode === 'existing-project' ? ['mode', 'project'] : ['mode']);","void record;",'mcp','runtime rejects unknown',2),
('CLI-retry-key',cli,"headers={'Idempotency-Key':key},exit_on_error=False","headers={'Idempotency-Key':str(uuid.uuid4())},exit_on_error=False",'cli','test_exact_key_body_retry_through_dispatcher',1),
('CLI-confirmation-bypass',cli,"if input('Type instantiate to confirm this exact preview: ') != 'instantiate':","if False:",'cli','test_interactive_confirmation_is_not_global_yes',1),
('CLI-pattern-bypass',cli,"if rules.get('pattern') and not matches_pattern(rules['pattern'],text):","if False:",'cli','test_bounded_pattern_and_typed_constraints',1),
]
results=[]
for name,path,old,new,kind,selector,minfailed in cases:
    if len(sys.argv)>3 and name not in sys.argv[3:]:continue
    source=root/path;original=source.read_bytes();text=original.decode();assert text.count(old)==1,(name,text.count(old))
    row={'control':name,'file':path,'sourceSha256':hashlib.sha256(original).hexdigest()}
    try:
        source.write_bytes(text.replace(old,new).encode());log=out/f'{name}.log'
        if kind=='cli':cmd=['python3','-m','pytest','-q','cli/test_blueprints.py','-k',selector];cwd=root
        else:cmd=['node','node_modules/jest/bin/jest.js','--runInBand','--runTestsByPath','src/__tests__/mcpBlueprintContract.test.ts','-t',selector,'--json',f'--outputFile={out/name}.json'];cwd=root/'backend'
        with log.open('w') as stream:run=subprocess.run(cmd,cwd=cwd,stdout=stream,stderr=subprocess.STDOUT,timeout=90)
        output=log.read_text();failed=0
        if kind=='cli':
            import re
            match=re.search(r'(\d+) failed',output);failed=int(match[1]) if match else 0
            assertion='AssertionError' in output or 'Failed: DID NOT RAISE' in output
        else:
            report=json.loads((out/f'{name}.json').read_text());failed=report.get('numFailedTests',0)
            assertion=any(a.get('status')=='failed' and a.get('failureMessages') for suite in report.get('testResults',[]) for a in suite.get('assertionResults',[]))
        row.update(exit=run.returncode,failed=failed,red=run.returncode!=0 and failed>=minfailed and assertion)
    finally:source.write_bytes(original);row['restored']=source.read_bytes()==original
    results.append(row);(out/'summary.json').write_text(json.dumps(results,indent=2));print(json.dumps(row),flush=True)
    if not row['red'] or not row['restored']:sys.exit(1)
