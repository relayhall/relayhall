/**
 * The shape-class fixtures for the §4.5(a) conformance gate.
 *
 * **A FIXTURE ROW IS DATA. Adding one is a data change.** The behaviour each
 * class asserts is in `gate.ts`, because a behavioural assertion has to observe
 * production doing the thing — a fixture that carried its own verdict would be
 * a model of the answer, and this programme has been burned twice by exactly
 * that ("a test that models the thing can be edited to agree with a lie about
 * it").
 *
 * Each row below therefore carries only the PROVIDER'S CHARACTERISTIC: what
 * document the Identity provider publishes, what its token contains, and how a
 * deployment configures the board for it. The gate then observes what
 * production makes of that.
 *
 * ── THE HOLLOWING ANCHORS ──
 *
 * `backend/scripts/w2-red-proofs.js` runs the §4.5(a) mutation set, including
 * the hollowing ONCE PER CLASS: keep every label and path stamp, but edit that
 * class's fixture so it no longer exercises its characteristic, and require
 * that class's assertion to go red while its control stays green. Each row's
 * characteristic-bearing value is written as a single distinctive literal so
 * the driver can find it exactly once and refuse if it cannot.
 *
 * This module is excluded from the §4.5(b) vendor-literal gate — it is the
 * fixture module that gate names — which is why the vendor behaviours §10a
 * describes may be named here and nowhere in the relying-party source.
 */
import type { ShapeClassId } from './census';

/** One host, many issuers: shape class 1's characteristic lives in the paths. */
export const CONFORMANCE_HOST = 'https://idp.conformance.test';

export interface FixtureProviderConfig {
  groupsClaim?: string | null;
  groupBindingMode?: 'off' | 'claim';
  clientAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt' | 'none';
  backchannelLogoutEnabled?: boolean;
  allowPrivateIssuerAddress?: boolean;
}

export interface ShapeClassFixture {
  classId: ShapeClassId;
  /** Census targets this fixture stands for. */
  targets: readonly string[];
  /** The label the substitution mutation relabels. */
  label: string;
  /** The real product behaviour §10a says produces this class. */
  because: string;
  issuerPath: string;
  documentOverrides?: Record<string, unknown>;
  providerConfig?: FixtureProviderConfig;
  /** Extra ID-token claims beyond the protocol base the gate supplies. */
  idTokenClaims?: Record<string, unknown>;
  /**
   * Shape class 7 only: the address this Identity provider's host resolves to.
   * It is the PROVIDER'S characteristic — where it is deployed — so it is
   * fixture data rather than a constant in the gate, and hollowing it means
   * moving the provider onto the public internet.
   */
  resolvesTo?: string;
  /** Class 7's control address: a public one, permitted with the flag OFF. */
  publicControlAddress?: string;
}

/**
 * Shape class 3's group values, and the reason the column is opaque: a
 * directory GUID, a path and a bare name must all bind without the code
 * knowing which it is looking at.
 */
export const CLASS_3_GROUP_VALUES = [
  '4f2a9c1e-77b2-4a3d-9f10-6c5b8e2d1a44',
  '/engineering/platform',
  'Platform Engineers',
] as const;

/** Shape class 2's nesting. The dotted path is configuration, not code. */
export const CLASS_2_CLAIM_PATH = 'realm_access.roles';
export const CLASS_2_CLAIM_VALUE = '/engineering/platform';

export const FIXTURES: readonly ShapeClassFixture[] = [
  {
    classId: 1,
    targets: ['standard-oidc', 'authentik'],
    label: 'issuer-path-under-shared-host-alpha',
    because: 'a per-tenant, per-realm or per-application path under one host',
    issuerPath: '/application/alpha',
  },
  {
    classId: 1,
    targets: ['standard-oidc', 'authentik'],
    label: 'issuer-path-under-shared-host-beta',
    because: 'a second application on the SAME host with its own endpoint set',
    issuerPath: '/application/beta',
    documentOverrides: {},
  },
  {
    classId: 2,
    targets: ['standard-oidc', 'authentik'],
    label: 'nested-groups-claim',
    because: 'realm roles nested under a container, or an operator-named property mapping',
    issuerPath: '/application/nested-claims',
    providerConfig: { groupsClaim: CLASS_2_CLAIM_PATH, groupBindingMode: 'claim' },
    idTokenClaims: { realm_access: { roles: [CLASS_2_CLAIM_VALUE] } },
  },
  {
    classId: 3,
    targets: ['standard-oidc', 'authentik'],
    label: 'opaque-group-values',
    because: 'directory GUIDs, group paths and bare names, all in one column',
    issuerPath: '/application/opaque-groups',
    providerConfig: { groupsClaim: 'groups', groupBindingMode: 'claim' },
    idTokenClaims: { groups: [...CLASS_3_GROUP_VALUES] },
  },
  {
    classId: 4,
    targets: ['standard-oidc'],
    label: 'no-groups-claim-at-all',
    because: 'ID tokens that carry no group claim; group data needs a separate admin API',
    issuerPath: '/application/no-groups',
    providerConfig: { groupsClaim: 'groups', groupBindingMode: 'off' },
    idTokenClaims: {},
  },
  {
    classId: 5,
    targets: ['standard-oidc'],
    label: 'truncated-groups-claim',
    because: 'a large groups claim replaced by an aggregated-claims overage indicator',
    issuerPath: '/application/overage',
    providerConfig: { groupsClaim: 'groups', groupBindingMode: 'claim' },
    idTokenClaims: {
      _claim_names: { groups: 'src1' },
      _claim_sources: { src1: { endpoint: `${CONFORMANCE_HOST}/application/overage/groups` } },
    },
  },
  {
    classId: 6,
    targets: ['standard-oidc'],
    label: 'no-backchannel-logout',
    because: 'a provider whose discovery document advertises no back-channel logout',
    issuerPath: '/application/no-backchannel',
    documentOverrides: { backchannel_logout_supported: false },
    providerConfig: { backchannelLogoutEnabled: false },
  },
  {
    classId: 7,
    targets: ['standard-oidc', 'authentik'],
    label: 'private-issuer-address',
    because: 'an issuer deployed in-cluster or on a LAN, unreachable from the public internet',
    issuerPath: '/application/private-address',
    providerConfig: { allowPrivateIssuerAddress: true },
    resolvesTo: '10.0.0.5',
    publicControlAddress: '93.184.216.34',
  },
  {
    classId: 8,
    targets: ['standard-oidc', 'authentik'],
    label: 'client-auth-secret-basic',
    because: 'HTTP Basic client authentication, accepted almost everywhere',
    issuerPath: '/application/auth-basic',
    providerConfig: { clientAuthMethod: 'client_secret_basic' },
  },
  {
    classId: 8,
    targets: ['standard-oidc', 'authentik'],
    label: 'client-auth-secret-post',
    because: 'the secret in the form body rather than the header',
    issuerPath: '/application/auth-post',
    providerConfig: { clientAuthMethod: 'client_secret_post' },
  },
  {
    classId: 8,
    targets: ['standard-oidc', 'authentik'],
    label: 'client-auth-private-key-jwt',
    because: 'asymmetric client authentication by signed assertion',
    issuerPath: '/application/auth-private-key',
    providerConfig: { clientAuthMethod: 'private_key_jwt' },
  },
  {
    classId: 8,
    targets: ['standard-oidc', 'authentik'],
    label: 'client-auth-none',
    because: 'a public client authenticating by PKCE alone',
    issuerPath: '/application/auth-none',
    providerConfig: { clientAuthMethod: 'none' },
  },
];

/** Every distinct class the fixture table claims to cover. */
export function fixtureClassIds(): ShapeClassId[] {
  return [...new Set(FIXTURES.map((fixture) => fixture.classId))].sort((a, b) => a - b);
}

/** Every distinct census target the fixture table claims to stand for. */
export function fixtureTargets(): string[] {
  return [...new Set(FIXTURES.flatMap((fixture) => [...fixture.targets]))].sort();
}
