// OwnConnectorsService — the read model behind `GET /principals/me/connectors`
// (card 653be44f, owner design record 99d6b0ad §3.1, AUTHZ 4d961e37 §9.2).
//
// WHY THIS EXISTS. The day-one flow needs the caller's OWN chain and nothing
// else: the Connectors an Account created, the credentials under each, and the
// Agents minted beneath them. Neither existing read serves that shape —
// `GET /principals` lists the WHOLE directory (principals:read) and
// `GET /services` filters by object grants, which a self-registered Connector
// row carries none of, so an Account cannot see its own Connector there.
//
// AUTHORITY. This module adds NONE. It is a read, keyed strictly on the
// caller's own principal id, and every row it returns is already reachable to
// a `principals:read` caller through `GET /principals` +
// `GET /principals/{id}/credentials` (the AZ-S4 own-subtree arm). Concealment
// is structural rather than checked: there is no id parameter to guess, and
// the query is anchored on `parent_principal_id = <the caller>`.
//
// SECRETS. No secret, ciphertext or hash is selected here. `secret_ciphertext`
// appears only as a NULL test, exactly as `PrincipalService.listCredentials`
// does it.
import { pool } from '../db/connection';

export type CredentialUiState = 'live' | 'graced' | 'replaced' | 'expired' | 'revoked';

export interface OwnConnectorCredential {
  id: string;
  keyId: string | null;
  label: string | null;
  scopes: string[];
  transport: string;
  createdAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  graceUntil: string | null;
  revealCount: number;
  revealable: boolean;
  /** Enumerated lifecycle word the UI renders; never derived in the client. */
  state: CredentialUiState;
}

export interface OwnConnectorAgent {
  id: string;
  handle: string;
  displayName: string | null;
  status: string;
  lastSeenAt: string | null;
  boundTaskId: string | null;
  mintedUnderWarrantId: string | null;
  terminatedAt: string | null;
  credentials: OwnConnectorCredential[];
}

export interface OwnConnector {
  /** The Connector principal (layer 2 of the identity chain). */
  principalId: string;
  handle: string;
  displayName: string | null;
  status: string;
  lastSeenAt: string | null;
  purpose: string | null;
  /** The paired registry row (A17.2: one Connector, one `services` row). */
  service: {
    id: string;
    slug: string;
    name: string;
    /** Verbatim registration text. The client maps it; the server never does. */
    description: string;
    status: string;
    runtimeMode: string;
    createdAt: string | null;
  };
  credentials: OwnConnectorCredential[];
  agents: OwnConnectorAgent[];
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * The credential states, decided in ONE place from the row's own timestamps and
 * evaluated against a single `now` so two credentials in the same response
 * cannot disagree about what time it is.
 *
 * THE ORDER AND THE BOUNDARIES MIRROR `utils/credentialAcceptance.ts:133-143`,
 * which is the predicate that actually decides whether a credential
 * authenticates — revoked, then expiry at `<= now`, then the §7.3 grace
 * watermark at `<= now`. They are written the same way round on purpose: a
 * screen that disagrees with the door is worse than a screen that says nothing.
 *
 * `replaced` is the state this function used to get wrong. A rotated
 * predecessor sits in a grace window and genuinely still works UNTIL
 * `grace_until`; at that instant the door starts answering
 * `CREDENTIAL_GRACE_ELAPSED`. Reporting a non-null `grace_until` as `graced`
 * therefore told a person their credential was "replaced, still working" when
 * it had already stopped working. `graced` now means only the live half of that
 * window, and `replaced` is the dead half.
 *
 * `live` is the residue, never a default guess.
 */
export function credentialState(
  row: { revokedAt: string | null; graceUntil: string | null; expiresAt: string | null },
  now: number,
): CredentialUiState {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && Date.parse(row.expiresAt) <= now) return 'expired';
  if (row.graceUntil) return Date.parse(row.graceUntil) <= now ? 'replaced' : 'graced';
  return 'live';
}

function mapCredential(row: Record<string, unknown>, now: number): OwnConnectorCredential {
  const base = {
    id: String(row.id),
    keyId: row.key_id === null || row.key_id === undefined ? null : String(row.key_id),
    label: row.label === null || row.label === undefined ? null : String(row.label),
    scopes: parseScopes(row.scopes),
    transport: row.transport ? String(row.transport) : 'any',
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    lastUsedAt: iso(row.last_used_at),
    graceUntil: iso(row.grace_until),
    revealCount: Number(row.reveal_count ?? 0),
    revealable: Boolean(row.revealable) && !row.revoked_at && !row.grace_until,
  };
  return { ...base, state: credentialState(base, now) };
}

const CREDENTIAL_COLUMNS = `id, principal_id, key_id, label, scopes, created_at, expires_at,
         revoked_at, last_used_at, reveal_count, grace_until, transport,
         secret_ciphertext IS NOT NULL AS revealable`;

export class OwnConnectorsService {
  /**
   * Every Connector owned by `accountId`, with its credentials and the Agents
   * minted beneath it. Three bounded queries, never one per row.
   */
  async listForAccount(accountId: string, now: number = Date.now()): Promise<OwnConnector[]> {
    const connectorRows = await pool.query(
      `SELECT p.id, p.handle, p.display_name, p.status, p.last_seen_at, p.purpose,
              s.id AS service_id, s.slug, s.name, s.description,
              s.status AS service_status, s.runtime_mode, s.created_at AS service_created_at
         FROM principals p
         JOIN services s ON s.principal_id = p.id
        WHERE p.parent_principal_id = $1
          AND p.kind = 'service'
          AND s.kind = 'connector'
        ORDER BY s.name ASC, s.slug ASC`,
      [accountId],
    );
    if (connectorRows.rows.length === 0) return [];

    const connectorIds = connectorRows.rows.map((row) => String(row.id));
    const agentRows = await pool.query(
      `SELECT id, handle, display_name, status, last_seen_at, parent_principal_id,
              bound_task_id, minted_under_warrant_id, terminated_at
         FROM principals
        WHERE parent_principal_id = ANY($1::uuid[]) AND kind = 'agent'
        ORDER BY created_at DESC`,
      [connectorIds],
    );
    const agentIds = agentRows.rows.map((row) => String(row.id));

    const credentialRows = await pool.query(
      `SELECT ${CREDENTIAL_COLUMNS}
         FROM principal_credentials
        WHERE principal_id = ANY($1::uuid[]) AND credential_type <> 'password'
        ORDER BY created_at DESC`,
      [[...connectorIds, ...agentIds]],
    );

    const credentialsByPrincipal = new Map<string, OwnConnectorCredential[]>();
    for (const row of credentialRows.rows) {
      const key = String(row.principal_id);
      const list = credentialsByPrincipal.get(key) ?? [];
      list.push(mapCredential(row, now));
      credentialsByPrincipal.set(key, list);
    }

    const agentsByConnector = new Map<string, OwnConnectorAgent[]>();
    for (const row of agentRows.rows) {
      const key = String(row.parent_principal_id);
      const list = agentsByConnector.get(key) ?? [];
      list.push({
        id: String(row.id),
        handle: String(row.handle),
        displayName: row.display_name === null ? null : String(row.display_name),
        status: String(row.status),
        lastSeenAt: iso(row.last_seen_at),
        boundTaskId: row.bound_task_id === null ? null : String(row.bound_task_id),
        mintedUnderWarrantId: row.minted_under_warrant_id === null ? null : String(row.minted_under_warrant_id),
        terminatedAt: iso(row.terminated_at),
        credentials: credentialsByPrincipal.get(String(row.id)) ?? [],
      });
      agentsByConnector.set(key, list);
    }

    return connectorRows.rows.map((row) => ({
      principalId: String(row.id),
      handle: String(row.handle),
      displayName: row.display_name === null ? null : String(row.display_name),
      status: String(row.status),
      lastSeenAt: iso(row.last_seen_at),
      purpose: row.purpose === null || row.purpose === undefined ? null : String(row.purpose),
      service: {
        id: String(row.service_id),
        slug: String(row.slug),
        name: String(row.name),
        description: row.description === null || row.description === undefined ? '' : String(row.description),
        status: String(row.service_status),
        runtimeMode: String(row.runtime_mode),
        createdAt: iso(row.service_created_at),
      },
      credentials: credentialsByPrincipal.get(String(row.id)) ?? [],
      agents: agentsByConnector.get(String(row.id)) ?? [],
    }));
  }
}

export const ownConnectorsService = new OwnConnectorsService();
