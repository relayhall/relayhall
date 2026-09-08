/**
 * RH-LENSES-a (card `74e02a05`) — THE RED MUTATIONS, and the control each one
 * is the red proof for.
 *
 * ── WHY THIS TABLE IS THE BUILD'S AND NOT THE DESIGN RECORD'S ────────────
 *
 * Design v5 and v6 each printed, per control, a list of named red mutations.
 * Round 4 found a defect in round 3's inventory; round 5 found one in the
 * repair written for round 4; **round 6 found two mutations that could not
 * redden anything at all**, both in controls written for round 5's repair.
 * Three consecutive rounds finding a defect in the artefact written for the
 * previous one is the regress `controls-need-their-own-controls` names.
 *
 * The dispatcher's ruling terminated the class: **whether a mutation reddens
 * is a RUNTIME property**, so the record states only the property each control
 * protects and obligation `B-L10a` moves the enumeration here, where it can be
 * *measured*:
 *
 *   > every control ships with at least one RED MUTATION, written by the build
 *   > and PROVEN AT BUILD TIME to redden that control while every other
 *   > control in the drill stays green. A mutation that reddens nothing is a
 *   > build failure, and mutation independence is a drill step.
 *
 * ── THE THREE RULES EVERY ROW BELOW OBEYS ────────────────────────────────
 *
 *  1 **It compiles.** A mutation that does not compile proves nothing: the
 *    runner classifies a compile-broken suite as INVALID, never RED, because
 *    nothing about the controls was measured.
 *  2 **`expects` is the COMPLETE red set, not a sample.** The runner enforces
 *    it in both directions — an expectation no red satisfies fails the drill,
 *    and a red no expectation names fails it too. A mutation that reddens five
 *    assertions and names one is how a control looks measured when it is not.
 *  3 **The red set lies inside ONE control.** That is the independence claim,
 *    and it is why each row names the control it belongs to: a mutation whose
 *    reds spill across two controls proves neither of them fails on its own.
 */
import type { Mutation } from './mutationDrill';

const SEAM = 'src/services/DirectoryCarriageService.ts';
const CATALOG_ROUTES = 'src/routes/directoryGroupReferences.ts';

/**
 * The suites the drill runs. Both planes are here on purpose: three of these
 * controls are properties of SOURCE and three are properties of ROWS UNDER
 * LOCKS, and a drill that ran only one plane would call a mutation green
 * because the half that could see it never ran.
 */
export const LENSES_A_DRILL_SUITES = [
  'src/__tests__/directoryCarriageSeamCensus.test.ts',
  'src/__tests__/directoryCarriageLockOrder.test.ts',
  'src/__tests__/scimGroupsRung.test.ts',
  'src/__tests__/directoryCarriageLive.test.ts',
];

export interface LensesAMutation extends Mutation {
  /** The control this mutation is the red proof for. */
  control: 'R-1' | 'R-2' | 'R-3' | 'R-4' | 'R-10' | 'R-12' | 'SF-1' | 'SF-2' | 'SF-3' | 'BOOT-A';
}

export const LENSES_A_MUTATIONS: LensesAMutation[] = [
{
  "id": "L14",
  "control": "BOOT-A",
  "reintroduces": "the new root-gated catalogue act is missing from the boot census register",
  "file": "src/services/AccessSurfaceService.ts",
  "find": "  {\n    family: 'POST /directory-group-references/:id/use',\n    reason: 'LENSES v7.1 96f0bd3d and ruling 60307311: using a reference creates and binds a Group as an owner-plane root-session act; steward administration waits for LENSES-c and the rule-4 arm.',\n  },\n",
  "replace": "",
  "expects": [
    "BOOT-A: the production Access-surface census accepts every mounted root family"
  ]
},
  {
    id: 'L1',
    control: 'R-1',
    reintroduces:
      'derived membership is PATCHED rather than recomputed: a SCIM push recomputes only the '
      + 'members it added, so a member the push REMOVED keeps the membership its carriage no '
      + 'longer justifies',
    file: SEAM,
    // The affected set is (old carriers UNION new carriers). Narrowing it to
    // the new ones still compiles, still passes every happy path, and breaks
    // I-L1 in the one direction a happy-path test cannot see: a row that
    // should have GONE.
    find: '      for (const accountPrincipalId of [...affected].sort()) {\n'
      + '        await this.recomputeDerivedMembership(client, ledger, accountPrincipalId, true, actor);\n'
      + '      }',
    replace: '      for (const accountPrincipalId of [...wanted].sort()) {\n'
      + '        await this.recomputeDerivedMembership(client, ledger, accountPrincipalId, true, actor);\n'
      + '      }',
    // Fixtures are retired after each assertion, so only the assertion
    // that observes this removal can redden.
    expects: ['the admitted PATCH paths reach the seam and recompute membership'],
  },
  {
    id: 'L2',
    control: 'R-2',
    reintroduces:
      'the ref stops being opaque: the validator TRIMS it, so two values the Identity provider '
      + 'sent as different bytes become one reference and bind as one group',
    file: SEAM,
    // The smallest normalisation anybody ever adds, and the one that looks
    // most harmless. SS-12's whole point is that the code does not know what
    // it is looking at.
    find: '  return value;\n}\n\nfunction validateOptionalText(',
    replace: '  return value.trim();\n}\n\nfunction validateOptionalText(',
    expects: ['refs differing by case, whitespace, a trailing slash or NFC/NFD are DISTINCT'],
  },
  {
    id: 'L3',
    control: 'R-3',
    reintroduces:
      'a SECOND writer of group_members: the provider-removal path deletes the rows itself '
      + 'instead of recomputing through the one seam, which is prohibition 1 undone',
    file: SEAM,
    // It reaches the SAME end state -- every directory membership for the
    // provider's bound Groups is gone -- so the live acceptance row stays
    // green. That is exactly why the census is a separate control: a second
    // writer that happens to agree today is still a second writer.
    find: '    for (const accountPrincipalId of [...accounts].sort()) {\n'
      + '      await this.recomputeDerivedMembership(client, ledger, accountPrincipalId, false, actor);\n'
      + '    }\n'
      + '    return outcome;',
    // Two ordinary quoted strings, not a template literal: the first attempt
    // spliced a multi-line backtick string in and the suite FAILED TO RUN.
    // The runner called that INVALID rather than RED, and it was right to --
    // a mutation that does not compile proves nothing about any control.
    replace: '    await client.query(\n'
      + "      'DELETE FROM group_members gm USING groups g WHERE gm.group_id = g.id'\n"
      + '      + " AND gm.source = \'directory\' AND gm.account_principal_id = ANY($1::uuid[])",\n'
      + '      [accounts],\n'
      + '    );\n'
      // `void actor;` because the mutation leaves the parameter unread and the
      // build then fails TS6133 -- and a mutation that does not compile is
      // classified INVALID, never RED. It is also the shape a real editor leaves
      // behind when they replace a call and keep the signature.
      + '    void actor;\n'
      + '    return outcome;',
    expects: ['B-L2: the only WRITER is GroupService, and the seam itself writes none',
      'R-3: every discovered write has an exact value-scoped exemption'],
  },
  {
    id: 'L4',
    control: 'R-4',
    reintroduces:
      'THE DISCOVERY PHANTOM: the binding act records the reference lock as held without taking '
      + 'it, so it enumerates carriers without the lock that makes the enumeration complete and '
      + 'commits a binding with no derived membership',
    file: SEAM,
    // The ledger is satisfied and every guard downstream passes, so nothing
    // throws and no happy path changes. The ONLY observable difference is that
    // the bind no longer waits -- which is precisely what schedule S1 measures
    // with a real barrier, and what a repetition count could not.
    // The anchor runs to the refusal CODE, because the housekeeping delete
    // opens with the identical three statements and an anchor that stopped at
    // the SELECT matched both -- which the runner classified INVALID rather
    // than guessing, and it was right to.
    find: '      await takeReferenceLocks(client, ledger, [reference.externalGroupRef]);\n'
      + '\n'
      + '      const bound = await client.query(\n'
      + "        'SELECT id, name FROM groups WHERE identity_provider_id = $1 AND external_group_ref = $2',\n"
      + '        [identityProviderId, reference.externalGroupRef],\n'
      + '      );\n'
      + '      if (bound.rows.length > 0) {\n'
      + '        throw err(\n'
      + '          409,\n'
      + "          'DIRECTORY_GROUP_REFERENCE_ALREADY_BOUND',",
    replace: '      ledger.references.push(reference.externalGroupRef);\n'
      + '\n'
      + '      const bound = await client.query(\n'
      + "        'SELECT id, name FROM groups WHERE identity_provider_id = $1 AND external_group_ref = $2',\n"
      + '        [identityProviderId, reference.externalGroupRef],\n'
      + '      );\n'
      + '      if (bound.rows.length > 0) {\n'
      + '        throw err(\n'
      + '          409,\n'
      + "          'DIRECTORY_GROUP_REFERENCE_ALREADY_BOUND',",
    // THE COMPLETE SET, measured. Three assertions, all R-4's: the barrier
    // schedule that catches the phantom at RUNTIME, and the two source-order
    // assertions that catch the missing lock STATICALLY. Both planes seeing
    // it is the property B-L15 asks for -- the source census and the runtime
    // order fail independently, and here they fail together because the
    // mutation removes the thing both are about.
    expects: [
      'S1: the DISCOVERY PHANTOM is closed',
      'bindReferenceToGroup takes its reference locks before it discovers any carrier',
      'takes provider -> reference -> carriers, and moves NO watermark',
    ],
  },
  {
    id: 'L7', control: 'R-3',
    reintroduces: 'the generic member route accepts a caller-supplied directory source',
    file: 'src/services/GroupService.ts',
    find: "    if (source !== 'local') {",
    replace: "    if (source !== 'local' && source !== 'directory') {",
    expects: ['B1: binding and directory membership refusals preserve point-route sets for two principals'],
  },
  {
    id: 'L8', control: 'R-3',
    reintroduces: 'generic membership deletion reaches a directory-derived row',
    file: 'src/services/GroupService.ts',
    find: "AND source = 'local' RETURNING source",
    replace: 'RETURNING source',
    expects: ['B1: binding and directory membership refusals preserve point-route sets for two principals',
      'R-3: every discovered write has an exact value-scoped exemption'],
  },
  {
    id: 'L9', control: 'R-3',
    reintroduces: 'a caller-provided database connection is accepted without a carriage permit',
    file: SEAM,
    find: '  const permit = client && membershipPermits.get(client);',
    replace: '  const permit = client && { provider, account, groups, observation };',
    expects: ['A-L33 / B-L13: the admitted sink shares its transaction and refuses standalone snapshots'],
  },
  {
    id: 'L10', control: 'SF-1',
    reintroduces: 'an explicit catalog Group name bypasses the shared Group name bound',
    file: SEAM,
    find: '      return throughGroupValidator(() => validateGroupName(name));',
    replace: '      return String(name);',
    expects: ['SF-1: a DIRECTORY-CONTROLLED display name cannot cross the board name bound'],
  },
  {
    id: 'L11', control: 'SF-2',
    reintroduces: 'an externalId uniqueness refusal escapes as an internal error',
    file: SEAM,
    find: "?.code === '23505'",
    replace: "?.code === 'not-a-pg-code'",
    expects: ['SF-2: a repeated externalId is 409 uniqueness on the wire, not a 500'],
  },
  {
    id: 'L12', control: 'SF-3',
    reintroduces: 'an oversized group reference escapes without SCIM error translation',
    file: 'src/services/identity/ScimGroupProvisioning.ts',
    find: '      throw asScimError(error);',
    replace: '      throw error;',
    expects: ['SF-3: a seam refusal reaches a SCIM client as a SCIM error, not a 500'],
  },
{
  "id": "L13",
  "control": "R-3",
  "reintroduces": "the generic Group PATCH again forwards directory binding values directly to its SQL update",
  "file": "src/services/GroupService.ts",
  "find": "    if ('identityProviderId' in input || 'externalGroupRef' in input) {\n      throw err(409, 'DIRECTORY_BINDING_MANAGED',\n        'Directory bindings are managed through the directory group reference catalog.');\n    }\n",
  "replace": "    const bindingTouched = input.identityProviderId !== undefined || input.externalGroupRef !== undefined;\n    if (bindingTouched) {\n      const providerId = input.identityProviderId ?? null;\n      const externalRef = input.externalGroupRef ?? null;\n      if ((providerId === null) !== (externalRef === null)) {\n        throw err(\n          422,\n          'INVALID_GROUP_BINDING',\n          'a directory binding is both identityProviderId and externalGroupRef, or neither: supply both to bind, or both null to unbind',\n        );\n      }\n      if (providerId !== null) {\n        if (typeof providerId !== 'string' || !UUID_PATTERN.test(providerId)) {\n          throw err(422, 'INVALID_GROUP_BINDING', 'identityProviderId must be a full UUID', 'identityProviderId');\n        }\n        // The ref is OPAQUE: not trimmed, not case-folded, not parsed. It is\n        // rejected only for being unusable as a key at all \u2014 an empty string\n        // would bind on every Identity provider that omits the claim value.\n        if (typeof externalRef !== 'string' || externalRef === '') {\n          throw err(422, 'INVALID_GROUP_BINDING', 'externalGroupRef must be a non-empty string', 'externalGroupRef');\n        }\n      }\n      params.push(providerId);\n      sets.push(`identity_provider_id = $${params.length}`);\n      params.push(externalRef);\n      sets.push(`external_group_ref = $${params.length}`);\n      changed.identityProviderId = providerId;\n      changed.externalGroupRef = externalRef;\n    }\n",
  "expects": [
    "B1: binding and directory membership refusals preserve point-route sets for two principals",
    "R-3: every discovered write has an exact value-scoped exemption"
  ]
},
  {
    id: 'L5',
    control: 'R-10',
    reintroduces:
      'the catalog point read stops applying the projection, so a reference OUTSIDE a caller'
      + "'s projection answers 200 while one that does not exist answers 404 -- an existence "
      + 'oracle over every external group name in the deployment',
    file: SEAM,
    find: '    if (!UUID_PATTERN.test(String(id))) return null;\n'
      + '    if (!scope.rootSession) return null;\n',
    replace: '    if (!UUID_PATTERN.test(String(id))) return null;\n'
      + '    if (!scope.rootSession && false) return null;\n',
    expects: ['A-L17 / R-10: outside the projection is BYTE-IDENTICAL to does-not-exist'],
  },
  {
    id: 'L6',
    control: 'R-12',
    reintroduces:
      'the watermark becomes a SIDE EFFECT: binding a stale retained reference refreshes the '
      + "provider's \"last successful snapshot\" although nothing was received, and AZ-30's "
      + 'staleness alarm goes quiet',
    file: SEAM,
    find: '      for (const accountPrincipalId of [...accounts].sort()) {\n'
      + '        await this.recomputeDerivedMembership(client, ledger, accountPrincipalId, false, actor);\n'
      + '      }\n'
      + '\n'
      + '      await auditService.record(\n'
      + '        {\n'
      + "          action: 'directory_group_reference.bind',",
    replace: '      for (const accountPrincipalId of [...accounts].sort()) {\n'
      + '        await this.recomputeDerivedMembership(client, ledger, accountPrincipalId, true, actor);\n'
      + '      }\n'
      + '\n'
      + '      await auditService.record(\n'
      + '        {\n'
      + "          action: 'directory_group_reference.bind',",
    expects: [
      'A-L46 / R-12: a bind moves NO watermark',
      // Declared: the lock-order suite watches for the watermark statement in
      // the bind's sequence, and it appears. Both assertions are R-12's.
      'takes provider -> reference -> carriers, and moves NO watermark',
    ],
  },
];

/** Every control `B-L10a` names for this card. The drill asserts that each one
 *  is claimed by at least one mutation, so a control cannot be shipped with no
 *  red proof by being left out of the table. */
export const LENSES_A_CONTROLS = ['R-1', 'R-2', 'R-3', 'R-4', 'R-10', 'R-12', 'SF-1', 'SF-2', 'SF-3', 'BOOT-A'] as const;

/** A route module the drill reads to prove the catalog file is still the one
 *  the mutations above assume. Kept as an export so a rename fails loudly. */
export const LENSES_A_CATALOG_ROUTES = CATALOG_ROUTES;
