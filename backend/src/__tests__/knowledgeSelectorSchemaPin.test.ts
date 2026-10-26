/**
 * The selector-v2 contract, pinned BY VALUE (card 40e0e542, selector amendment
 * v1.2; owner ruling E127 (5)).
 *
 * `docs/contracts/knowledge-v2/selector-v2.schema.json` is ONE contract with
 * two readers: the core validates its requests by hand (KnowledgeV2.ts), and a
 * source validates against a byte-identical copy of this file with a JSON
 * Schema validator. Nothing pinned the file before this amendment, so the two
 * copies could drift with no test noticing. The sha256 below is a constant
 * this suite does not compute from the file: it is the value recorded in
 * selector-amendment-v1.2.md, and a source keeps the same value in its own
 * parity test. Editing the schema without moving this pin turns the first test
 * red; moving the pin is a contract amendment, in the same change, with the
 * source's copy moving beside it.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { V2_QUERY_KEYS, RETRIEVAL_REASONS, DEADLINE_FIRED } from '../services/KnowledgeV2';

const SCHEMA = path.join(__dirname, '..', '..', '..', 'docs', 'contracts', 'knowledge-v2', 'selector-v2.schema.json');
const AMENDMENT = path.join(__dirname, '..', '..', '..', 'docs', 'contracts', 'knowledge-v2', 'selector-amendment-v1.3.md');

// MOVED with card 40e0e542 (selector amendment v1.2: $defs.query.includeArchive
// and $defs.descriptor.archiveCategories), then with card 3e0ae06e (amendment
// v1.3: $defs.sourceSearchRequest.budget_ms and
// $defs.sourceSearchResponse.deadline_fired). The v1.2 file was
// e557d432be1a6764f8ff95665f8d96929f9ca71bf57da19360a7091226acf99f; the v1.1 file was
// f13bbfb97ba6fb3bd5403e42af4c11aaad554fe1b93ebe7cd7ad1e4614003650.
const SELECTOR_V2_SCHEMA_SHA256 = '53d03a7fadf3a2bb7992a3f633881bac93dc40f5c7409349731805d342fe8f43';

const raw = fs.readFileSync(SCHEMA);
const schema = JSON.parse(raw.toString('utf8')) as { $defs: Record<string, { properties?: Record<string, unknown>; additionalProperties?: boolean }> };

describe('selector-v2 schema pin (card 40e0e542)', () => {
  it('the selector-v2 schema file is the pinned bytes (MOVES with card 40e0e542)', () => {
    expect(crypto.createHash('sha256').update(raw).digest('hex')).toBe(SELECTOR_V2_SCHEMA_SHA256);
  });

  it('the amendment records the same sha256 the core pins', () => {
    expect(fs.readFileSync(AMENDMENT, 'utf8').match(/schema sha256 `([0-9a-f]{64})`/g)).toEqual([`schema sha256 \`${SELECTOR_V2_SCHEMA_SHA256}\``]);
  });

  it("the core's request allowlist is exactly the schema's query properties, and the query stays closed", () => {
    expect(Object.keys(schema.$defs.query.properties ?? {}).sort()).toEqual([...V2_QUERY_KEYS].sort());
    expect(schema.$defs.query.additionalProperties).toBe(false);
    expect(schema.$defs.query.properties?.includeArchive).toEqual({ type: 'boolean' });
  });

  it('the descriptor declares archiveCategories; the source wire adds only budget_ms and deadline_fired (card 3e0ae06e); the filter and the retrieval reasons are unchanged', () => {
    expect(Object.keys(schema.$defs.descriptor.properties ?? {})).toContain('archiveCategories');
    expect(Object.keys(schema.$defs.sourceSearchRequest.properties ?? {}).sort()).toEqual(['assertion', 'budget_ms', 'filter', 'limit', 'protocol_version', 'q']);
    expect(schema.$defs.sourceSearchRequest.properties?.budget_ms).toEqual({ type: 'integer', minimum: 1, maximum: 8000 });
    expect(Object.keys(schema.$defs.sourceSearchResponse.properties ?? {}).sort()).toEqual(['deadline_fired', 'protocol_version', 'results', 'retrieval', 'truncated']);
    expect(schema.$defs.sourceSearchResponse.properties?.deadline_fired).toEqual({ enum: [...DEADLINE_FIRED] });
    // Both releases may ship in either order only because both shapes stay OPEN: a source built on the
    // v1.2 shape accepts budget_ms as an unknown property, and a v1.2 core ignores deadline_fired.
    expect(schema.$defs.sourceSearchRequest.additionalProperties).toBeUndefined();
    expect(schema.$defs.sourceSearchResponse.additionalProperties).toBeUndefined();
    expect(Object.keys(schema.$defs.filter.properties ?? {}).sort()).toEqual(['categories', 'kinds', 'version']);
    expect(schema.$defs.filter.additionalProperties).toBe(false);
    const reasons = ((schema.$defs.retrieval.properties?.reasons as { items: { enum: string[] } }).items.enum);
    expect(reasons).toEqual([...RETRIEVAL_REASONS]);
  });
});
