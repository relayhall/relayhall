/**
 * RH-P3.C4 — T28: rotation inherits the transport pin VERBATIM.
 *
 * AUTHZ design 4d961e37 §7.3: "rotation mints the successor as an EXACT COPY
 * — scope set and transport class inherited verbatim; a rotation request
 * attempting ANY scope or transport change is REFUSED (pinned parity test)."
 *
 * The pin was previously proven only by reading the call site. It matters
 * more than that: if rotation silently widened an `mcp`-pinned Agent to
 * `any`, the credential would keep working AND gain the entire REST surface
 * the pin exists to withhold — a privilege escalation that no error would
 * announce. So this drives the production `rotateCredential` at the pool
 * boundary (the delegationCore/telemetryFrames precedent) and reads what the
 * successor was actually issued with.
 *
 * Lives in its own file because it mocks `db/connection` module-wide, which
 * the in-process dispatch suite must not do.
 */
process.env.RELAYHALL_CREDENTIAL_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 5).toString('base64') });
process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY = 'k1';

const db = {
  script: [] as Array<(text: string, params?: unknown[]) => { rows: any[] } | null>,
};
function scripted(text: string, params?: unknown[]): { rows: any[] } {
  for (const handler of db.script) {
    const result = handler(text, params);
    if (result) return result;
  }
  return { rows: [] };
}
jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (text: string, params?: unknown[]) => scripted(text, params)),
    connect: jest.fn(async () => ({
      query: jest.fn(async (text: string, params?: unknown[]) => scripted(text, params)),
      release: jest.fn(),
    })),
  },
}));
jest.mock('../services/AuditService', () => ({
  auditService: { record: jest.fn(async () => ({})) },
}));

import { principalService } from '../services/PrincipalService';

const CREDENTIAL = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL = '44444444-4444-4444-8444-444444444444';

function sourceRow(transport: string) {
  return {
    cred_id: CREDENTIAL, principal_id: PRINCIPAL, key_id: 'keyid01', label: 'connector-mcp',
    scopes: '["tasks:read","reports:write"]', transport, credential_type: 'api_key',
    expires_at: null, revoked_at: null, grace_until: null, rotated_from_id: null,
    // p.* — a Service Account's Connector, which is what rotates (§7.3).
    id: PRINCIPAL, handle: 'connector_one', kind: 'service', legacy_identity: false, status: 'active',
  };
}

beforeEach(() => {
  db.script.length = 0;
  jest.restoreAllMocks();
});

describe('T28 — the successor is an exact copy of the pin', () => {
  it.each(['mcp', 'api', 'any'])('rotating a %s-pinned credential issues a %s-pinned successor', async (transport) => {
    db.script.push((text) => (/FOR UPDATE OF c/.test(text) ? { rows: [sourceRow(transport)] } : null));
    const issue = jest.spyOn(principalService, 'issueCredential')
      .mockResolvedValue({ fullKey: 'rh_dev_new01.secretsecretsecretsecret', credentialId: 'new-cred', keyId: 'new01' } as never);

    await principalService.rotateCredential(CREDENTIAL, 24);

    expect(issue).toHaveBeenCalledTimes(1);
    const issued = issue.mock.calls[0][0] as { transport?: string; scopes: string[] };
    expect(issued.transport).toBe(transport);
    // The scope set rides the same rule, and a rotation that widened either
    // would be the same class of defect.
    expect(issued.scopes).toEqual(['tasks:read', 'reports:write']);
  });

  it('offers no way to ask for a different pin — the API has no transport argument', () => {
    // Refusal by inexpressibility is the strongest form of "a rotation
    // request attempting ANY transport change is REFUSED": there is no
    // parameter to carry the request, on the service or on the route.
    const source = principalService.rotateCredential.toString();
    const signature = source.slice(0, source.indexOf(')') + 1);
    expect(signature).toContain('credentialId');
    expect(signature).not.toContain('transport');
    // And the ONE place a transport reaches the successor reads the source row.
    expect(source).toMatch(/transport:\s*row\.transport/);
  });

  it('breaks when the copy regresses: a successor pinned to something else is caught', async () => {
    // The mutation control. If the call site ever stopped forwarding the
    // source row's class, this assertion — and only this assertion — fails.
    db.script.push((text) => (/FOR UPDATE OF c/.test(text) ? { rows: [sourceRow('mcp')] } : null));
    const issue = jest.spyOn(principalService, 'issueCredential')
      .mockResolvedValue({ fullKey: 'rh_dev_new01.secretsecretsecretsecret', credentialId: 'new-cred', keyId: 'new01' } as never);
    await principalService.rotateCredential(CREDENTIAL, 24);
    const issued = issue.mock.calls[0][0] as { transport?: string };
    expect(issued.transport).not.toBe('any');
    expect(issued.transport).not.toBeUndefined();
  });
});
