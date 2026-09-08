/**
 * SS-W2 · §4.5(a) — the census lock, the expected relation, and the claim
 * parser's verdicts.
 *
 * These are the legs of the conformance gate that need no database, so they run
 * in ordinary CI on every commit. The behavioural half — fixtures traversing
 * the shared relying-party entry point with their path stamps — needs a real
 * migrated PostgreSQL and lives in `backend/scripts/w2-conformance-gate.js`.
 *
 * The split is deliberate: an edit to the census must fail FAST and everywhere,
 * not only when someone remembers to run the live gate.
 */
import crypto from 'crypto';
import {
  CENSUS_DIGEST,
  EXPECTED_RELATION,
  SHAPE_CLASS_IDS,
  TRANSCRIBED_SHAPE_CLASSES,
  TRANSCRIBED_SUPPORT_CLAIM,
  computeCensusDigest,
  requiredClassIds,
} from './conformance/census';
import { FIXTURES, fixtureClassIds, fixtureTargets } from './conformance/fixtures';
import { readGroupClaim, groupClaimIsUsableAsSnapshot } from '../services/identity/ssoGroupClaims';

describe('§4.5(a) — the digest-locked census', () => {
  it('the transcription matches its recorded digest, or the gate refuses to run', () => {
    // Editing the census without editing the ratified source it transcribes
    // fails HERE. Editing both is a governing-document change and therefore a
    // review event — which is the property, not a loophole.
    expect(computeCensusDigest()).toBe(CENSUS_DIGEST);
  });

  it('NON-VACUITY: the lock really discriminates — a one-character edit changes the digest', () => {
    const mutated = crypto
      .createHash('sha256')
      .update(`${TRANSCRIBED_SUPPORT_CLAIM}.\n---\n${TRANSCRIBED_SHAPE_CLASSES}`, 'utf8')
      .digest('hex');
    expect(mutated).not.toBe(CENSUS_DIGEST);
  });

  it('transcribes the AMENDED support claim (S-A8), not the withdrawn five-target list', () => {
    // SSO-R18 narrowed the claim; the census narrows with it. If this ever
    // reverts to naming five targets as the live claim, the gate would be
    // binding evidence to a claim the owner has withdrawn.
    expect(TRANSCRIBED_SUPPORT_CLAIM).toContain('RelayHall supports one official standard: OIDC');
    expect(TRANSCRIBED_SUPPORT_CLAIM).toContain('The tested reference is authentik');
    expect(TRANSCRIBED_SUPPORT_CLAIM).toContain('is REPLACED by');
  });

  it('transcribes all eight shape classes', () => {
    for (const id of SHAPE_CLASS_IDS) {
      expect(TRANSCRIBED_SHAPE_CLASSES).toContain(`| ${id} |`);
    }
  });
});

describe('§4.5(a) — the expected relation', () => {
  it('names at least one target, and every target requires at least one class', () => {
    expect(EXPECTED_RELATION.length).toBeGreaterThan(0);
    for (const row of EXPECTED_RELATION) {
      expect(row.target).not.toBe('');
      expect(row.requiredClasses.length).toBeGreaterThan(0);
    }
  });

  it('requires every one of the eight shape classes somewhere', () => {
    // A class required by no target would be a class the gate never has to
    // find — the "remove a shape class" mutation exists because that is how
    // coverage is lost silently.
    expect(requiredClassIds()).toEqual([...SHAPE_CLASS_IDS]);
  });

  it('names the tested reference the amended claim names', () => {
    expect(EXPECTED_RELATION.map((row) => row.target)).toContain('authentik');
    expect(EXPECTED_RELATION.map((row) => row.target)).toContain('standard-oidc');
  });

  it('the fixture table covers every required class and every named target', () => {
    // This is the "remove a target" / "remove a shape class" mutation's landing
    // point in the fast suite: delete a fixture row and the relation is no
    // longer satisfiable, NAMED.
    const missingClasses = requiredClassIds().filter((id) => !fixtureClassIds().includes(id));
    expect(missingClasses).toEqual([]);
    const missingTargets = EXPECTED_RELATION.map((row) => row.target).filter(
      (target) => !fixtureTargets().includes(target),
    );
    expect(missingTargets).toEqual([]);
  });

  it('every fixture claims at least one census target, and no fixture claims an unknown one', () => {
    const known = new Set(EXPECTED_RELATION.map((row) => row.target));
    for (const fixture of FIXTURES) {
      expect(fixture.targets.length).toBeGreaterThan(0);
      for (const target of fixture.targets) expect(known.has(target)).toBe(true);
    }
  });
});

describe('§4.5(a) — the claim parser is the boundary classes 2, 4 and 5 observe', () => {
  // Round-6 F2: classes written to observe a BOARD SETTING rather than what the
  // provider does are vacuous. These read the parser's verdict about the
  // token — the production boundary where the code meets the provider's data —
  // and the parser never consults `group_binding_mode`.

  it('class 2: the configured dotted path yields the expected non-empty opaque value', () => {
    const token = { realm_access: { roles: ['/engineering/platform'] } };
    const reading = readGroupClaim(token, 'realm_access.roles');
    expect(reading.verdict).toBe('claim_present');
    expect(reading.values).toEqual(['/engineering/platform']);
  });

  it('class 2 CONTROL: the same bytes addressed as a FLAT claim yield no value', () => {
    // Both-resolve-nothing cannot pass: the positive above really did resolve.
    const token = { realm_access: { roles: ['/engineering/platform'] } };
    expect(readGroupClaim(token, 'roles').verdict).toBe('claim_absent');
    expect(readGroupClaim(token, 'roles').values).toEqual([]);
  });

  it('class 4: the parser reports claim_absent for a token carrying no groups claim', () => {
    expect(readGroupClaim({ sub: 'abc' }, 'groups').verdict).toBe('claim_absent');
  });

  it('class 4 CONTROL: a token that DOES carry a groups claim reports claim_present', () => {
    // The characteristic is the PROVIDER's, so this must change the verdict
    // even though no board setting moved.
    expect(readGroupClaim({ sub: 'abc', groups: ['g1'] }, 'groups').verdict).toBe('claim_present');
  });

  it('class 5: an overage indicator reports overage, distinguishable from claim_absent', () => {
    const token = { sub: 'abc', _claim_names: { groups: 'src1' } };
    expect(readGroupClaim(token, 'groups').verdict).toBe('overage');
  });

  it('class 5 CONTROL: a well-formed claim reports claim_present, and an ordinary absent claim reports claim_absent', () => {
    // Hollowing the overage fixture into an absent one must turn the reason
    // assertion red — these two controls are what make that true.
    expect(readGroupClaim({ sub: 'abc', groups: ['g1'] }, 'groups').verdict).toBe('claim_present');
    expect(readGroupClaim({ sub: 'abc' }, 'groups').verdict).toBe('claim_absent');
  });

  it('SS-13: absent, unparseable and overage all fail closed as snapshot inputs, while staying distinguishable', () => {
    const overage = readGroupClaim({ _claim_names: { groups: 's' } }, 'groups');
    const absent = readGroupClaim({}, 'groups');
    const unparseable = readGroupClaim({ groups: 42 }, 'groups');
    const present = readGroupClaim({ groups: ['g'] }, 'groups');
    for (const reading of [overage, absent, unparseable]) {
      expect(groupClaimIsUsableAsSnapshot(reading)).toBe(false);
    }
    expect(groupClaimIsUsableAsSnapshot(present)).toBe(true);
    // Distinguishable: three different verdicts, one behaviour.
    expect(new Set([overage.verdict, absent.verdict, unparseable.verdict]).size).toBe(3);
  });

  it('a group value is opaque: nothing is split, trimmed or case-folded on the way through', () => {
    const values = ['4f2a9c1e-77b2-4a3d-9f10-6c5b8e2d1a44', '/engineering/platform', 'Platform Engineers'];
    expect(readGroupClaim({ groups: values }, 'groups').values).toEqual(values);
  });
});
