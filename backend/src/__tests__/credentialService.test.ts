/**
 * Credential service authority, scope mapping and issuance refusals (CB-5).
 *
 * The parts worth pinning are the ones where getting it wrong grants more
 * access than intended: who may mint a key, what scopes they may put on it,
 * which routes a key can reach, and what rotation does to the old key's life.
 */
import { requiredScopeFor, scopesSatisfy, ALL_SCOPES, MINTABLE_SCOPES } from '../utils/scopeMap';
import {
  canAssignRole,
  refusesCredentials,
  resolveIssuerAuthority,
  validateNewHandle,
  validateRequestedScopes,
} from '../utils/credentialAuthority';

describe('scope map', () => {
  it('requires an explicit scope set even for authenticated-only routes', () => {
    expect(scopesSatisfy(null, 'authenticated')).toBe(false);
    expect(scopesSatisfy(undefined, 'authenticated')).toBe(false);
    expect(scopesSatisfy([], 'authenticated')).toBe(true);
  });

  it('maps the task families by method', () => {
    expect(requiredScopeFor('GET', '/tasks')).toBe('tasks:read');
    expect(requiredScopeFor('GET', '/tasks/abc')).toBe('tasks:read');
    expect(requiredScopeFor('POST', '/tasks')).toBe('tasks:write');
    expect(requiredScopeFor('PATCH', '/tasks/abc')).toBe('tasks:write');
  });

  it('compiling a Brief is a disclosure act — tasks:read, never write (§10, A12)', () => {
    expect(requiredScopeFor('POST', '/tasks/abc/brief')).toBe('tasks:read');
    // RH-P3.C4 (ii) / D4: the retired spelling is NOT aliased, so it must
    // no longer resolve to the read-narrowed rule either.
    expect(requiredScopeFor('POST', '/tasks/abc/prompt')).not.toBe('tasks:read');
    // The session altitude sits above the /principals family rules, or a
    // POST there would demand principals:admin and no agent could bootstrap.
    expect(requiredScopeFor('POST', '/principals/me/brief')).toBe('principals:read');
    // A12's contracted Phase-3 removal, executed in RH-P3.C5: the
    // spawn-prompt alias is no longer a Brief surface. It must NOT resolve
    // to the read-narrowed prompt rule any more — it falls to the generic
    // fail-closed classification for unrecognized task POSTs.
    expect(requiredScopeFor('POST', '/tasks/abc/spawn-prompt')).not.toBe('tasks:read');
    // The retired scope string must not survive anywhere in the vocabulary.
    expect((ALL_SCOPES as string[]).includes('tasks:prompt')).toBe(false);
  });

  it('hard removal is the admin verb (§4.4): deletes leave the write plane', () => {
    expect(requiredScopeFor('DELETE', '/tasks/abc')).toBe('tasks:admin');
    expect(requiredScopeFor('DELETE', '/reports/abc')).toBe('reports:admin');
    // Child deletes are ordinary writes, not object removal.
    expect(requiredScopeFor('DELETE', '/tasks/abc/dependencies/def')).toBe('tasks:write');
  });

  it('lets any authenticated principal fetch the OpenAPI document', () => {
    expect(requiredScopeFor('GET', '/openapi.json')).toBe('authenticated');
    expect(scopesSatisfy(['reports:read'], 'authenticated')).toBe(true);
    expect(scopesSatisfy([], 'authenticated')).toBe(true);
  });

  it('keeps owner-plane configuration behind the root sentinel (A12.7)', () => {
    for (const path of ['/webhooks', '/litellm/keys']) {
      expect(requiredScopeFor('POST', path)).toBe('root');
    }
  });

  it('grant management is owner-plane; own-grant introspection rides the principals family (RH-P2.3)', () => {
    // Every /grants method is owner-plane (§2.9: grant mutation out of the
    // agent plane).
    expect(requiredScopeFor('GET', '/grants')).toBe('root');
    expect(requiredScopeFor('POST', '/grants')).toBe('root');
    expect(requiredScopeFor('DELETE', '/grants/abc')).toBe('root');
    // A principal's OWN grants are introspected on the principals family
    // (GET → principals:read; the in-handler own/manage split is A12.5).
    expect(requiredScopeFor('GET', '/principals/abc/grants')).toBe('principals:read');
  });

  it('identity plane: directory reads at principals:read, mutations at principals:admin (A12.5)', () => {
    expect(requiredScopeFor('GET', '/principals')).toBe('principals:read');
    // SETGOV `D-5` (AZ-A5 clause 9b, accepted by owner ruling `dda2cdcc` §1):
    // the caller's own principal moves to `authenticated` on the /preferences
    // precedent - no target identifier, disclosing the caller to itself only.
    expect(requiredScopeFor('GET', '/principals/me')).toBe('authenticated');
    expect(requiredScopeFor('GET', '/principals/me/effective-access')).toBe('authenticated');
    // ...and the rest of the /principals family is UNTOUCHED by the move.
    expect(requiredScopeFor('GET', '/principals/abc')).toBe('principals:read');
    expect(requiredScopeFor('GET', '/principals/abc/credentials')).toBe('principals:read');
    expect(requiredScopeFor('POST', '/principals')).toBe('principals:admin');
    expect(requiredScopeFor('POST', '/principals/abc/credentials')).toBe('principals:admin');
    // AZ-S5 (design 4d961e37 §9.3): reveal/revoke dispatch by
    // authentication kind IN THE HANDLER (own-lineage self-service, manage
    // gate otherwise) — the route ceiling is 'authenticated'; rotation and
    // the rest of the family stay owner-plane.
    expect(requiredScopeFor('POST', '/credentials/x/revoke')).toBe('authenticated');
    expect(requiredScopeFor('POST', '/credentials/x/rotate')).toBe('principals:admin');
  });

  it('personality registry: read / write / admin by consequence (A12.4)', () => {
    expect(requiredScopeFor('GET', '/personalities')).toBe('personalities:read');
    expect(requiredScopeFor('GET', '/personalities/abc')).toBe('personalities:read');
    expect(requiredScopeFor('POST', '/personalities')).toBe('personalities:write');
    expect(requiredScopeFor('PATCH', '/personalities/abc')).toBe('personalities:write');
    // The repository-sync surface was removed 2026-08-09; the old path now
    // falls to the family write rule and answers 404 (no handler exists).
    expect(requiredScopeFor('POST', '/personalities/sync')).toBe('personalities:write');
    expect(requiredScopeFor('DELETE', '/personalities/abc')).toBe('personalities:admin');
  });

  it('skills registry: read / write / admin by consequence (A14.1)', () => {
    expect(requiredScopeFor('GET', '/skills')).toBe('skills:read');
    expect(requiredScopeFor('GET', '/skills/abc')).toBe('skills:read');
    expect(requiredScopeFor('GET', '/skills/abc/versions')).toBe('skills:read');
    expect(requiredScopeFor('GET', '/skills/abc/versions/2')).toBe('skills:read');
    expect(requiredScopeFor('GET', '/skills/abc/versions/2/content')).toBe('skills:use');
    expect(requiredScopeFor('POST', '/skills')).toBe('skills:write');
    expect(requiredScopeFor('PUT', '/skills/abc')).toBe('skills:write');
    expect(requiredScopeFor('POST', '/skills/abc/versions/2/submit-review')).toBe('skills:write');
    expect(requiredScopeFor('POST', '/skills/abc/versions/2/reject')).toBe('skills:write');
    expect(requiredScopeFor('POST', '/skills/abc/versions/2/publish')).toBe('skills:admin');
    expect(requiredScopeFor('POST', '/skills/abc/versions/2/retire')).toBe('skills:admin');
    expect(requiredScopeFor('PATCH', '/skills/abc/audience')).toBe('skills:admin');
    expect(requiredScopeFor('DELETE', '/skills/abc')).toBe('skills:admin');
    // The v1 Tools page is frontend-only (A14.2): /tools left the scope map
    // and any stray API call fails closed like an unmapped route.
    expect(requiredScopeFor('GET', '/tools')).toBe('root');
    expect(requiredScopeFor('POST', '/tools')).toBe('root');
    // The project↔skill link read rides the projects family.
    expect(requiredScopeFor('GET', '/projects/abc/skills')).toBe('projects:read');
    expect(requiredScopeFor('PUT', '/projects/abc/skills/skill-1')).toBe('projects:write');
    expect(requiredScopeFor('DELETE', '/projects/abc/skills/skill-1')).toBe('projects:write');
  });

  it('retired orphans fold as ruled (A12.2, A13.3)', () => {
    expect(requiredScopeFor('GET', '/sessions/pipeline-health')).toBe('tasks:read');
    expect((ALL_SCOPES as string[]).includes('sessions:read')).toBe(false);
    // The status-voice surface was DELETED (A13.3): the scope left the
    // vocabulary and the unmounted paths fail closed like any unknown route.
    expect((ALL_SCOPES as string[]).includes('status:write')).toBe(false);
    expect(requiredScopeFor('POST', '/bot-status/update')).toBe('root');
    expect(requiredScopeFor('GET', '/nim-status/current')).toBe('root');
  });

  it('compatibility inventory is the projects admin verb', () => {
    expect(requiredScopeFor('GET', '/projects/abc/compatibility')).toBe('projects:admin');
  });

  it('service registry: read / write / admin by consequence (RH-P2.1)', () => {
    expect(requiredScopeFor('GET', '/services')).toBe('services:read');
    expect(requiredScopeFor('GET', '/services/abc')).toBe('services:read');
    expect(requiredScopeFor('GET', '/services/abc/descriptor')).toBe('services:read');
    expect(requiredScopeFor('GET', '/services/abc/descriptor/versions')).toBe('services:read');
    expect(requiredScopeFor('GET', '/services/abc/descriptor/versions/2')).toBe('services:read');
    expect(requiredScopeFor('POST', '/services')).toBe('services:write');
    expect(requiredScopeFor('PATCH', '/services/abc')).toBe('services:write');
    expect(requiredScopeFor('PUT', '/services/abc/descriptor')).toBe('services:write');
    // Retirement is staged behind the admin verb (§4.4; RH-DESIGN.5 R5).
    expect(requiredScopeFor('POST', '/services/abc/retire')).toBe('services:admin');
    expect(requiredScopeFor('POST', '/services/abc/descriptor/versions/2/retire')).toBe('services:admin');
    expect(requiredScopeFor('DELETE', '/services/abc')).toBe('services:admin');
  });

  it('service subscription-class fields stay behind the root sentinel (§2.6.4)', () => {
    // Delivery endpoint, the delivery-mode switch, visibility tier and
    // runtime mode are owner-plane: a prompt-injected connector holding
    // services:write must not be able to repoint its own delivery.
    expect(requiredScopeFor('PATCH', '/services/abc/owner-plane')).toBe('root');
    expect(scopesSatisfy(['services:write', 'services:admin'], 'root')).toBe(false);
  });

  it('requires root for anything unmapped — never fail open', () => {
    for (const path of ['/some-new-route', '/plugins/whatever', '/']) {
      expect(requiredScopeFor('GET', path)).toBe('root');
      expect(requiredScopeFor('POST', path)).toBe('root');
    }
  });

  it('treats root as the only superset; admin is per-object', () => {
    for (const scope of ALL_SCOPES) {
      expect(scopesSatisfy(['root'], scope)).toBe(true);
    }
    expect(scopesSatisfy(['tasks:admin'], 'projects:admin')).toBe(false);
    expect(scopesSatisfy(['tasks:admin'], 'root')).toBe(false);
    expect(scopesSatisfy(['tasks:read'], 'tasks:write')).toBe(false);
    expect(scopesSatisfy([], 'tasks:read')).toBe(false);
    expect(scopesSatisfy(null, 'tasks:read')).toBe(false);
  });

  it('the invoke plane stays narrow, structurally (A12.6 as amended by RH-P2.2)', () => {
    // services:invoke became mintable WITH its consuming check (the §2.1
    // profile-set gate, RH-P2.2). tools:invoke stays unmintable until the
    // Tool object surface exists.
    for (const scope of MINTABLE_SCOPES) {
      if (scope === 'services:invoke') continue;
      expect(scope.endsWith(':invoke')).toBe(false);
    }
    expect((MINTABLE_SCOPES as string[]).includes('services:invoke')).toBe(true);
    // …no write grant satisfies any invoke requirement…
    for (const required of ['services:invoke', 'tools:invoke'] as const) {
      for (const held of ['tasks:write', 'projects:write', 'reports:write', 'personalities:write']) {
        expect(scopesSatisfy([held], required)).toBe(false);
      }
    }
    // …and the execution-adjacent routes stay exactly where A12.6 pinned them.
    expect(requiredScopeFor('POST', '/tasks/abc/notifications/deliver')).toBe('tasks:write');
    expect(requiredScopeFor('POST', '/tasks/abc/breakdown')).toBe('tasks:write');
    expect(requiredScopeFor('POST', '/litellm/models')).toBe('root');
    // POST /personalities/sync left the execution-adjacent list with the
    // repository-import surface (removed 2026-08-09).
  });
});

describe('issuer authority', () => {
  it('fails closed for missing scopes regardless of role', () => {
    expect(resolveIssuerAuthority({ scopes: null, role: 'orchestrator' }).canManage).toBe(false);
    expect(resolveIssuerAuthority({ scopes: null, role: 'admin' }).canManage).toBe(false);
    expect(resolveIssuerAuthority({ scopes: null, role: 'agent' }).canManage).toBe(false);
    expect(resolveIssuerAuthority({ scopes: null, role: 'qa' }).canManage).toBe(false);
  });

  it('authorises rh_ identities by scope, not role', () => {
    // An agent-role key holding admin may manage; an orchestrator-role key
    // without admin may not. The key is the contract, not the role.
    expect(resolveIssuerAuthority({ scopes: ['root'], role: 'agent' }).canManage).toBe(true);
    expect(resolveIssuerAuthority({ scopes: ['tasks:write'], role: 'orchestrator' }).canManage).toBe(false);
  });

  it('refuses management to a scoped key without root, whatever else it holds', () => {
    const authority = resolveIssuerAuthority({ scopes: ALL_SCOPES.filter(s => s !== 'root'), role: 'orchestrator' });
    expect(authority.canManage).toBe(false);
    // Per-object admin verbs are NOT the management sentinel.
    expect(resolveIssuerAuthority({ scopes: ['tasks:admin', 'principals:admin'], role: 'admin' }).canManage).toBe(false);
  });
});

describe('requested scope validation', () => {
  const roleAuthorised = resolveIssuerAuthority({ scopes: ['root'], role: 'orchestrator' });

  it('rejects an empty or non-array scope list', () => {
    expect(validateRequestedScopes([], roleAuthorised).ok).toBe(false);
    expect(validateRequestedScopes(undefined, roleAuthorised).ok).toBe(false);
    expect(validateRequestedScopes('tasks:read', roleAuthorised).ok).toBe(false);
  });

  it('rejects scopes outside the vocabulary', () => {
    const result = validateRequestedScopes(['tasks:read', 'journal:read'], roleAuthorised);
    expect(result.ok).toBe(false);
    // journal:read left the scope vocabulary with the Journal plugin (P1.3
    // ruling A7) — a retired scope family must not validate for new keys.
    if (!result.ok) expect(result.error).toContain('journal:read');
  });

  it('refuses ratified-but-inert vocabulary on live keys (A12.3)', () => {
    // services:invoke left this list with RH-P2.2 (its consuming surface —
    // the §2.1 profile-set authority check — is live). phases:* left it with
    // RH-P2.4, which landed the /phases object itself.
    for (const inert of ['tools:invoke', 'personalities:use']) {
      const result = validateRequestedScopes([inert], roleAuthorised);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('not yet mintable');
    }
  });

  it('mints the closed Blueprint scope family now that its surfaces are live', () => {
    const scopes = ['blueprints:read', 'blueprints:write', 'blueprints:use', 'blueprints:admin'];
    const result = validateRequestedScopes(scopes, roleAuthorised);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(scopes);
  });

  it('mints audit:read now that the append-only audit surface is live (RH-P2.7)', () => {
    const result = validateRequestedScopes(['audit:read'], roleAuthorised);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(['audit:read']);
    expect(requiredScopeFor('GET', '/audit')).toBe('audit:read');
  });

  it('mints the phases family now that the /phases object is live (RH-P2.4)', () => {
    const result = validateRequestedScopes(['phases:read', 'phases:write', 'phases:admin'], roleAuthorised);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(['phases:read', 'phases:write', 'phases:admin']);
  });

  it('mints the skills registry family now that its surface is live (A14.1)', () => {
    const result = validateRequestedScopes(['skills:read', 'skills:write', 'skills:admin'], roleAuthorised);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(['skills:read', 'skills:write', 'skills:admin']);
  });

  it('mints the service registry family now that its surface is live (RH-P2.1)', () => {
    const result = validateRequestedScopes(['services:read', 'services:write', 'services:admin'], roleAuthorised);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(['services:read', 'services:write', 'services:admin']);
  });

  it('mints services:invoke now that its consuming check is live (RH-P2.2, §2.1)', () => {
    const result = validateRequestedScopes(['services:invoke'], roleAuthorised);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(['services:invoke']);
  });

  it('de-duplicates an accepted list', () => {
    const result = validateRequestedScopes(['tasks:read', 'tasks:read'], roleAuthorised);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(['tasks:read']);
  });

  it('prevents a bounded issuer from granting beyond its own scopes', () => {
    const bounded = { canManage: true, grantableScopes: ['tasks:read', 'reports:read'] };
    expect(validateRequestedScopes(['tasks:read'], bounded).ok).toBe(true);
    const escalation = validateRequestedScopes(['tasks:read', 'root'], bounded);
    expect(escalation.ok).toBe(false);
    if (!escalation.ok) expect(escalation.error).toContain('root');
  });
});

describe('handle validation', () => {
  it('accepts an ordinary new handle', () => {
    expect(validateNewHandle('casey')).toEqual({ ok: true, handle: 'casey' });
    expect(validateNewHandle('clawd_cron').ok).toBe(true);
  });

  it('refuses the reserved seed handles', () => {
    for (const handle of ['system', 'dashboard_user', 'reports_reader', 'hermes_task_agent']) {
      expect(validateNewHandle(handle).ok).toBe(false);
    }
  });

  it('refuses the agent: prefix so a hand-made handle cannot hijack spawn attribution', () => {
    // principalForSpawn resolves agent:<harness>:<id8>; a manual collision
    // would capture another task's attribution.
    expect(validateNewHandle('agent:hermes:deadbeef').ok).toBe(false);
    expect(validateNewHandle('agent:openclaw:00000000').ok).toBe(false);
  });

  it('refuses handles that could never join the columns that reference them', () => {
    // principals.handle is varchar(64).
    expect(validateNewHandle('x'.repeat(65)).ok).toBe(false);
    expect(validateNewHandle('x'.repeat(64)).ok).toBe(true);
  });

  it('refuses shapes that are not handles', () => {
    for (const bad of ['', '  ', 'UPPER', 'has space', '-leading', 'emoji😀', 42, null, undefined]) {
      expect(validateNewHandle(bad as unknown).ok).toBe(false);
    }
  });
});

describe('credential refusals', () => {
  it('refuses credentials for the system principal only', () => {
    expect(refusesCredentials('system')).toBe(true);
    expect(refusesCredentials('dashboard_user')).toBe(false);
    expect(refusesCredentials('casey')).toBe(false);
  });
});

describe('scope map path-shape immunity (security review findings)', () => {
  // Express routes with strict:false / caseSensitive:false, so all of these
  // spellings reach the SAME handler. Any rule whose miss ESCALATES must be
  // immune to spelling. The execution routes are gone (P1.2 wave 2); the
  // property is pinned on the surviving Brief rule.
  const PROMPT_PATHS = [
    '/tasks/abc/brief',
    '/tasks/abc/brief/',
    '/tasks/abc/brief//',
    '/tasks/abc/BRIEF',
    '/tasks//abc//brief',
    '/tasks/abc/brief?x=1',
  ];

  it.each(PROMPT_PATHS)('requires tasks:read for %s', (path) => {
    expect(requiredScopeFor('POST', path)).toBe('tasks:read');
  });

  it('keeps the unmapped-route default fail-closed under odd spellings', () => {
    for (const path of ['/unknown/', '/UNKNOWN', '//unknown//']) {
      expect(requiredScopeFor('GET', path)).toBe('root');
    }
  });

  it('does not over-match ordinary task routes into tasks:prompt', () => {
    expect(requiredScopeFor('GET', '/tasks/abc')).toBe('tasks:read');
    expect(requiredScopeFor('POST', '/tasks/abc/notes')).toBe('tasks:write');
    expect(requiredScopeFor('POST', '/tasks/abc/claim')).toBe('tasks:write');
  });
});

describe('role assignment ceiling (security review finding)', () => {
  it('refuses roles above the issuer, on the axis the spec left unbounded', () => {
    expect(canAssignRole('orchestrator', 'admin')).toBe(false);
    expect(canAssignRole('orchestrator', 'orchestrator')).toBe(false);
    expect(canAssignRole('admin', 'admin')).toBe(true);
    expect(canAssignRole('admin', 'orchestrator')).toBe(true);
  });

  it('allows ordinary working roles and no role at all', () => {
    for (const role of ['agent', 'qa', 'reviewer', 'user', 'viewer', 'editor']) {
      expect(canAssignRole('orchestrator', role)).toBe(true);
    }
    expect(canAssignRole('orchestrator', null)).toBe(true);
  });

  it('refuses an unknown role rather than letting it reach the DB check constraint', () => {
    expect(canAssignRole('admin', 'superuser')).toBe(false);
    expect(canAssignRole('admin', 'ADMIN')).toBe(false);
  });
});

describe('managing roles', () => {
  it('excludes operator — the spec granted management to admin/owner only', () => {
    // This set becomes externally reachable once OIDC provider group claims feed
    // role_snapshot, so an extra member here is a real grant.
    expect(resolveIssuerAuthority({ scopes: null, role: 'operator' }).canManage).toBe(false);
  });
});
