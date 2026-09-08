/**
 * FeedEventService — RH-P3.C1, the cursor event feed core.
 *
 * Strategy 4e40f06f §2.6: one authoritative "everything since cursor X"
 * mechanism over work objects. Emission happens INSIDE the emitting write's
 * transaction (an event is visible exactly when its object change is), and is
 * serialized with `pg_advisory_xact_lock` so the BIGSERIAL cursor is monotone
 * in COMMIT order — without the lock, two concurrent writers can take cursors
 * 100 and 101 and commit in the other order, and a reader already past 101
 * silently loses 100 forever, which an authoritative feed must never do. The
 * cost is a short critical section per event-emitting transaction; board
 * write rates are human/agent scale, and the trade-off is documented on the
 * migration.
 *
 * Events carry identity and emission-time ownership metadata, never content
 * (authority travels in the pull). Deletion tombstones and ACL-change events
 * are content-free by CHECK constraint. Names are vocabulary §6 dotted
 * `<singular>.<past-tense>`.
 */
import { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { authorizationService, AuthorizationActor } from './AuthorizationService';
import { authorizationRepository } from './AuthorizationRepository';
import type { GrantResourceType } from './GrantService';

export type FeedObjectType = 'task' | 'phase' | 'project' | 'report' | 'skill' | 'personality';

/**
 * The transaction handle an emission rides on — structural, so every service's
 * transaction shape qualifies (pg PoolClient, PhaseService's Queryable). The
 * contract is behavioral: it MUST be the open transaction of the write the
 * event describes.
 */
export interface FeedEmitClient {
  query: (queryText: string, values?: any[]) => Promise<any>;
}

export interface FeedEventInput {
  name: string;
  objectType: FeedObjectType;
  objectId: string;
  actorPrincipalId?: string | null;
  actorHandle?: string | null;
  projectId?: string | null;
  ownerPrincipalId?: string | null;
  /**
   * Emission-time record that the object was visible to every authenticated
   * reader (e.g. a global Skill). Lets the tombstone reach the audience that
   * could see the object while it lived (round 1, F4).
   */
  globallyVisible?: boolean;
  /** Light, content-free extras. Never titles, notes, bodies. */
  payload?: Record<string, unknown>;
}

export interface FeedEvent {
  cursor: string;
  name: string;
  objectType: FeedObjectType;
  objectId: string;
  occurredAt: string;
  actorPrincipalId: string | null;
  actorHandle: string | null;
  projectId: string | null;
  ownerPrincipalId: string | null;
  payload: Record<string, unknown>;
}

const DOTTED = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Object types whose LIVE authorization predicate inherits parent-Project
 * authority (AuthorizationRepository: today Phase alone). Only these may use
 * Project read authorization as a transition-delivery basis — a Task or
 * Report is claimant/author/visibility/grant-scoped, so a parent-Project
 * reader was never entitled to a private child, and its tombstone must stay
 * concealed: content-free is not identity-free (round 4, F1).
 */
const PROJECT_INHERITING_TYPES: ReadonlySet<string> = new Set(['phase']);

export class FeedEventService {
  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * Resolve a verified-identity string (a principal UUID or a handle such as
   * 'service_account') to the principal UUID the feed's owner_principal_id
   * column requires. String SHAPE is never trusted as identity: handles may
   * themselves be UUID-shaped, so a UUID-shaped value must first PROVE a
   * matching principals.id, and otherwise resolves like any other handle —
   * guessing from shape would deliver one principal's transition metadata to
   * whoever owns the colliding UUID (round 2, F1). Unknown values record
   * NULL; provenance stays on the emitting row. The lookup MUST ride the
   * emitting write's own transaction client.
   */
  async resolveOwnerPrincipalUuid(
    client: FeedEmitClient,
    actorId: string | null | undefined,
  ): Promise<string | null> {
    if (!actorId) return null;
    if (UUID_SHAPE.test(actorId)) {
      const byId = await client.query('SELECT id FROM principals WHERE id = $1', [actorId]);
      if (byId.rows[0]?.id) return byId.rows[0].id;
    }
    const byHandle = await client.query('SELECT id FROM principals WHERE handle = $1', [actorId]);
    return byHandle.rows[0]?.id ?? null;
  }

  /**
   * Append one event inside the caller's transaction. The caller MUST pass
   * the transaction client of the write the event describes — emitting on the
   * pool would let the event commit while the write rolls back (or vice
   * versa), and the feed would lie.
   */
  async emit(client: FeedEmitClient, event: FeedEventInput): Promise<void> {
    if (!DOTTED.test(event.name)) {
      throw new Error(`Feed event name must be dotted <singular>.<past-tense>: ${event.name}`);
    }
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('feed_events'))`);
    await client.query(
      `INSERT INTO feed_events
         (name, object_type, object_id, actor_principal_id, actor_handle,
          project_id, owner_principal_id, globally_visible, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.name,
        event.objectType,
        event.objectId,
        event.actorPrincipalId ?? null,
        event.actorHandle ?? null,
        event.projectId ?? null,
        event.ownerPrincipalId ?? null,
        event.globallyVisible === true,
        JSON.stringify(event.payload ?? {}),
      ],
    );
  }

  /**
   * The feed read: everything after `cursor`, grant-scoped against the
   * CALLING principal at query time (strategy §2.6.2 — every consumer, not
   * only ingesters).
   *
   * Authorization is two-tier because tombstones must outlive their objects
   * ("delivered only to parties entitled to the object either before or
   * after the change"):
   *   1. an id-INDEPENDENT reader (root/administrator — the probe carries no
   *      principal fields, so no id-specific basis can fire) sees everything;
   *   2. a scoped reader sees an ORDINARY lifecycle event iff the LIVE object
   *      authorizes read for them right now (the shared batched predicate) —
   *      current-state authorization only, so a former owner learns nothing
   *      after a transfer or revocation (round 1, F3). TRANSITION events
   *      (deletion tombstones, ACL changes — content-free by constraint)
   *      additionally accept the event's emission-time metadata: the recorded
   *      entitlement principal (owner, or the grantee an ACL change affected
   *      — round 2, F3), a CURRENT grant covering (object_type, object_id) exactly
   *      or by typed-NULL wildcard, CURRENT read authorization on the
   *      recorded parent Project for object types whose live predicate
   *      inherits Project authority (Phase — round 4, F1), or the recorded
   *      globally-visible flag for any authenticated reader (shared Skills) —
   *      all evaluated even when the object row is gone (round 1, F4).
   *      Per-consumer delivered-set tracking stays a named, unimplemented
   *      seam (C5 ruling).
   */
  async listSince(
    actor: AuthorizationActor,
    cursor: string | number,
    limit = 200,
  ): Promise<{ events: FeedEvent[]; nextCursor: string }> {
    const after = String(cursor ?? '0').match(/^\d+$/) ? String(cursor) : '0';
    const pageSize = Math.min(Math.max(Number(limit) || 200, 1), 500);

    const result = await this.pool.query(
      `SELECT cursor, name, object_type, object_id, occurred_at,
              actor_principal_id, actor_handle, project_id, owner_principal_id,
              globally_visible, payload
         FROM feed_events
        WHERE cursor > $1::bigint
        ORDER BY cursor
        LIMIT $2`,
      [after, pageSize],
    );
    const rows = result.rows;
    const nextCursor = rows.length > 0 ? String(rows[rows.length - 1].cursor) : after;

    const blanket = authorizationService.authorizeResource(
      actor, 'read', { type: 'task', id: '00000000-0000-4000-8000-000000000000' }, [],
    ).allowed;
    const visible = blanket ? rows : await this.scopeRows(actor, rows);

    return {
      events: visible.map((row: any) => ({
        cursor: String(row.cursor),
        name: row.name,
        objectType: row.object_type,
        objectId: row.object_id,
        occurredAt: row.occurred_at,
        actorPrincipalId: row.actor_principal_id,
        actorHandle: row.actor_handle,
        projectId: row.project_id,
        ownerPrincipalId: row.owner_principal_id,
        payload: row.payload ?? {},
      })),
      nextCursor,
    };
  }

  /**
   * A transition event is the pair the contract makes DELIVERABLE past the
   * object's life: content-free deletion tombstones and ACL changes. Only
   * these may use the emission-time metadata bases below — an ordinary
   * lifecycle row is authorized by the object's CURRENT state alone, so a
   * former owner learns nothing after a transfer or revocation (round 1, F3).
   */
  private static isTransitionEvent(name: string): boolean {
    return name.endsWith('.deleted') || name.endsWith('.acl_changed');
  }

  private async scopeRows(actor: AuthorizationActor, rows: any[]): Promise<any[]> {
    if (rows.length === 0) return rows;

    // Tier 1: live-object authorization, one batched query per object type —
    // the ONLY basis for ordinary lifecycle events.
    const byType = new Map<GrantResourceType, string[]>();
    for (const row of rows) {
      const ids = byType.get(row.object_type) ?? [];
      ids.push(String(row.object_id));
      byType.set(row.object_type, ids);
    }
    const liveAllowed = new Set<string>();
    await Promise.all([...byType.entries()].map(async ([type, ids]) => {
      const allowed = await authorizationRepository.authorizedIds(actor, type, ids, 'read');
      for (const id of allowed) liveAllowed.add(`${type}:${id}`);
    }));

    // Tier 2 (TRANSITION EVENTS ONLY): emission-time metadata — the recorded
    // entitlement principal (the object's owner, or for ACL transitions the
    // principal whose entitlement the change affected, e.g. a revoked
    // grantee — round 2, F3), a CURRENT grant on the object (exact or
    // typed-NULL wildcard), CURRENT authorization on the recorded parent
    // Project for PROJECT-INHERITING object types only (round 1 F4, bounded
    // by round 4 F1), or the recorded fact that the object was visible to
    // every authenticated reader (shared Skills).
    const residue = rows.filter(
      (row) => FeedEventService.isTransitionEvent(String(row.name))
        && !liveAllowed.has(`${row.object_type}:${row.object_id}`),
    );

    const grantAllowed = new Set<string>();
    const projectAllowed = new Set<string>();
    if (residue.length > 0 && actor.principalId) {
      const types = [...new Set(residue.map((row) => String(row.object_type)))];
      const ids = [...new Set(residue.map((row) => String(row.object_id)))];
      const grants = await this.pool.query(
        `SELECT resource_type, resource_id
           FROM grants
          WHERE ((grantee_type = 'principal' AND grantee_id = $1)
             OR (grantee_type = 'group' AND grantee_id IN (
                  SELECT gm.group_id FROM group_members gm
                    JOIN principals mp ON mp.id = gm.account_principal_id AND mp.status = 'active'
                   WHERE gm.account_principal_id = $1)))
            AND verb = 'read'
            AND (expires_at IS NULL OR expires_at > now())
            AND resource_type = ANY($2::text[])
            AND (resource_id IS NULL OR resource_id = ANY($3::uuid[]))`,
        [actor.principalId, types, ids],
      );
      for (const grant of grants.rows) {
        grantAllowed.add(
          grant.resource_id === null
            ? `${grant.resource_type}:*`
            : `${grant.resource_type}:${grant.resource_id}`,
        );
      }
    }
    const residueProjects = [...new Set(residue
      .filter((row) => PROJECT_INHERITING_TYPES.has(String(row.object_type)))
      .map((row) => row.project_id).filter(Boolean).map(String))];
    if (residueProjects.length > 0) {
      const allowedProjects = await authorizationRepository.authorizedIds(
        actor, 'project', residueProjects, 'read',
      );
      for (const id of allowedProjects) projectAllowed.add(id);
    }

    return rows.filter((row) => {
      const key = `${row.object_type}:${row.object_id}`;
      if (liveAllowed.has(key)) return true;
      if (!FeedEventService.isTransitionEvent(String(row.name))) return false;
      if (row.globally_visible === true && actor.authenticated) return true;
      if (actor.principalId && row.owner_principal_id
        && String(row.owner_principal_id) === String(actor.principalId)) return true;
      if (PROJECT_INHERITING_TYPES.has(String(row.object_type))
        && row.project_id && projectAllowed.has(String(row.project_id))) return true;
      return grantAllowed.has(key) || grantAllowed.has(`${row.object_type}:*`);
    });
  }
}

export const feedEventService = new FeedEventService();
