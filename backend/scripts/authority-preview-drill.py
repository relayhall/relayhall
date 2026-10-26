"""Finite local source-mutation runner. Restores exact bytes in finally.
Never installs, touches a host mount or reads deployment credentials.
"""
from pathlib import Path
import subprocess, os, json, re, hashlib

root = Path(__file__).resolve().parents[1]
service = root / 'src/services/AuthorizationService.ts'
preview = root / 'src/services/AuthorityPreviewService.ts'
caps = root / 'src/services/ExplicitTaskActionCaps.ts'
delegation = root / 'src/services/DelegationService.ts'
original = {p: p.read_bytes() for p in (service, preview, caps, delegation)}
receipts = []
mutations = [
    ('context-source', service, lambda s: re.sub(r"addArm\('bound-task-context', `[^\n]+`\);", "addArm('bound-task-context', 'FALSE');", s), 'Agent context'),
    ('initiator-source', service, lambda s: s.replace("addArm('initiator', initiator)", "addArm('initiator', 'FALSE')"), 'acting creator'),
    ('verifier-source', service, lambda s: s.replace("addArm('verifier', verifier)", "addArm('verifier', 'FALSE')"), 'acting verifier'),
    ('assigned-cap', service, lambda s: s.replace("${caps.join(' AND ')}", "${caps.length ? 'TRUE' : 'FALSE'}"), 'assigned Connector'),
    ('bound-final-cap', service, lambda s: s.replace("sql = `(${sql} AND ${resource.id} = ${bound})`;", "sql = `(${sql})`;"), 'Agent context'),
    ('selected-expiry', preview, lambda s: s.replace("(!selected || selected.live === true)", "(!selected || selected.id !== undefined)"), 'credential selection'),
    ('concealment', preview, lambda s: s.replace("WHERE cardinality(actions)>0 AND", "WHERE TRUE AND").replace("AND (${allowed.join(' OR ') || 'FALSE'})", "AND TRUE"), 'hides foreign'),
    ('scope-narrowing', preview, lambda s: s.replace('chain, selected.scopes, scopesForRole(account.role)', "chain, selected.scopes.concat('tasks:write'), scopesForRole(account.role)"), 'credential selection'),
    ('verifier-act-cap', caps, lambda s: s.replace("return Boolean(target && target.type === 'task' && target.action === 'verify' && target.identifier === acting.boundTaskId);", 'return Boolean(target) || true;'), 'Agent verifier role'),
    ('bound-context-liveness', delegation, lambda s: s.replace("return Boolean(taskRow && !['completed', 'archived'].includes(String(taskRow.status)) && taskRow.lease_expired !== true);", 'return Boolean(taskRow);'), 'Agent context'),
    ('chain-liveness', preview, lambda s: s.replace('const alive = chain.alive &&', 'const alive = (chain.alive || true) &&'), 'credential selection'),
    ('transport-disclosure', preview, lambda s: s.replace("transport: selected?.transport ?? (presenting", "transport: selected ? 'any' : (presenting"), 'credential selection'),
]
env = dict(os.environ)
if not env.get('RELAYHALL_TEST_DB_URL'): raise SystemExit('Explicit disposable RELAYHALL_TEST_DB_URL required')
try:
    for name, path, transform, test in mutations:
        base = original[path].decode('utf-8')
        changed = transform(base)
        if changed == base: raise RuntimeError('Mutation did not apply: ' + name)
        path.write_text(changed, encoding='utf-8')
        run = subprocess.run(['node','node_modules/jest/bin/jest.js','--runInBand','--runTestsByPath',
            'src/__tests__/authorityPreviewLive.test.ts','--testPathIgnorePatterns=/node_modules/',
            '--testNamePattern=' + test,'--silent'], cwd=root, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=150)
        output = run.stdout + run.stderr
        semantic = run.returncode != 0 and ('expect(received)' in output or 'Expected:' in output) and not re.search(r'error TS\d+|SyntaxError', output)
        log = root / ('p2d-mutation-' + name + '.log')
        log.write_text(output, encoding='utf-8')
        receipts.append({'name':name,'exit':run.returncode,'semanticRed':semantic,'test':test,'log':str(log),
            'beforeSha256':hashlib.sha256(original[path]).hexdigest()})
        path.write_bytes(original[path])
        print(json.dumps(receipts[-1]), flush=True)
        if not semantic: raise RuntimeError('Mutation did not meaningfully redden: ' + name)
finally:
    for path, data in original.items(): path.write_bytes(data)
    (root / 'p2d-mutation-receipts.json').write_text(json.dumps(receipts,indent=2),encoding='utf-8')
