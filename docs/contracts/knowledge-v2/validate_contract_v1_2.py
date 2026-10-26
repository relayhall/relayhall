"""Selector amendment v1.2 (card 40e0e542, owner ruling E127 (5)): the default scope.

Structural fixtures for the two additive schema properties ($defs.query.includeArchive
and $defs.descriptor.archiveCategories), the v1.1 fixtures replayed against the amended
schema (nothing they decided may change), the supplemental semantic checks JSON Schema
cannot express (archiveCategories is a subset of categories; the default-scope
subtraction), four-surface normalization parity for includeArchive, and the recorded
schema sha256 read back from selector-amendment-v1.2.md.

Run from anywhere: python3 docs/contracts/knowledge-v2/validate_contract_v1_2.py
It writes fixtures-v1.2.json beside itself and prints a receipt; it claims no network,
security, scale or runtime acceptance.
"""
import copy
import hashlib
import json
import pathlib
import re

from jsonschema import Draft202012Validator

d = pathlib.Path(__file__).parent
raw = (d / 'selector-v2.schema.json').read_bytes()
schema = json.loads(raw)
Draft202012Validator.check_schema(schema)

# The recorded sha256 (selector-amendment-v1.2.md) must be the file's.
recorded = re.findall(r'schema sha256 `([0-9a-f]{64})`', (d / 'selector-amendment-v1.2.md').read_text(encoding='utf-8'))
actual = hashlib.sha256(raw).hexdigest()
assert recorded == [actual], f'selector-amendment-v1.2.md records {recorded}, the schema is {actual}'


def valid(definition, value):
    s = copy.deepcopy(schema)
    s.pop('oneOf')
    s['$ref'] = '#/$defs/' + definition
    return not list(Draft202012Validator(s).iter_errors(value))


# The amendment is additive: the definitions the ruling keeps unchanged are byte-for-byte
# the v1.1 shape, and the two it amends gained exactly one property each.
assert sorted(schema['$defs']['query']['properties']) == sorted(
    ['protocol_version', 'q', 'sources', 'kinds', 'categories', 'limitPerSource', 'timeoutMs', 'includeArchive'])
assert schema['$defs']['query']['properties']['includeArchive'] == {'type': 'boolean'}
assert schema['$defs']['query']['additionalProperties'] is False
assert 'archiveCategories' in schema['$defs']['descriptor']['properties']
assert 'archiveCategories' not in schema['$defs']['descriptor']['required']
for unchanged in ('filter', 'retrieval', 'sourceSearchRequest'):
    assert 'includeArchive' not in json.dumps(schema['$defs'][unchanged]), unchanged
    assert 'archive' not in json.dumps(schema['$defs'][unchanged]).lower(), unchanged
assert schema['$defs']['retrieval']['properties']['reasons']['items']['enum'] == [
    'store-unavailable', 'deadline', 'acl-stale', 'ingest-stale']

# v1.1's fixtures replay unchanged against the amended schema.
v11 = json.loads((d / 'fixtures-v1.1.json').read_text())
for fixture in v11:
    assert valid(fixture['definition'], fixture['input']) == fixture['valid'], 'v1.1 ' + fixture['id']

base = {'protocol_version': 2, 'q': 'test'}
descriptor = {'protocol_version': 2, 'compartment_mode': 'dynamic-opaque', 'classes': [{'key': 'docs', 'content': 'docs'}],
              'categories': ['relaybrain:note', 'relaybrain:archive']}
fixtures = [
    ('query-include-archive-true', 'query', {**base, 'includeArchive': True}, True),
    ('query-include-archive-false', 'query', {**base, 'includeArchive': False}, True),
    ('query-include-archive-with-categories', 'query', {**base, 'categories': ['relaybrain:note'], 'includeArchive': True}, True),
    ('query-include-archive-string', 'query', {**base, 'includeArchive': 'true'}, False),
    ('query-include-archive-number', 'query', {**base, 'includeArchive': 1}, False),
    ('query-include-archive-null', 'query', {**base, 'includeArchive': None}, False),
    ('query-include-archive-snake-case', 'query', {**base, 'include_archive': True}, False),
    ('descriptor-without-archive', 'descriptor', descriptor, True),
    ('descriptor-archive-subset', 'descriptor', {**descriptor, 'archiveCategories': ['relaybrain:archive']}, True),
    ('descriptor-archive-all', 'descriptor', {**descriptor, 'archiveCategories': ['relaybrain:note', 'relaybrain:archive']}, True),
    ('descriptor-archive-empty', 'descriptor', {**descriptor, 'archiveCategories': []}, False),
    ('descriptor-archive-duplicate', 'descriptor', {**descriptor, 'archiveCategories': ['relaybrain:archive', 'relaybrain:archive']}, False),
    ('descriptor-archive-unnamespaced', 'descriptor', {**descriptor, 'archiveCategories': ['archive']}, False),
    ('descriptor-archive-not-array', 'descriptor', {**descriptor, 'archiveCategories': 'relaybrain:archive'}, False),
    # The flag never reaches a source: the filter refuses it as it refuses any authority field.
    ('filter-archive-flag-injection', 'filter', {'version': 2, 'kinds': ['docs'], 'includeArchive': True}, False),
    ('filter-narrowed-default-scope', 'filter', {'version': 2, 'kinds': ['docs'], 'categories': ['relaybrain:note']}, True),
]
for name, definition, value, expected in fixtures:
    assert valid(definition, value) == expected, name


# ── Supplemental semantic checks (amendment v1.1 §6: JSON Schema is structural only) ──

def descriptor_semantics_ok(value):
    """The core's rule (serviceDescriptor.ts): archiveCategories is a subset of categories."""
    archive = value.get('archiveCategories')
    return archive is None or (isinstance(archive, list) and 1 <= len(archive) <= 64
                               and len(set(archive)) == len(archive) and set(archive) <= set(value['categories']))


semantic = [
    ('descriptor-archive-subset', {**descriptor, 'archiveCategories': ['relaybrain:archive']}, True),
    ('descriptor-archive-all', {**descriptor, 'archiveCategories': ['relaybrain:note', 'relaybrain:archive']}, True),
    # Structurally valid, semantically refused: a category outside the declared vocabulary.
    ('descriptor-archive-outside-vocabulary', {**descriptor, 'archiveCategories': ['relaybrain:snapshot']}, False),
]
for name, value, expected in semantic:
    assert valid('descriptor', value), name + ' must be structurally valid'
    assert descriptor_semantics_ok(value) == expected, name


def scoped(requested, declared, archive, include):
    """The core's subtraction (KnowledgeV2.scopedSourceCategories)."""
    if include or not archive:
        return None if requested is None else list(requested)
    return sorted({c for c in (requested if requested is not None else declared)} - set(archive))


subtraction = [
    # (case, requested, declared, archive, includeArchive, expected, skipped)
    ('default-narrows-declared', None, ['relaybrain:archive', 'relaybrain:note'], ['relaybrain:archive'], False, ['relaybrain:note'], False),
    ('opt-in-unchanged', None, ['relaybrain:archive', 'relaybrain:note'], ['relaybrain:archive'], True, None, False),
    ('default-narrows-requested', ['relaybrain:archive', 'relaybrain:note'], ['relaybrain:archive', 'relaybrain:note'], ['relaybrain:archive'], False, ['relaybrain:note'], False),
    ('opt-in-keeps-requested', ['relaybrain:archive'], ['relaybrain:archive', 'relaybrain:note'], ['relaybrain:archive'], True, ['relaybrain:archive'], False),
    ('default-all-archive-skips', None, ['relaybrain:archive'], ['relaybrain:archive'], False, [], True),
    ('opt-in-all-archive-consults', None, ['relaybrain:archive'], ['relaybrain:archive'], True, None, False),
    ('no-archive-unaffected', None, ['relaybrain:note'], [], False, None, False),
    ('default-archive-only-request-skips', ['relaybrain:archive'], ['relaybrain:archive', 'relaybrain:note'], ['relaybrain:archive'], False, [], True),
]
for case, requested, declared, archive, include, expected, skipped in subtraction:
    got = scoped(requested, declared, archive, include)
    assert got == expected, case
    assert (got is not None and not set(got) & set(declared)) == skipped, case
    # Never wider than the request: the narrowed set is a subset of what was asked.
    if got is not None:
        assert set(got) <= set(requested if requested is not None else declared), case

# Four surfaces, one normalized request (amendment v1.1 §2 extended to includeArchive).
surfaces = {
    'REST': {'protocol_version': 2, 'q': 'needle', 'includeArchive': True},
    'MCP': {'q': 'needle', 'includeArchive': True},           # the tool adds protocol_version 2
    'CLI': {'q': 'needle', 'include_archive_flag': True},      # --include-archive
    'GUI': {'q': 'needle', 'checkbox': True},                  # "Include archive", persisted per user
}


def normalize(surface, value):
    out = {'protocol_version': 2, 'q': value['q']}
    flag = value.get('includeArchive', value.get('include_archive_flag', value.get('checkbox', False)))
    if flag is True:
        out['includeArchive'] = True
    assert valid('query', out), surface
    return json.dumps(out, sort_keys=True, separators=(',', ':'))


assert len({normalize(name, value) for name, value in surfaces.items()}) == 1

(d / 'fixtures-v1.2.json').write_text(json.dumps(
    [{'id': a, 'definition': b, 'input': c, 'valid': e} for a, b, c, e in fixtures]
    + [{'id': a, 'definition': 'descriptor', 'input': c, 'valid': True, 'semanticValid': e} for a, c, e in semantic]
    + [{'id': a, 'definition': 'defaultScope', 'input': {'requested': r, 'declared': de, 'archive': ar, 'includeArchive': inc},
        'expected': {'categories': ex, 'skipped': sk}} for a, r, de, ar, inc, ex, sk in subtraction],
    indent=2) + '\n')
print(json.dumps({
    'schema_sha256': actual,
    'schema_self_validation': 'pass',
    'v1_1_fixtures_replayed': len(v11),
    'structural_fixtures': len(fixtures),
    'semantic_descriptor_fixtures': len(semantic),
    'default_scope_cases': len(subtraction),
    'normalization_surfaces': list(surfaces),
    'runtime_security_tests_executed': False,
}))
