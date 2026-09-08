#!/usr/bin/env python3
"""Named UI regressions on a disposable Git clone; never mutate the source tree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

TASK = 'src/pages/TaskDetailPage.tsx'
SIDEBAR = 'src/components/Sidebar.tsx'
SKILLS = 'src/pages/SkillsPage.tsx'
REPORTS = 'src/components/dashboard/ReportsCard.tsx'
FILES = [TASK.replace('.tsx', '.test.tsx'), SIDEBAR.replace('.tsx', '.refinement.test.tsx'), SKILLS.replace('.tsx', '.refinement.test.tsx'), REPORTS.replace('.tsx', '.refinement.test.tsx')]
LANDMARK = 'exposes keyboard-scrollable landmarks and native navigation for stacked regions'
PENDING = 'keeps a rejected subtask draft and admits only one pending submission before a successful retry'
LATEST = 'retains useful rows during filtering and only the latest response settles the view'
REPORT = 'reports a failed load, retries it and exposes native report links'
CONTROLS = [
    ('base-aware-region-link', TASK, 'href={`${route}#task-detail-timeline`}', 'href="#task-detail-timeline"', LANDMARK),
    ('details-keyboard-scroll', TASK, 'id="task-detail-panel-details" tabIndex={0}', 'id="task-detail-panel-details" tabIndex={-1}', LANDMARK),
    ('work-keyboard-scroll', TASK, 'id="task-detail-work" tabIndex={0}', 'id="task-detail-work" tabIndex={-1}', LANDMARK),
    ('timeline-keyboard-scroll', TASK, 'id="task-detail-timeline" tabIndex={0}', 'id="task-detail-timeline" tabIndex={-1}', LANDMARK),
    ('initial-loading-announcement', TASK, 'className="task-detail-skeleton" role="status"', 'className="task-detail-skeleton" role="presentation"', 'announces initial loading and settles into the requested Task'),
    ('duplicate-subtask-admission', TASK, 'if (subtaskSavePending.current) return false;', '/* mutation: duplicate request admitted */', PENDING),
    ('rejected-subtask-draft', TASK, "if (saved) setSubtaskDraft('');", "if (saved || !saved) setSubtaskDraft('');", PENDING),
    ('mobile-navigation-close', SIDEBAR, 'useEffect(() => { setMobileOpen(false); }, [location.pathname]);', 'useEffect(() => { void location.pathname; }, [location.pathname]);', 'closes the mobile menu after navigation and restores desktop navigation after resize'),
    ('collapsed-group-inert', SIDEBAR, "{...(collapsed ? { inert: '' } : {})}", '{...{}}', 'a collapsed navigation group excludes hidden links and names its controlled region'),
    ('skills-retained-results', SKILLS, '{displayedSkills.map(skill => (', '{(loading ? [] : displayedSkills).map(skill => (', LATEST),
    ('skills-latest-response', SKILLS, 'if (request !== requestSequence.current) return;', '/* mutation: stale response admitted */', LATEST),
    ('skills-keyboard-activation', SKILLS, "onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedSkill(skill); } }}", 'onKeyDown={event => { void event.key; }}', LATEST),
    ('reports-failed-request', REPORTS, "if (!response.ok) throw new Error('Reports could not be loaded.');", 'if (!response.ok) return;', REPORT),
    ('reports-native-destination', REPORTS, 'className="reports-card-row" to={`/reports/${report.id}`}', 'className="reports-card-row" to="/reports"', REPORT),
]


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    assert source.is_dir() and not output.exists()
    assert output != source and source not in output.parents
    assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=source, text=True).strip(), 'Source must be clean'
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=source).decode().split('\0')

    def fingerprint():
        return {p: hashlib.sha256((source / p).read_bytes()).hexdigest() for p in tracked if p}

    before = fingerprint()
    output.mkdir(parents=True)
    clone = output / 'copy'
    subprocess.run(['git', 'clone', '--shared', '--no-hardlinks', str(source), str(clone)], check=True, capture_output=True)
    subprocess.run(['git', 'checkout', '--detach', sha], cwd=clone, check=True, capture_output=True)
    modules = source / 'frontend/node_modules'
    assert (modules / 'vitest/vitest.mjs').is_file()
    (clone / 'frontend/node_modules').symlink_to(modules, target_is_directory=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith('DB_') and k != 'RELAYHALL_TEST_DB_URL'}
    env.update(NODE_ENV='test', CI='true')
    receipts = []

    def suite(name, selected, expected):
        report = output / (name + '.json')
        with (output / (name + '.log')).open('w') as log:
            proc = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *selected, '--reporter=json', '--outputFile=' + str(report)], cwd=clone / 'frontend', env=env, stdout=log, stderr=subprocess.STDOUT)
        assert report.exists(), f'{name}: no assertion report (not an accepted red)'
        data = json.loads(report.read_text())
        assertions = [a for f in data['testResults'] for a in f['assertionResults']]
        failed = [a for a in assertions if a['status'] == 'failed']
        assert all(a.get('failureMessages') for a in failed), f'{name}: missing semantic assertion diagnostics'
        assert sorted(a['title'] for a in failed) == sorted(expected), f'{name}: wrong failed test set'
        assert not data.get('testExecError') and data.get('numRuntimeErrorTestSuites', 0) == 0, f'{name}: runtime failure'
        assert proc.returncode == (1 if expected else 0), f'{name}: unexpected exit'
        assert len(assertions) == (48 if len(selected) == 4 else (43 if selected[0] == FILES[0] else 2 if selected[0] in FILES[1:3] else 1)), f'{name}: test inventory drift'
        receipts.append({'name': name, 'accepted': True, 'exit': proc.returncode, 'assertions': len(assertions), 'failed': [a['title'] for a in failed], 'report_sha256': hashlib.sha256(report.read_bytes()).hexdigest()})
        (output / 'summary.json').write_text(json.dumps({'source_sha': sha, 'controls': receipts, 'complete': False}, indent=2) + '\n')
        print(name + ': accepted', flush=True)

    try:
        suite('baseline', FILES, [])
        for name, relative, old, new, expected in CONTROLS:
            path = clone / 'frontend' / relative
            original = path.read_text()
            assert original.count(old) == 1, name + ': ambiguous or missing source target'
            try:
                path.write_text(original.replace(old, new))
                test = relative.replace('.tsx', '.test.tsx' if relative == TASK else '.refinement.test.tsx')
                suite(name, [test], [expected])
            finally:
                path.write_text(original)
        suite('restored', FILES, [])
        assert fingerprint() == before, 'Live source bytes changed during replay'
        assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip() == sha
        # Git ignores node_modules directories, but the owned dependency link is
        # a symlink. Remove that harness link before asserting a clean copy.
        dependency_link = clone / 'frontend/node_modules'
        assert dependency_link.is_symlink() and dependency_link.resolve() == modules.resolve()
        dependency_link.unlink()
        assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=clone, text=True).strip(), 'Copy was not restored'
        (output / 'source-fingerprint.json').write_text(json.dumps(before, indent=2) + '\n')
        (output / 'summary.json').write_text(json.dumps({'source_sha': sha, 'controls': receipts, 'complete': True, 'source_unchanged': True, 'scope': '14 named UI source controls; CSS geometry and browser acceptance are separate'}, indent=2) + '\n')
    finally:
        assert fingerprint() == before, 'Live source changed; evidence must be reassessed'


if __name__ == '__main__':
    run()
