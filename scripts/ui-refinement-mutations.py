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
FILTERS = 'src/components/tasks/FilterBar.tsx'
FILES = [TASK.replace('.tsx', '.test.tsx'), SIDEBAR.replace('.tsx', '.refinement.test.tsx'), SKILLS.replace('.tsx', '.refinement.test.tsx'), REPORTS.replace('.tsx', '.refinement.test.tsx'), FILTERS.replace('.tsx', '.refinement.test.tsx')]
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
    # The navigation group's spread, named by the class beside it: the sidebar
    # widget blocks now carry the same spread (re-anchored 19 Oct 2026, 9b761f09).
    ('collapsed-group-inert', SIDEBAR, "{...(collapsed ? { inert: '' } : {})}\n        className={`nav-group-content", "{...{}}\n        className={`nav-group-content", 'a collapsed navigation group excludes hidden links and names its controlled region'),
    # Owner bug report E406: the current page is decided once, by whole path
    # segments with the longest match winning. The mutation brings back the
    # character-prefix rule (first drawn match, dashboard never), which lit
    # Access on the Advanced page.
    ('single-current-page', SIDEBAR, '  const activeEntry = activeNavEntry(location.pathname, drawnEntries);', "  const activeEntry = drawnEntries.find((entry) => entry.path !== '/' && location.pathname.startsWith(entry.path)) ?? (void activeNavEntry, null);", 'marks exactly one entry as the current page, by whole path segments and the longest match'),
    # The same bug in its ORIGINAL shape: every link decides alone with the
    # character prefix, so Access and Advanced are both drawn active on the
    # Advanced page while the shared helper still names one entry. The announced
    # page stays single, so only the highlighted list can tell it apart.
    ('per-link-prefix-highlight', SIDEBAR, "className={`sidebar-nav-link ${active ? 'sidebar-nav-link--active' : ''}`}", "className={`sidebar-nav-link ${(to !== '/' && useLocation().pathname.startsWith(to)) || active ? 'sidebar-nav-link--active' : ''}`}", 'marks exactly one entry as the current page, by whole path segments and the longest match'),
    ('skills-retained-results', SKILLS, '{displayedSkills.map(skill => (', '{(loading ? [] : displayedSkills).map(skill => (', LATEST),
    ('skills-latest-response', SKILLS, 'if (request !== requestSequence.current) return;', '/* mutation: stale response admitted */', LATEST),
    ('skills-keyboard-activation', SKILLS, "onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedSkill(skill); } }}", 'onKeyDown={event => { void event.key; }}', LATEST),
    ('reports-failed-request', REPORTS, "if (!response.ok) throw new Error('Reports could not be loaded.');", 'if (!response.ok) return;', REPORT),
    ('reports-native-destination', REPORTS, 'className="reports-card-row" to={`/reports/${report.id}`}', 'className="reports-card-row" to="/reports"', REPORT),
    # Owner ruling E395 (board filters): the Selected group drawn after the
    # rest instead of leading it, and a filter's own clear reaching every
    # filter. Each reddens only its declared test.
    ('filters-selected-first', FILTERS, '{selectedGroup}\n            {restList}', '{restList}\n            {selectedGroup}', 'selected items lead every filter list'),
    ('filters-clear-own-only', FILTERS, 'const clearListFilter = (key: ListFilterKey) => onFiltersChange({ ...filters, [key]: [] });', 'const clearListFilter = (_key: ListFilterKey) => clearAllFilters();', 'a clear control empties only its own filter'),
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
    # Each file's test inventory as the baseline measured it. Every later run
    # must measure exactly its files' baseline inventory: no test lost, renamed
    # or skipped under a mutation. This replaced four literal counts (48/43/2/1),
    # which drifted the first time a suite grew and then failed every run before
    # any control ran (machinery queue 9b761f09).
    inventory = {}

    def inventory_of(data):
        found = {}
        for f in data['testResults']:
            relative = os.path.relpath(f['name'], clone / 'frontend')
            found[relative] = sorted(a['fullName'] for a in f['assertionResults'])
        return found

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
        measured = inventory_of(data)
        assert sorted(measured) == sorted(selected), f'{name}: a selected file reported no results'
        if not inventory:
            assert all(measured[path] for path in selected), f'{name}: a suite file measured no tests'
            inventory.update(measured)
        assert all(measured[path] == inventory[path] for path in selected), f'{name}: test inventory drift'
        receipts.append({'name': name, 'accepted': True, 'exit': proc.returncode, 'assertions': len(assertions), 'failed': [a['title'] for a in failed], 'report_sha256': hashlib.sha256(report.read_bytes()).hexdigest()})
        (output / 'summary.json').write_text(json.dumps({'source_sha': sha, 'controls': receipts, 'complete': False}, indent=2) + '\n')
        print(name + ': accepted', flush=True)

    try:
        # Every anchor, before anything runs: a drifted one stops the drill by
        # its control's name instead of after minutes of earlier controls.
        for name, relative, old, _new, _expected in CONTROLS:
            assert (clone / 'frontend' / relative).read_text().count(old) == 1, name + ': ambiguous or missing source target'
        suite('baseline', FILES, [])
        # Every control's declared test must be exactly one test of its file,
        # so a renamed test fails here by name rather than as a wrong set.
        baseline = json.loads((output / 'baseline.json').read_text())
        by_file = {os.path.relpath(f['name'], clone / 'frontend'): [a['title'] for a in f['assertionResults']]
                   for f in baseline['testResults']}
        for name, relative, _old, _new, expected in CONTROLS:
            test = relative.replace('.tsx', '.test.tsx' if relative == TASK else '.refinement.test.tsx')
            assert by_file.get(test, []).count(expected) == 1, f'{name}: its declared test is not exactly one test of {test}'
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
        (output / 'summary.json').write_text(json.dumps({'source_sha': sha, 'controls': receipts, 'complete': True, 'source_unchanged': True, 'scope': f'{len(CONTROLS)} named UI source controls; CSS geometry and browser acceptance are separate'}, indent=2) + '\n')
    finally:
        assert fingerprint() == before, 'Live source changed; evidence must be reassessed'


if __name__ == '__main__':
    run()
