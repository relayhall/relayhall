#!/usr/bin/env python3
"""Strict, source-safe mutation proof for AZ-A13 stage 3 frontend controls.

Each case runs one changed control in an isolated copy of frontend/src. The
copy is placed beneath frontend only so Node resolves the existing installed
dependencies; the candidate source is fingerprinted before and after.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

FRONTEND = Path(__file__).resolve().parents[1] / 'frontend'
NODE = os.environ.get('STAGE3_NODE') or shutil.which('node')
VITEST = FRONTEND / 'node_modules' / 'vitest' / 'vitest.mjs'

# name, file, old, new, test file, expected red test title (or a tuple of
# titles: all of them and only them must redden)
CONTROLS = [
    ('fixed-at-issue copy anywhere', None, None,
     "export const oldAdvice = 'Permissions are fixed when issued; make a narrower one.';\n",
     'src/connectionRecoveryCensus.test.ts',
     'does not restore the superseded fixed-at-issue advice anywhere in frontend/src'),
    ('credential narrow-all payload', 'src/components/connections/CredentialPermissionsEditor.tsx',
     ': { narrowAgents }),', ': { narrowAgents: false }),',
     'src/components/connections/CredentialPermissionsEditor.test.tsx',
     'narrows immediately with optional narrow-all and keeps credential identity'),
    ('credential exact step-up', 'src/components/connections/CredentialPermissionsEditor.tsx',
     'action="credential.edit"', 'action="approval.decide"',
     'src/components/connections/CredentialPermissionsEditor.test.tsx',
     'uses an exact-target step-up and defaults widening lifetime to keep'),
    ('owner named refusal', 'src/components/connections/CredentialPermissionsEditor.tsx',
     "`${data.code}: ${data.message || 'The owner’s current authority caps this credential. Nothing was saved or filed.'}`",
     "'The owner’s current authority caps this credential.'",
     'src/components/connections/CredentialPermissionsEditor.test.tsx',
     'shows the owner cap refusal and never offers root or undisclosed scopes'),
    ('riding-task acknowledgement', 'src/pages/AccessManagerPage.tsx',
     'if (!ceilingChanged) { proceed(false); return; }',
     'if (true) { proceed(false); return; }',
     'src/pages/AccessManagerPage.ceilingRules.test.tsx',
     'a ceiling edit names a riding task before it can be acknowledged'),
    ('warrant narrow-all payload', 'src/pages/AccessManagerPage.tsx',
     '? { narrowAgents: true } : {}', '? { narrowAgents: false } : {}',
     'src/pages/AccessManagerPage.ceilingRules.test.tsx',
     'warrant cap narrowing saves in place and can narrow live Agents without step-up'),
    ('warrant default lifetime', 'src/pages/AccessManagerPage.tsx',
     "setEditLifetime('until-task'); setEditTask(", "setEditLifetime('keep'); setEditTask(",
     'src/pages/AccessManagerPage.ceilingRules.test.tsx',
     'warrant widening preselects until-task and waits for an explicit lifetime endpoint'),
    ('grant explicit lifetime', 'src/pages/GrantsPage.tsx',
     "setEditLifetime(''); setEditTask('');", "setEditLifetime('keep'); setEditTask('');",
     'src/pages/GrantsPage.test.tsx',
     'grant widening has no lifetime preselection and binds step-up to original grant'),
    ('hub object kind', 'src/components/approvals/ApprovalsQueue.tsx',
     "authorityEdit ? approval.authorityEdit?.objectKindLabel ?? 'Authority edit' : approvalKindLabel(approvalKind(approval))",
     "authorityEdit ? 'Authority edit' : approvalKindLabel(approvalKind(approval))",
     'src/components/approvals/ApprovalsQueue.authorityEdit.test.tsx',
     'authority edit names its object and diff, requires a lifetime before step-up, and sends it on approval'),
    # Card 0e07c0c7 moved the body builder into authorityEditLifetime(); the
    # control keeps its mutation (the approval drops the lifetime it sends) on
    # the new assignment, and every hub test that reads the sent lifetime must
    # redden: the original stage 3 case and the three per-option cases.
    ('hub lifetime payload', 'src/components/approvals/ApprovalsQueue.tsx',
     'body.lifetime = lifetime;', 'body.notLifetime = lifetime;',
     'src/components/approvals/ApprovalsQueue.authorityEdit.test.tsx',
     ('authority edit names its object and diff, requires a lifetime before step-up, and sends it on approval',
      'card 0e07c0c7 shortest: without a related task the hub offers "Until a date" first and sends exactly that revertAt',
      'card 0e07c0c7 middle: with a related task, until-task with a date sends the task and the date',
      'card 0e07c0c7 keep: "Keep (until narrowed)" is offered as such and sends keep')),
    ('per-Agent revoke target', 'src/pages/MyConnectionsPage.tsx',
     '`${API_BASE}/credentials/${live.id}/revoke`',
     '`${API_BASE}/credentials/${agent.id}/revoke`',
     'src/pages/MyConnectionsPage.test.tsx',
     'revokes only the chosen live agent’s live and grace credentials'),
    ('verified transport standing passage', 'src/pages/MyConnectionsPage.tsx',
     'mayLoosenTransport={mayLoosenCredentialTransport}', 'mayLoosenTransport={true}',
     'src/pages/MyConnectionsPage.test.tsx',
     'does not offer an ordinary owner looser transport choices for an MCP-pinned credential'),
    ('pinned transport menu', 'src/components/connections/CredentialPermissionsEditor.tsx',
     "(mayLoosenTransport || credential.transport === 'any') && <option value=\"any\">",
     "(true) && <option value=\"any\">",
     'src/components/connections/CredentialPermissionsEditor.test.tsx',
     'offers a pinned transport only to an ordinary owner and all choices to an administrator'),
    ('withdrawn transport standing', 'src/components/connections/CredentialPermissionsEditor.tsx',
     '[credential, mayLoosenTransport]', '[credential]',
     'src/components/connections/CredentialPermissionsEditor.test.tsx',
     'drops a selected looser transport when verified standing is withdrawn'),
    # Card 502fb19e slice S3 (the universal change request, design sections
    # 5.4, 5.6, 6 and 9.4): the generic decide form's controls ride this
    # harness, which already covers ApprovalsQueue.tsx. Each mutation removes
    # one guard and exactly the named tests redden.
    ('change all-of-type exact ids', 'src/components/approvals/ChangeRequestDetail.tsx',
     '<option value="exact">Only these exact ids</option>', '',
     'src/components/approvals/ChangeRequests.test.tsx',
     'an all-of-type grant row narrows to the exact ids the decider types, sent as rules[].selectorForm exact'),
    ('change requester relationships guard', 'src/components/approvals/ChangeRequestDetail.tsx',
     "approval.view === 'requester' ? null : approval.relationships ?? null", 'approval.relationships ?? null',
     'src/components/approvals/ApprovalsHub.test.tsx',
     "the requester's own item: no relationships, no decision, even for a root viewer the old guess would let decide"),
    ('change server decidable', 'src/components/approvals/ApprovalsQueue.tsx',
     "? approval.status === 'pending' && approval.decidable === true",
     "? approval.status === 'pending' && viewerMayDecide(viewer, approval)",
     'src/components/approvals/ApprovalsHub.test.tsx',
     ("the requester's own item: no relationships, no decision, even for a root viewer the old guess would let decide",
      "the Access manager's plain row carries no decidable flag: it offers no decision and points to the hub")),
    ('change legacy decidable guess', 'src/components/approvals/ApprovalsQueue.tsx',
     "? approval.status === 'pending' && approval.decidable === true",
     "? approval.status === 'pending' && approval.decidable !== false && viewerMayDecide(viewer, approval)",
     'src/components/approvals/ApprovalsHub.test.tsx',
     "the Access manager's plain row carries no decidable flag: it offers no decision and points to the hub"),
    ('change compartment preview before filing', 'src/components/approvals/RequestChangeDialog.tsx',
     'sourceId && everyTickedRequestable) {', 'sourceId && projectIds.length > 0) {',
     'src/components/approvals/ChangeRequests.test.tsx',
     'from the Knowledge page: previews each ticked Project, names a refusal before filing, and files the requestable ones in one request'),
    ('change sheet theme tokens', 'src/components/approvals/ChangeRequests.css',
     'background: var(--scrim);', 'background: rgba(0, 0, 0, 0.5);',
     'src/hubThemeTokens.test.ts',
     'components/approvals/ChangeRequests.css: no literal colour, and every colour token exists in all three Themes'),
    # E476 finding (F7 subtask 2085754): the credential actions on My connections
    # say what they touch. Each mutation removes one guard; exactly the named
    # tests redden.
    ('credential actions: several credentials start on no pick', 'src/pages/MyConnectionsPage.tsx',
     "connection.credentials.length === 1 ? connection.credentials[0].id : ''",
     "primaryCredential(connection)?.id ?? ''",
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     ('a connection with several credentials starts on no pick, and Revoke and Regenerate wait for one', 'an unpicked connection still shows its Setup instructions rather than demanding a pick first', 'with no pick the scopes section says to choose one rather than claiming there is no credential')),
    ('credential actions: Revoke waits for a pick', 'src/pages/MyConnectionsPage.tsx',
     "disabled={!credential || busy || credential.state === 'revoked'}",
     "disabled={busy || credential?.state === 'revoked'}",
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     ('a connection with several credentials starts on no pick, and Revoke and Regenerate wait for one', 'a pick that vanished on refresh asks for another choice, keeps both actions off and never retargets')),
    ('credential actions: Regenerate waits for a pick', 'src/pages/MyConnectionsPage.tsx',
     'disabled={!credential || notLive || busy || !mayRegenerate || confirming}',
     'disabled={notLive || busy || !mayRegenerate || confirming}',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     ('a connection with several credentials starts on no pick, and Revoke and Regenerate wait for one', 'a pick that vanished on refresh asks for another choice, keeps both actions off and never retargets')),
    ('credential actions: the revoke posts the picked id', 'src/pages/MyConnectionsPage.tsx',
     '`${API_BASE}/credentials/${credential.id}/revoke`',
     '`${API_BASE}/credentials/${connection.credentials[0].id}/revoke`',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'the first press asks and posts nothing; the second explicit press revokes only the picked credential'),
    ('credential actions: the replace posts the picked id', 'src/pages/MyConnectionsPage.tsx',
     '`${API_BASE}/credentials/${credential.id}/rotate`',
     '`${API_BASE}/credentials/${connection.credentials[0].id}/rotate`',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     ('regenerating posts only the picked credential with the grace window, and the notice repeats what it did', 'the notice names the NEW key id the secret belongs to and the key id it replaces, not the old one as the new')),
    ('credential actions: the replace sends its grace window', 'src/pages/MyConnectionsPage.tsx',
     'JSON.stringify({ graceHours: REPLACE_GRACE_HOURS })',
     'JSON.stringify({})',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'regenerating posts only the picked credential with the grace window, and the notice repeats what it did'),
    ('credential actions: Cancel returns focus to Revoke', 'src/pages/MyConnectionsPage.tsx',
     '<Button variant="secondary" onClick={() => closeConfirmation(\'trigger\')}>Cancel</Button>',
     '<Button variant="secondary" onClick={() => closeConfirmation(null)}>Cancel</Button>',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'Cancel backs out without posting and returns focus to the Revoke button'),
    ('credential actions: Escape backs out', 'src/pages/MyConnectionsPage.tsx',
     "if (event.key === 'Escape')",
     "if (event.key === 'Esc')",
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'Escape backs out without posting and returns focus to the Revoke button'),
    ('credential actions: focus moves into the confirmation', 'src/pages/MyConnectionsPage.tsx',
     'if (confirming) confirmRef.current?.focus();',
     'if (confirming) void 0;',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     ('focus moves into the confirmation when it opens', 'Escape backs out without posting and returns focus to the Revoke button')),
    ('credential actions: a moved pick drops the confirmation', 'src/pages/MyConnectionsPage.tsx',
     'if (confirmingId !== null && credential?.id !== confirmingId) setConfirmingId(null);',
     'if (false) setConfirmingId(null);',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'changing the picked credential while the confirmation is open closes it and posts nothing'),
    ('credential actions: the confirmation names the key id', 'src/pages/MyConnectionsPage.tsx',
     '<dt>Key id</dt><dd><code className="conn-inline-code">{credential.keyId ?? \'none\'}</code></dd>',
     '',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'the confirmation names the label, key id, transport and full id, and says what stays unchanged'),
    ('credential actions: the replace help rides the button description', 'src/pages/MyConnectionsPage.tsx',
     "ariaDescribedBy={`${replaceHelpId}${credential ? '' : ` ${pickHintId}`}${notLive ? ` ${stateHintId}` : ''}`}",
     '',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     ('Regenerate says on its description that it touches only the picked credential, is not a revoke and keeps the old secret for its grace hours', 'Regenerate waits for a live credential: a replaced, still-working or revoked one cannot be regenerated again')),
    ('credential actions: Setup stays available without a pick', 'src/pages/MyConnectionsPage.tsx',
     'const setupAvailable = !selectionVanished && connection.credentials.length > 0;',
     'const setupAvailable = credential !== null;',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'an unpicked connection still shows its Setup instructions rather than demanding a pick first'),
    ('credential actions: the notice says it is not a revoke', 'src/pages/MyConnectionsPage.tsx',
     "This is not a revoke, and the connection's other credentials are unchanged.",
     "The connection's other credentials are unchanged.",
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'regenerating posts only the picked credential with the grace window, and the notice repeats what it did'),
    ('credential actions: Revoke asks first', 'src/pages/MyConnectionsPage.tsx',
     'onClick={() => { if (credential) setConfirmingId(credential.id); }}',
     'onClick={() => { if (credential) void onRevoke(credential.id); }}',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     ('the first press asks and posts nothing; the second explicit press revokes only the picked credential', 'the confirmation names the label, key id, transport and full id, and says what stays unchanged', 'focus moves into the confirmation when it opens', 'Cancel backs out without posting and returns focus to the Revoke button', 'Escape backs out without posting and returns focus to the Revoke button', 'changing the picked credential while the confirmation is open closes it and posts nothing', 'the notice after a confirmed revoke names the credential and says the connector stays enabled', 'a refused revoke says it was a revoke that failed', "while the row is busy, the confirmation's own button is as locked as the Revoke button was", 'the word disable never describes a single credential on the Advanced tab', 'axe finds no structural violation with four credentials and the confirmation open (relay-dark)', 'axe finds no structural violation with four credentials and the confirmation open (relay-light)', 'axe finds no structural violation with four credentials and the confirmation open (high-contrast)')),
    ('credential actions: Revoke help rides the button description', 'src/pages/MyConnectionsPage.tsx',
     "ariaDescribedBy={`${revokeHelpId}${credential ? '' : ` ${pickHintId}`}`}",
     '',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'Revoke says on its description that the connection and its other credentials are left as they are'),
    ('credential actions: the replace notice names the new key id', 'src/pages/MyConnectionsPage.tsx',
     "const newKeyId = data.keyId ?? data.id ?? 'the new credential';",
     "const newKeyId = credential.keyId ?? credential.id;",
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'the notice names the NEW key id the secret belongs to and the key id it replaces, not the old one as the new'),
    ('credential actions: the replace notice names the key id it replaces', 'src/pages/MyConnectionsPage.tsx',
     "const previousKeyId = data.previousKeyId ?? credential.keyId ?? credential.id;",
     "const previousKeyId = newKeyId;",
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'the notice names the NEW key id the secret belongs to and the key id it replaces, not the old one as the new'),
    ('credential actions: Regenerate waits for a live credential', 'src/pages/MyConnectionsPage.tsx',
     "const notLive = credential !== null && credential.state !== 'live';",
     'const notLive = false;',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'Regenerate waits for a live credential: a replaced, still-working or revoked one cannot be regenerated again'),
    ('credential actions: the confirmation button locks while busy', 'src/pages/MyConnectionsPage.tsx',
     'icon={<ShieldOff size={16} />} disabled={busy} onClick={confirmRevoke}>',
     'icon={<ShieldOff size={16} />} onClick={confirmRevoke}>',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     "while the row is busy, the confirmation's own button is as locked as the Revoke button was"),
    ('credential actions: a vanished pick asks for another choice', 'src/pages/MyConnectionsPage.tsx',
     ') : selectionVanished ? (\n          <p className="conn-note">The credential you picked is gone',
     ') : false ? (\n          <p className="conn-note">The credential you picked is gone',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     'a pick that vanished on refresh asks for another choice, keeps both actions off and never retargets'),
    ('credential actions: no single-credential disable wording', 'src/pages/MyConnectionsPage.tsx',
     'agent and revoking this credential.',
     'agent and disabling this one.',
     'src/pages/MyConnectionsCredentialActions.test.tsx',
     ('the word disable never describes a single credential on the Advanced tab', 'a member session sees Regenerate refused with the reason, and the replacement route advises a revoke of this credential')),
]

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', required=True, type=Path)
    parser.add_argument('--control', action='append', help='run only names starting with this prefix')
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    chosen = [c for c in CONTROLS if not args.control or any(c[0].startswith(p) for p in args.control)]
    if not chosen or not NODE or not Path(NODE).exists() or not VITEST.exists():
        raise SystemExit('No controls selected or installed Node/Vitest unavailable')
    originals = {FRONTEND / c[1] for c in chosen if c[1]}
    originals.add(FRONTEND / 'src/connectionRecoveryCensus.test.ts')
    before = {str(p.relative_to(FRONTEND)): sha(p) for p in originals}
    results = []
    for index, (name, file, old, new, suite, expected) in enumerate(chosen, 1):
        with tempfile.TemporaryDirectory(prefix='.stage3-mutation-', dir=FRONTEND) as directory:
            copy = Path(directory)
            shutil.copytree(FRONTEND / 'src', copy / 'src')
            shutil.copy2(FRONTEND / 'vitest.config.ts', copy / 'vitest.config.ts')
            if file:
                target = copy / file
                source = target.read_text(encoding='utf-8')
                if source.count(old) != 1:
                    raise RuntimeError(f'{name}: mutation anchor count {source.count(old)}')
                target.write_text(source.replace(old, new), encoding='utf-8')
            else:
                target = copy / 'src' / 'components' / 'Stage3OldCopyProbe.tsx'
                if target.exists():
                    raise RuntimeError('fixed-at-issue probe already exists')
                target.write_text(new, encoding='utf-8')
            report = args.output_dir / f'{index:02d}-vitest.json'
            env = dict(os.environ, TZ='UTC', NODE_ENV='test')
            run = subprocess.run([str(NODE), str(VITEST), 'run', suite,
                                  '--pool=forks', '--maxWorkers=1', '--minWorkers=1',
                                  '--reporter=json', f'--outputFile={report}'],
                                 cwd=copy, env=env, text=True, capture_output=True,
                                 timeout=90)
            if not report.exists():
                raise RuntimeError(f'{name}: Vitest produced no JSON (exit {run.returncode})')
            data = json.loads(report.read_text(encoding='utf-8'))
            assertions = [a for result in data.get('testResults', [])
                          for a in result.get('assertionResults', [])]
            red = [a['title'] for a in assertions if a.get('status') == 'failed']
            green = sum(a.get('status') == 'passed' for a in assertions)
            wanted = sorted(expected) if isinstance(expected, tuple) else [expected]
            ok = run.returncode == 1 and sorted(red) == wanted and green > 0
            results.append({'control': name, 'red': red, 'expected': expected,
                            'unaffectedGreen': green, 'assertionFailureOnly': ok,
                            'mutantReport': report.name})
            print(f'{index}/{len(chosen)} {name}: {"PASS" if ok else "FAIL"} '
                  f'(red={len(red)}, other green={green})', flush=True)
            if not ok:
                break
    after = {str(p.relative_to(FRONTEND)): sha(p) for p in originals}
    receipt = {'candidateUnchanged': before == after, 'sourceHashes': after,
               'controls': results, 'allStrict': before == after and len(results) == len(chosen)
               and all(item['assertionFailureOnly'] for item in results)}
    (args.output_dir / 'matrix.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    if not receipt['allStrict']:
        raise SystemExit(1)

if __name__ == '__main__':
    main()
