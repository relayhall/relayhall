/**
 * WHAT A SESSION MAY HAND TO A BEARER CREDENTIAL (card 6e25ae48).
 *
 * `scopesForRole` answers what a session may REACH; `delegableScopes` answers
 * what it may DELEGATE. The defect was the assumption that those are the same
 * question: for `admin` and `orchestrator` — the two roles a fresh deployment
 * can possibly be administered by — the first answer is exactly `['root']`, and
 * `root` is the one scope `issueCredential` refuses outright (AUTHZ §5.2 rule 2
 * / AZ-18). Every surface that offered the caller's own set as its menu was
 * therefore offering an administrator one choice and it was the refused one.
 *
 * ── HOW THIS FILE AVOIDS TESTING ITSELF ──
 *
 * The obvious test — "the root arm returns this list of scopes" — is a copy of
 * the catalogue under test, and a copy can be edited into agreement with a
 * broken implementation. So nothing here restates a scope list. The root arm is
 * measured as a SCHEMA-WIDE COMPARISON against `MINTABLE_SCOPES` itself, the
 * per-role arms are derived from `scopesForRole`, and the claim that the root
 * arm is not a WIDENING is anchored behaviourally on the production predicate
 * that decides what a root issuer may grant (`validateRequestedScopes` under
 * `resolveIssuerAuthority`) rather than on this module's own reasoning.
 */
import { delegableScopes, delegableScopesForCaller, scopesForRole } from '../utils/identityScopes';
import { MINTABLE_SCOPES, ROOT_SCOPE, isMintableScope } from '../utils/scopeMap';
import { resolveIssuerAuthority, validateRequestedScopes } from '../utils/credentialAuthority';

/** The role vocabulary migration 062 allows, as `scopesForRole` branches on it. */
const ROLES = [
  'admin', 'orchestrator', 'operator', 'editor', 'user', 'agent',
  'service', 'qa', 'reviewer', 'viewer',
];

describe('delegableScopes — the universal property', () => {
  it('never returns `root`, whatever it is handed', () => {
    const inputs: Array<string[] | null | undefined> = [
      [ROOT_SCOPE],
      [ROOT_SCOPE, 'tasks:read'],
      [...MINTABLE_SCOPES],
      [],
      null,
      undefined,
      ['root', 'root'],
    ];
    for (const input of inputs) {
      expect(delegableScopes(input)).not.toContain(ROOT_SCOPE);
    }
    // And for every role the vocabulary admits, not merely the ones above.
    for (const role of ROLES) {
      expect(delegableScopes(scopesForRole(role))).not.toContain(ROOT_SCOPE);
    }
  });

  it('returns only MINTABLE scopes, so nothing it offers can be refused as inert', () => {
    for (const role of ROLES) {
      for (const scope of delegableScopes(scopesForRole(role))) {
        expect(isMintableScope(scope)).toBe(true);
      }
    }
    // A held scope that is not mintable is not offered: `validateRequestedScopes`
    // refuses inert vocabulary (A12.3), so offering one would be a menu entry
    // the board is certain to reject.
    expect(delegableScopes(['tasks:read', 'not-a-scope', 'tools:read'])).toEqual(['tasks:read']);
  });
});

describe('the root arm', () => {
  it('is exactly the mintable catalogue minus the sentinel — compared to the catalogue, not to a copy', () => {
    const expected = MINTABLE_SCOPES.filter((scope) => scope !== ROOT_SCOPE);
    expect(delegableScopes([ROOT_SCOPE])).toEqual(expected);
    // Stated as a set equality too, so a reordering of the catalogue is a
    // failure of the ORDER claim below and not of this one.
    expect(new Set(delegableScopes([ROOT_SCOPE]))).toEqual(new Set(expected));
  });

  it('is NOT a widening: a root issuer may already grant every scope it returns', () => {
    // The outside anchor. `resolveIssuerAuthority` + `validateRequestedScopes`
    // are the production pair that decides what an issuer holding `root` may
    // put on a credential; `routes/services.ts` skips its own
    // ISSUE_EXCEEDS_SESSION check for a root caller for the same reason. If
    // this arm offered anything beyond what that pair accepts, this assertion
    // fails — which is the only way a "this is not a widening" claim can be
    // measured rather than asserted.
    const authority = resolveIssuerAuthority({ scopes: [ROOT_SCOPE], role: 'admin' });
    expect(authority.canManage).toBe(true);
    const verdict = validateRequestedScopes(delegableScopes([ROOT_SCOPE]), authority);
    expect(verdict.ok).toBe(true);
  });

  it('answers the same for `admin` and `orchestrator`, which is where the defect lived', () => {
    // The defect, bound to its cause: BOTH of these derive `['root']` and
    // nothing else, so before this function existed both were undelegable.
    expect(scopesForRole('admin')).toEqual([ROOT_SCOPE]);
    expect(scopesForRole('orchestrator')).toEqual([ROOT_SCOPE]);
    for (const role of ['admin', 'orchestrator']) {
      const delegable = delegableScopes(scopesForRole(role));
      expect(delegable.length).toBeGreaterThan(0);
      expect(delegable).not.toContain(ROOT_SCOPE);
    }
  });
});

describe('delegableScopesForCaller — the CALLER, not just the scope set (B3)', () => {
  /**
   * Round-1 review finding B3 (verdict `7cce6577`): `GET /principals/me` answers
   * every authenticated caller, a bearer credential included, and the field was
   * telling an `rh_` key holding `tasks:read` that it could delegate
   * `tasks:read`. It cannot — through EITHER shipped issuance surface.
   *
   * Each arm below is anchored on the production predicate that decides the
   * surface, not on this file's own reasoning about it.
   */
  const SESSION_KINDS = ['session', 'dashboard_jwt'];
  const MACHINE_KINDS = ['principal_api_key', 'legacy_api_key', 'reports_read_key', 'local_admin', undefined];

  it('a login session gets the scope-set answer, on both session kinds', () => {
    for (const kind of SESSION_KINDS) {
      expect(delegableScopesForCaller(kind, [ROOT_SCOPE]))
        .toEqual(MINTABLE_SCOPES.filter((scope) => scope !== ROOT_SCOPE));
      expect(delegableScopesForCaller(kind, scopesForRole('user')))
        .toEqual(delegableScopes(scopesForRole('user')));
    }
  });

  it('a machine credential without the sentinel may delegate NOTHING', () => {
    // The defect, as an assertion. `POST /services` refuses every bearer caller
    // outright (SESSION_ONLY) and `POST /principals/:id/credentials` refuses one
    // that does not present `root` — so there is no surface through which this
    // caller could put ANY of its scopes on a credential.
    for (const kind of MACHINE_KINDS) {
      expect(delegableScopesForCaller(kind, ['tasks:read', 'tasks:write'])).toEqual([]);
      expect(delegableScopesForCaller(kind, scopesForRole('operator'))).toEqual([]);
      expect(delegableScopesForCaller(kind, [])).toEqual([]);
    }
  });

  it('ANCHOR: that refusal is the production issuer gate, not this file’s opinion', () => {
    // `resolveIssuerAuthority` is what `POST /principals/:id/credentials` asks.
    // The empty answer above is correct exactly because it says `canManage:false`
    // for this caller — and the non-empty answer below is correct exactly
    // because it says `canManage:true` for the other one.
    const ordinary = resolveIssuerAuthority({ scopes: ['tasks:read'], role: 'user' });
    expect(ordinary.canManage).toBe(false);
    expect(delegableScopesForCaller('principal_api_key', ['tasks:read'])).toEqual([]);

    const sentinel = resolveIssuerAuthority({ scopes: [ROOT_SCOPE], role: 'admin' });
    expect(sentinel.canManage).toBe(true);
    expect(sentinel.grantableScopes).toBeNull();
    expect(delegableScopesForCaller('principal_api_key', [ROOT_SCOPE]).length).toBeGreaterThan(0);
  });

  it('a machine credential that DOES present the sentinel keeps its answer', () => {
    // Not a courtesy: AUTHZ §10 preserves pre-096 legacy root bearers, and
    // `resolveIssuerAuthority` admits any caller presenting `root` however it
    // came by it. Answering such a caller `[]` would be a different lie from the
    // one B3 named. It still never includes `root` itself.
    const answer = delegableScopesForCaller('principal_api_key', [ROOT_SCOPE]);
    expect(answer).toEqual(MINTABLE_SCOPES.filter((scope) => scope !== ROOT_SCOPE));
    expect(answer).not.toContain(ROOT_SCOPE);
  });

  it('never returns `root`, on any arm', () => {
    for (const kind of [...SESSION_KINDS, ...MACHINE_KINDS]) {
      for (const held of [[ROOT_SCOPE], [ROOT_SCOPE, 'tasks:read'], MINTABLE_SCOPES, [], null]) {
        expect(delegableScopesForCaller(kind, held)).not.toContain(ROOT_SCOPE);
      }
    }
  });
});

describe('every other arm', () => {
  it('offers only what the session actually holds — no role gains a scope here', () => {
    // The containment that makes this function safe for a NON-root session:
    // §5.2 rule 1 bounds a delegation by the acting identity's own effective
    // authority, and `routes/services.ts` enforces exactly that with
    // ISSUE_EXCEEDS_SESSION. A widening on this arm would be an authorization
    // defect, not a copy mistake.
    for (const role of ROLES) {
      const held = scopesForRole(role);
      if (held.includes(ROOT_SCOPE)) continue; // the arm above owns this case
      for (const scope of delegableScopes(held)) {
        expect(held).toContain(scope);
      }
    }
  });

  it('is the held set minus the sentinel, for every non-root role', () => {
    for (const role of ROLES) {
      const held = scopesForRole(role);
      if (held.includes(ROOT_SCOPE)) continue;
      expect(new Set(delegableScopes(held))).toEqual(
        new Set(held.filter((scope) => scope !== ROOT_SCOPE)),
      );
    }
  });

  it('leaves an unknown role with nothing to delegate', () => {
    // `scopesForRole` refuses to make an unknown externally supplied role an
    // implicit writer; delegation inherits that refusal rather than softening it.
    expect(scopesForRole('not-a-role')).toEqual([]);
    expect(delegableScopes(scopesForRole('not-a-role'))).toEqual([]);
  });

  it('CONTROL: the scope-set answer is not the caller answer, and they differ where it matters', () => {
    // The two functions must not collapse into one. If they ever return the same
    // thing for a bearer holding an ordinary scope, B3 is back.
    const held = ['tasks:read'];
    expect(delegableScopes(held)).toEqual(['tasks:read']);
    expect(delegableScopesForCaller('principal_api_key', held)).toEqual([]);
  });

  it('orders by the catalogue, not by the caller, so a menu does not reshuffle itself', () => {
    const shuffled = ['reports:read', 'tasks:read', 'projects:read'];
    const inCatalogueOrder = MINTABLE_SCOPES.filter((scope) => shuffled.includes(scope));
    expect(delegableScopes(shuffled)).toEqual(inCatalogueOrder);
    // Non-vacuous: the caller's order really is different from the catalogue's.
    expect(shuffled).not.toEqual(inCatalogueOrder);
  });
});
