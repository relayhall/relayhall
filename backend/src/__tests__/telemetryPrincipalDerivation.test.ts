/**
 * §4.1 / §5.1 PRINCIPAL DERIVATION — the four acceptance tests design
 * `7d5c0cdc` §4.1 names, plus the D3 descriptor enforcement that makes the
 * Tier-0 acceptance non-vacuous (RH-TW1a candidate B).
 *
 * The design names these four by name, "covering both ratified Agent chain
 * shapes", and all four are required:
 *
 *   (a) a forged payload `agent_id` on a Connector-authenticated write is
 *       stored as advisory only and never enters the principal block;
 *   (b) a Connector-observed Agent claim renders as observed-by-intermediary;
 *   (c) a Connector-descended Agent-credential write derives its
 *       `agent_id`/`connector_id`/`account_id` server-side with no payload
 *       involvement;
 *   (d) a direct `Account -> Agent` credential presenting `telemetry:write` is
 *       refused with the distinct error AND the refusal is audited.
 *
 * Connector-ness is decided by the RATIFIED registry predicate
 * (`connectorRegistry.ts`, owner ruling `4ae7ce53`), so the double below
 * answers that predicate's own SQL rather than a shape this suite invented. A
 * test that modelled Connector-ness itself would be testing its own model.
 */
import { TelemetryPrincipalService } from '../services/TelemetryPrincipalService';
import { connectorRegistryPredicateSql } from '../utils/connectorRegistry';
import type { DelegationActorLink } from '../services/AuthorizationService';

const ACCOUNT = '00000000-0000-4000-8000-00000000acc7';
const CONNECTOR = '00000000-0000-4000-8000-0000000c0nn3';
const AGENT = '00000000-0000-4000-8000-00000000a63n';
const OUTSIDER = '00000000-0000-4000-8000-000000000ff5';

interface Fixture {
  /** Principals the REGISTRY says are Connectors. */
  connectors?: string[];
  /** The current descriptor for the connector, or null for none declared. */
  descriptor?: { tier: string; products?: string[] } | null;
}

function makeService(fixture: Fixture) {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const connectors = new Set(fixture.connectors ?? []);
  const pool = {
    query: jest.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params: params ?? [] });
      // The ratified predicate's own statement, answered by principal id.
      if (text.includes(connectorRegistryPredicateSql('$1'))) {
        return { rows: [{ is_connector: connectors.has(String((params ?? [])[0])) }] };
      }
      if (text.includes('service_descriptor_versions')) {
        if (fixture.descriptor === undefined || fixture.descriptor === null) return { rows: [] };
        return { rows: [{ descriptor: { options: [], telemetry: fixture.descriptor }, version: 3 }] };
      }
      return { rows: [] };
    }),
  };
  return { service: new TelemetryPrincipalService(pool as never), queries, pool };
}

const link = (principalId: string, kind: string, parent: string | null): DelegationActorLink => ({
  principalId, kind, role: null, parentPrincipalId: parent,
  boundTaskId: null, legacyIdentity: false, ownExpression: null,
} as DelegationActorLink);

/** Account -> Connector, acting first. A Connector credential with a real Account. */
const CONNECTOR_WITH_ACCOUNT: DelegationActorLink[] = [
  link(CONNECTOR, 'service', ACCOUNT),
  link(ACCOUNT, 'human', null),
];

/** Account -> Connector -> Agent, acting first. */
const CONNECTOR_DESCENDED_AGENT: DelegationActorLink[] = [
  link(AGENT, 'agent', CONNECTOR),
  link(CONNECTOR, 'service', ACCOUNT),
  link(ACCOUNT, 'human', null),
];

/** Account -> Agent, acting first. AUTHZ's other legal shape. */
const DIRECT_ACCOUNT_AGENT: DelegationActorLink[] = [
  link(AGENT, 'agent', ACCOUNT),
  link(ACCOUNT, 'human', null),
];

const TIER0 = { tier: 'full', products: ['claude-code'] };

describe('§5.1 class 1 — a Connector credential', () => {
  it('derives connector and account, and NEVER an agent (acceptance (a) and (b))', async () => {
    // §4.1: "Connector- or outpost-authenticated writes never carry an
    // authoritative agent_id" — whatever the payload claims. This suite proves
    // the derivation; `telemetryEnvelopeStore.test.ts` proves the forged
    // payload value reaches storage only as an advisory pseudonym, which is
    // the other half of acceptance (a) and is what (b)'s
    // observed-by-intermediary rendering rests on.
    const { service } = makeService({ connectors: [CONNECTOR], descriptor: TIER0 });
    const result = await service.derive({
      actingPrincipalId: CONNECTOR,
      delegationLinks: CONNECTOR_WITH_ACCOUNT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principalClass).toBe('connector');
    expect(result.binding).toMatchObject({ connectorId: CONNECTOR, accountId: ACCOUNT, agentId: null, policyTier: 0 });
  });

  it('REFUSES a Connector with no Account chain — the migration-097 legacy shape (F1)', async () => {
    // Migration 097 backfills pre-096 Connectors as PARENTLESS principals
    // marked legacy_identity, "frozen out of the new machinery" until the owner
    // re-parents them; auth's §10 legacy arm never calls resolveChain, so they
    // arrive here with no chain. This used to be accepted with
    // accountId = connectorId — an Account that does not exist.
    const { service } = makeService({ connectors: [CONNECTOR], descriptor: TIER0 });
    const result = await service.derive({ actingPrincipalId: CONNECTOR, delegationLinks: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TELEMETRY_PRINCIPAL_NO_ACCOUNT');
    expect(result.audit).toMatchObject({ connectorId: CONNECTOR, chainDepth: 0 });
  });

  it('REFUSES a Connector whose chain terminates at itself', async () => {
    // The same hole by a different route: a one-link chain makes the Connector
    // its own Account link.
    const { service } = makeService({ connectors: [CONNECTOR], descriptor: TIER0 });
    const result = await service.derive({
      actingPrincipalId: CONNECTOR,
      delegationLinks: [link(CONNECTOR, 'service', null)],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TELEMETRY_PRINCIPAL_NO_ACCOUNT');
  });

  it('… and the control: the SAME Connector with a real Account chain is accepted', async () => {
    // Without this, the two refusals above could be passing because the fixture
    // refuses everything.
    const { service } = makeService({ connectors: [CONNECTOR], descriptor: TIER0 });
    const result = await service.derive({
      actingPrincipalId: CONNECTOR,
      delegationLinks: [link(CONNECTOR, 'service', ACCOUNT), link(ACCOUNT, 'human', null)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding).toMatchObject({ connectorId: CONNECTOR, accountId: ACCOUNT });
  });
});

describe('§5.1 class 2 — a Connector-descended Agent credential', () => {
  it('derives agent, connector and account together, server-side (acceptance (c))', async () => {
    const { service, queries } = makeService({ connectors: [CONNECTOR], descriptor: TIER0 });
    const result = await service.derive({
      actingPrincipalId: AGENT,
      delegationLinks: CONNECTOR_DESCENDED_AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principalClass).toBe('connector_descended_agent');
    expect(result.binding).toMatchObject({
      agentId: AGENT, connectorId: CONNECTOR, accountId: ACCOUNT, policyTier: 0,
    });
    // "with no payload involvement": the service is never handed an envelope,
    // and every identifier it asked the database about came from the chain.
    const asked = queries.flatMap((q) => q.params.map(String));
    expect(asked.every((value) => [AGENT, CONNECTOR, ACCOUNT].includes(value) || !value.includes('-'))).toBe(true);
  });

  it('attributes to the NEAREST Connector ancestor, not the furthest', async () => {
    // A broad parent Connector must not claim events belonging to a narrower
    // child. Nothing in the design says "nearest" in those words; it follows
    // from `connector_id` meaning the OWNING connector.
    const outerConnector = OUTSIDER;
    const { service } = makeService({ connectors: [CONNECTOR, outerConnector], descriptor: TIER0 });
    const result = await service.derive({
      actingPrincipalId: AGENT,
      delegationLinks: [
        link(AGENT, 'agent', CONNECTOR),
        link(CONNECTOR, 'service', outerConnector),
        link(outerConnector, 'service', ACCOUNT),
        link(ACCOUNT, 'human', null),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.connectorId).toBe(CONNECTOR);
  });
});

describe('§5.1 — a direct Account -> Agent presenter is REFUSED (acceptance (d))', () => {
  it('refuses with the distinct code, whatever scope it holds', async () => {
    const { service } = makeService({ connectors: [CONNECTOR], descriptor: TIER0 });
    const result = await service.derive({
      actingPrincipalId: AGENT,
      delegationLinks: DIRECT_ACCOUNT_AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TELEMETRY_PRINCIPAL_NO_CONNECTOR');
    expect(result.message).toContain('connector_id');
  });

  it('carries audit metadata that is identifiers only — never payload bytes', async () => {
    // §6.5.3: the audit plane is metadata-only by rule. The route writes this
    // object into `audit_events.metadata`, so what it may contain is a
    // contract, not a convenience.
    const { service } = makeService({ connectors: [CONNECTOR], descriptor: TIER0 });
    const result = await service.derive({
      actingPrincipalId: AGENT, delegationLinks: DIRECT_ACCOUNT_AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.audit).toMatchObject({ actingPrincipalId: AGENT, chainDepth: 2 });
    expect(Object.keys(result.audit).sort()).toEqual(['actingPrincipalId', 'chainDepth', 'chainKinds']);
  });

  it('refuses an Account-plane credential with no chain at all', async () => {
    // Refused for the earlier reason — no Connector at all — which is a
    // different refusal from F1's no-Account case, and both must exist.
    const { service } = makeService({ connectors: [CONNECTOR], descriptor: TIER0 });
    const result = await service.derive({ actingPrincipalId: ACCOUNT, delegationLinks: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TELEMETRY_PRINCIPAL_NO_CONNECTOR');
  });

  it('refuses when no principal resolved at all', async () => {
    const { service } = makeService({ connectors: [CONNECTOR], descriptor: TIER0 });
    const result = await service.derive({ actingPrincipalId: undefined, delegationLinks: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TELEMETRY_PRINCIPAL_REQUIRED');
  });

  it('the refusals are NOT artefacts of the fixture — the SAME fixture accepts a legal chain', async () => {
    // The control for the control: if `makeService` simply refused everything,
    // every refusal above would pass for the wrong reason. Same fixture, same
    // acting Agent, one link inserted — and it is accepted.
    //
    // Note the shape deliberately: registering the ACCOUNT as a Connector does
    // NOT rescue the direct chain, because F1 now refuses a chain whose Account
    // link IS the Connector. A legal chain needs a Connector distinct from the
    // Account, which is exactly what the ratified `Account -> Connector -> Agent`
    // shape is.
    const { service } = makeService({ connectors: [CONNECTOR], descriptor: TIER0 });
    const result = await service.derive({
      actingPrincipalId: AGENT, delegationLinks: CONNECTOR_DESCENDED_AGENT,
    });
    expect(result.ok).toBe(true);
  });

  it('registering the Account as a Connector does NOT rescue a direct chain (F1)', async () => {
    // Otherwise the F1 repair could be walked around by a mis-registration.
    const { service } = makeService({ connectors: [CONNECTOR, ACCOUNT], descriptor: TIER0 });
    const result = await service.derive({
      actingPrincipalId: AGENT, delegationLinks: DIRECT_ACCOUNT_AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TELEMETRY_PRINCIPAL_NO_ACCOUNT');
  });
});

describe('D3 — descriptor enforcement, deny-by-default', () => {
  it('refuses a Connector whose current descriptor declares no telemetry tier', async () => {
    const { service } = makeService({ connectors: [CONNECTOR], descriptor: null });
    const result = await service.derive({ actingPrincipalId: CONNECTOR, delegationLinks: CONNECTOR_WITH_ACCOUNT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TELEMETRY_TIER_NOT_DECLARED');
  });

  it("refuses a connector declaring tier 'none' — that is not a Tier-0 source", async () => {
    const { service } = makeService({ connectors: [CONNECTOR], descriptor: { tier: 'none' } });
    const result = await service.derive({ actingPrincipalId: CONNECTOR, delegationLinks: CONNECTOR_WITH_ACCOUNT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TELEMETRY_TIER_UNAVAILABLE');
  });

  it("maps 'presence' and 'full' onto policy tier 0 (§6 table, TS-5)", async () => {
    for (const tier of ['presence', 'full']) {
      const { service } = makeService({ connectors: [CONNECTOR], descriptor: { tier, products: ['p'] } });
      const result = await service.derive({ actingPrincipalId: CONNECTOR, delegationLinks: CONNECTOR_WITH_ACCOUNT });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.binding.policyTier).toBe(0);
      expect(result.descriptor.descriptorTier).toBe(tier);
    }
  });

  it('reads the descriptor of the OWNING connector, not the acting agent', async () => {
    const { service, queries } = makeService({ connectors: [CONNECTOR], descriptor: TIER0 });
    await service.derive({ actingPrincipalId: AGENT, delegationLinks: CONNECTOR_DESCENDED_AGENT });
    const descriptorQuery = queries.find((q) => q.text.includes('service_descriptor_versions'));
    expect(descriptorQuery?.params).toEqual([CONNECTOR]);
  });
});
