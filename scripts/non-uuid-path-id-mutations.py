#!/usr/bin/env python3
"""E159 bounded local guard-removal drill; restores exact source in finally.

Requires backend dependencies. --live additionally requires the explicit
disposable RELAYHALL_TEST_DB_URL accepted by nonUuidPathIdLive.test.ts.
Receipts include exact failing test names and source SHA-256 before/after.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / 'backend'
FAST = ['nonUuidPathIdCensus', 'nonUuidPathIdIntegerBounds', 'nonUuidPathIdAuthorizationStage']

def digest(data):
    return hashlib.sha256(data).hexdigest()

def run(out, label, live=False, pattern=None):
    target = out / (label + '.json')
    args = ['node', 'node_modules/jest/bin/jest.js', '--runInBand', '--json', '--outputFile=' + str(target), '--runTestsByPath']
    args += ['src/__tests__/' + name + '.test.ts' for name in (['nonUuidPathIdLive'] if live else FAST)]
    if live:
        args += ['--testPathIgnorePatterns=/node_modules/']
    if pattern:
        args += ['--testNamePattern=' + pattern]
    with (out / (label + '.log')).open('w', encoding='utf-8') as log:
        result = subprocess.run(args, cwd=BACKEND, stdout=log, stderr=subprocess.STDOUT, timeout=180)
    data = json.loads(target.read_text(encoding='utf-8'))
    return result.returncode, data

def assertions(data):
    return [case for suite in data['testResults'] for case in suite['assertionResults']]

def replace_nth(text, old, new, index=0):
    positions = [m.start() for m in re.finditer(re.escape(old), text)]
    if len(positions) <= index:
        raise RuntimeError('Exact guard marker not found')
    start = positions[index]
    return text[:start] + new + text[start+len(old):]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--guards', nargs='+', help='Bounded rework: select these fast guards; --live still adds its live guards.')
    args = parser.parse_args()
    out = args.out.resolve(); out.mkdir(parents=True, exist_ok=True)
    code, base = run(out, 'control-green')
    if code or base['numFailedTests']:
        raise RuntimeError('Green control required before mutations')
    names = [case['fullName'] for case in assertions(base)]
    malformed = lambda family, param: rf'^{family} mocked route census .* :{param} malformed '
    mutations = [
        ('project-id', 'middleware/sharedAuthorization.ts', 'if (await refuseMalformedProjectId(req, res, actor, mountedPath, required, ownerChange)) return;', 'if (false && await refuseMalformedProjectId(req, res, actor, mountedPath, required, ownerChange)) return;', 0, r'^projects mocked route census .* :id malformed |^projects mocked route census (POST /:id/brief|PUT /:id/owner|PUT /:id/default-verifier) :id route-specific|^a Project is addressed by its id: refused by shape before any read (root|an Account the owner-change)'),
        ('project-resource-id', 'routes/projects.ts', "router.param('resourceId', pathUuidParam('INVALID_RESOURCE_ID', 'resource'));", '', 0, malformed('projects', 'resourceId')),
        ('project-skill-id', 'routes/projects.ts', "router.param('skillId', pathUuidParam('INVALID_SKILL_ID', 'skill'));", '', 0, malformed('projects', 'skillId')),
        ('personality-id', 'middleware/sharedAuthorization.ts', 'if (!isFullUuid(personalityId)) {', 'if (false && !isFullUuid(personalityId)) {', 0, malformed('personalities', 'id') + r'|^R1 spelling variants personalities .* malformed |^R1 spelling variants personalities PATCH .* a family-scoped caller|^R1 reviewer reproduction (PATCH|DELETE) '),
        ('provider-id', 'routes/identityProviders.ts', "router.param('id', pathUuidParam('INVALID_IDENTITY_PROVIDER_ID', 'identity provider'));", '', 0, malformed('identityProviders', 'id')),
        ('provider-link-id', 'routes/identityProviders.ts', "router.param('linkId', pathUuidParam('INVALID_IDENTITY_LINK_ID', 'identity link'));", '', 0, malformed('identityProviders', 'linkId')),
        ('provider-group-id', 'routes/identityProviders.ts', "router.param('groupId', pathUuidParam('INVALID_GROUP_ID', 'group'));", '', 0, malformed('identityProviders', 'groupId')),
        ('credential-reveal-id', 'routes/credentials.ts', 'if (refuseMalformedCredentialId(req, res)) return;', '', 0, r'^credentials mocked route census POST /:id/reveal :id malformed '),
        ('credential-revoke-id', 'routes/credentials.ts', 'if (refuseMalformedCredentialId(req, res)) return;', '', 1, r'^credentials mocked route census POST /:id/revoke :id malformed '),
        ('credential-rotate-id', 'routes/credentials.ts', 'if (refuseMalformedCredentialId(req, res)) return;', '', 2, r'^credentials mocked route census POST /:id/rotate :id malformed '),
        ('credential-revoke-pre-read', 'routes/credentials.ts', 'const existing = isFullUuid(req.params.id)', 'const existing = true', 0, r'^credentials mocked route census POST /:id/revoke :id (malformed |route-specific)'),
        ('credential-rotate-denial-pre-read', 'routes/credentials.ts', 'const found = isFullUuid(req.params.id) ?', 'const found = true ?', 0, r'^credential rotation denial pre-read guard malformed '),
        ('notification-endpoint-id', 'routes/notificationEndpoints.ts', "router.param('id', pathUuidParam('INVALID_NOTIFICATION_ENDPOINT_ID', 'notification endpoint'));", "router.param('id', (_req, _res, next) => { void pathUuidParam; next(); });", 0, malformed('notificationEndpoints', 'id')),
        ('appearance-asset-id', 'routes/appearanceAdmin.ts', 'if (!isFullUuid(req.params.id)) {', 'if (false && !isFullUuid(req.params.id)) {', 0, malformed('appearance', 'id')),
        ('service-version-stage', 'middleware/sharedAuthorization.ts', "if (!/^\\d+$/.test(descriptorVersion) || Number(descriptorVersion) < 1 || Number(descriptorVersion) > 2147483647) {", "if (false && (!/^\\d+$/.test(descriptorVersion) || Number(descriptorVersion) < 1 || Number(descriptorVersion) > 2147483647)) {", 0, malformed('services', 'version') + r'|^R1 spelling variants services .* malformed |^R1 reviewer reproduction GET '),
        ('service-version-int4', 'services/ServiceRegistry.ts', 'if (version > 2147483647) {', 'if (false && version > 2147483647) {', 0, r'^descriptor (read|retire) integer bound refuses '),
        ('charter-version-int4', 'services/CharterService.ts', 'if (version > 2147483647) {', 'if (false && version > 2147483647) {', 0, r'^charter read integer bound refuses '),
        ('appearance-version-int4', 'services/AppearanceService.ts', 'if (versionNo > 2147483647) {', 'if (false && versionNo > 2147483647) {', 0, r'^appearance revert integer bound refuses '),
        ('account-owner-shape', 'middleware/sharedAuthorization.ts', '&& isFullUuid(ownerTarget.identifier)', '', 0, r'^the account-owner arm reads only .*an Account without tasks:admin'),
    ]
    receipts = []
    requested = set(args.guards or [])
    known = {mutation[0] for mutation in mutations}
    if requested - known:
        raise RuntimeError('Unknown fast guard names: ' + ', '.join(sorted(requested - known)))
    if requested:
        mutations = [mutation for mutation in mutations if mutation[0] in requested]
    for label, relative, old, new, nth, expected_pattern in mutations:
        path = BACKEND / 'src' / relative; original = path.read_bytes()
        expected = sorted(name for name in names if re.search(expected_pattern, name))
        if not expected:
            raise RuntimeError('Empty expected case set: ' + label)
        try:
            path.write_text(replace_nth(original.decode('utf-8'), old, new, nth), encoding='utf-8', newline='')
            code, data = run(out, label)
            failed = sorted(case['fullName'] for case in assertions(data) if case['status'] == 'failed')
            receipt = dict(guard=label, source=relative, before=digest(original), mutant=digest(path.read_bytes()),
                           returncode=code, expected=expected, failed=failed, green=data['numPassedTests'], exact=failed == expected)
        finally:
            path.write_bytes(original)
        receipt['restored'] = digest(path.read_bytes()) == digest(original)
        receipts.append(receipt)
        (out / 'mutations.json').write_text(json.dumps(receipts, indent=2), encoding='utf-8')
        print(label, 'EXACT' if receipt['exact'] and receipt['restored'] else 'MISMATCH', len(failed), flush=True)
        if not receipt['exact'] or not receipt['restored']:
            raise RuntimeError('Mutation mismatched expected cases: ' + label)
    if args.live:
        live_mutations = [
            ('task-id', 'routes/tasks.ts', "router.param('id', taskIdParam);", '', 0, '^tasks: every'),
            ('task-dependency-id', 'routes/tasks.ts', "router.param('depTaskId', taskIdParam);", '', 0, '^tasks: every'),
            ('task-lease-id', 'routes/tasks.ts', "router.param('leaseId', pathUuidParam('INVALID_LEASE_ID', 'lease'));", "router.param('leaseId', (_req, _res, next) => { void pathUuidParam; next(); });", 0, '^tasks: every'),
            ('auth-session-id', 'routes/auth.ts', 'if (!isFullUuid(req.params.id)) {', 'if (false && !isFullUuid(req.params.id)) {', 0, '^auth sessions:'),
            ('oauth-consent-id', 'routes/oauth.ts', 'if (refuseMalformedRequestId(req, res)) return;', '', 0, '^oauth:'),
            ('oauth-decision-id', 'routes/oauth.ts', 'if (refuseMalformedRequestId(req, res)) return;', '', 1, '^oauth:'),
            # The census table itself: a route left out of it is named by the
            # census assertion (machinery queue 9b761f09: the three subtask
            # structure verbs were missing until 23 Oct 2026).
            ('task-census-table-drops-a-route', '__tests__/nonUuidPathIdLive.test.ts',
             "'POST /tasks/:id/subtasks/reorder', ", '', 0, '^tasks: every',
             'not in the census table: POST /tasks/:id/subtasks/reorder'),
        ]
        for label, relative, old, new, nth, pattern, *named in live_mutations:
            path = BACKEND / 'src' / relative; original = path.read_bytes()
            try:
                path.write_text(replace_nth(original.decode('utf-8'), old, new, nth), encoding='utf-8', newline='')
                code, data = run(out, label, True, pattern)
                cases = assertions(data); failed = [case['fullName'] for case in cases if case['status'] == 'failed']
                # The census assertion prints every changed route/parameter/value;
                # the same family's unknown/authority controls must stay green.
                exact = len(failed) == 1 and 'census:' in failed[0] and data['numPassedTests'] == 1
                # A control that names what the census must report checks the message too.
                messages = json.dumps([case['failureMessages'] for case in cases if case['status'] == 'failed'])
                exact = exact and all(name in messages for name in named)
                receipt = dict(guard=label, source=relative, before=digest(original), mutant=digest(path.read_bytes()),
                               returncode=code, failed=failed, green=data['numPassedTests'], exact=exact,
                               failures=[case['failureMessages'] for case in cases if case['status'] == 'failed'])
            finally:
                path.write_bytes(original)
            receipt['restored'] = digest(path.read_bytes()) == digest(original)
            receipts.append(receipt)
            (out / 'mutations.json').write_text(json.dumps(receipts, indent=2), encoding='utf-8')
            print(label, 'EXACT' if exact and receipt['restored'] else 'MISMATCH', len(failed), flush=True)
            if not exact or not receipt['restored']:
                raise RuntimeError('Live mutation mismatched family controls: ' + label)
    code, green = run(out, 'restored-green')
    if code or green['numFailedTests']:
        raise RuntimeError('Restored candidate did not pass')
    print('All guards restored; green control passed.', flush=True)

if __name__ == '__main__':
    main()
