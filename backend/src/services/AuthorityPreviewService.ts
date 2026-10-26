import { pool } from '../db/connection';
import type { AuthRequest } from '../middleware/auth';
import { actorFromRequest } from '../middleware/sharedAuthorization';
import { authorizationRepository } from './AuthorizationRepository';
import { AUTHORIZATION_ACTIONS, authorizationService, type AuthorizationActor } from './AuthorizationService';
import { accessProfileService } from './AccessProfileService';
import { delegationService, boundAgentContextIsLive } from './DelegationService';
import { scopesForRole } from '../utils/identityScopes';
import { scopesSatisfy } from '../utils/scopeMap';
import { verifierTaskActAllowed } from './ExplicitTaskActionCaps';
import { RequestFaultError } from '../utils/httpErrors';

export const PREVIEW_TYPES = ['task', 'phase', 'project', 'report', 'skill', 'personality', 'service'] as const;
export type PreviewType = typeof PREVIEW_TYPES[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The preview's refusals. Status, code and message are developer-authored
 * literals at every throw site in this file, so they ride the reviewed
 * RequestFaultError contract (routes guard on that approved class). */
export class AuthorityPreviewError extends RequestFaultError {}
export interface PreviewOptions { resourceType: PreviewType; limit: number; after?: string }
export function previewOptions(query: Record<string, unknown>): PreviewOptions {
  const resourceType = query.resourceType ?? 'task';
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!PREVIEW_TYPES.includes(resourceType as PreviewType) || !Number.isInteger(limit) || limit < 1 || limit > 50
    || (query.after !== undefined && (typeof query.after !== 'string' || !UUID.test(query.after)))) {
    throw new AuthorityPreviewError(400, 'INVALID_PREVIEW_QUERY', 'Use a supported resourceType, limit 1–50 and an exact UUID after cursor');
  }
  return { resourceType: resourceType as PreviewType, limit, ...(query.after ? { after: String(query.after).toLowerCase() } : {}) };
}

/** A projection of the live SQL predicate, never an independent grant engine.
 * Sources below are the arms returned by that exact invocation. No row titles,
 * foreign identities, SQL or secret credential material leave this service. */
export class AuthorityPreviewService {
  async self(req: AuthRequest, options: PreviewOptions) {
    return this.preview(req.principal!.id, req.credentialId, options, actorFromRequest(req));
  }

  async preview(principalId: string, credentialId: string | undefined, options: PreviewOptions, presenting?: AuthorizationActor) {
    if (!UUID.test(principalId) || (credentialId !== undefined && !UUID.test(credentialId))) {
      throw new AuthorityPreviewError(400, 'INVALID_PREVIEW_QUERY', 'principalId and credentialId must be exact UUIDs');
    }
    const chain = await delegationService.resolveChain(principalId);
    const principal = chain.links[0];
    const inventory = await accessProfileService.effectiveAccess(principalId);
    const credentials = await pool.query(
      `SELECT id,scopes,transport,expires_at,revoked_at,grace_until,
        (revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
          AND (grace_until IS NULL OR grace_until>clock_timestamp())) AS live
       FROM principal_credentials WHERE principal_id=$1 ORDER BY id LIMIT 51`, [principalId]);
    const credential = credentialId ? credentials.rows.find(row => row.id === credentialId) : undefined;
    // A selected id can lie beyond the bounded key list; validate it separately.
    const selected = credential ?? (credentialId ? (await pool.query(
      `SELECT id,scopes,transport,expires_at,
        (revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
          AND (grace_until IS NULL OR grace_until>clock_timestamp())) AS live
       FROM principal_credentials WHERE principal_id=$1 AND id=$2`, [principalId, credentialId])).rows[0] : undefined);
    if (credentialId && !selected) throw new AuthorityPreviewError(404, 'NOT_FOUND', 'Credential not found for this identity');
    const needsCredential = Boolean(principal.parentPrincipalId && !presenting && !credentialId);
    const account = chain.links[chain.links.length - 1];
    const scopes = selected
      ? delegationService.effectiveScopes(chain, selected.scopes, scopesForRole(account.role))
      : presenting ? presenting.scopes ?? [] : scopesForRole(principal.role);
    const alive = chain.alive && (!selected || selected.live === true) && !needsCredential
      && (principal.legacyIdentity || await boundAgentContextIsLive(principal));
    const actor: AuthorizationActor = {
      principalId, handle: presenting?.handle ?? principalId, role: principal.role,
      scopes, authenticated: alive,
      delegation: chain.links.length > 1 ? { links: chain.links } : null,
    };
    const family = options.resourceType === 'personality' ? 'personalities' : `${options.resourceType}s`;
    const decisions = AUTHORIZATION_ACTIONS.filter(action => scopesSatisfy(scopes,
      `${family}:${action === 'read' ? 'read' : action === 'admin' ? 'admin' : action === 'use' ? 'use' : action === 'invoke' ? 'invoke' : 'write'}` as any))
      .filter(action => options.resourceType !== 'task' || action === 'read'
        || verifierTaskActAllowed(principal, {type:'task',action,identifier:principal.boundTaskId ?? ''}))
      .map(action => ({ action, ...authorizationService.sqlCondition(actor, action,
        authorizationRepository.sqlResource(options.resourceType).resource, 1, { includeSources: true }) }));
    const { from, resource } = authorizationRepository.sqlResource(options.resourceType);
    const params: unknown[] = [];
    const columns: string[] = [];
    const allowed: string[] = [];
    const bySql = new Map<string, string>();
    const columnFor = (sql: string): string => {
      const existing = bySql.get(sql);
      if (existing) return existing;
      const name = `predicate_${columns.length}`;
      columns.push(`COALESCE((${sql}),FALSE) AS ${name}`); bySql.set(sql, name);
      return name;
    };
    const expressions = decisions.map(decision => {
      const offset = params.length;
      const shift = (sql: string) => sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
      params.push(...decision.params);
      allowed.push(shift(decision.sql));
      const traced = (decision.sources ?? []).map(source => ({ ...source, column: columnFor(shift(source.sql)) }));
      const sources = traced.map(source => {
        const gate = source.gate ? traced.find(entry => entry.basis === source.gate)?.column ?? 'FALSE' : 'TRUE';
        return `CASE WHEN ${source.column} AND ${gate} THEN '${source.basis}'::text END`;
      });
      return `CASE WHEN ${columnFor(shift(decision.sql))} THEN jsonb_build_object('action','${decision.action}',
        'sources',to_jsonb(array_remove(ARRAY[${sources.length ? sources.join(',') : 'NULL::text'}],NULL))) END`;
    });
    params.push(options.after ?? null, options.limit + 1);
    const cursor = `$${params.length - 1}`, limit = `$${params.length}`;
    const client = await pool.connect();
    let rows;
    try {
      await client.query('BEGIN READ ONLY');
      // Large source projections otherwise pay JIT compilation once per read.
      // Local planner settings are transaction-scoped, never pool-global state.
      await client.query("SET LOCAL jit=off; SET LOCAL statement_timeout='5000ms'");
      rows = await client.query(
        `WITH permitted AS MATERIALIZED (SELECT ${resource.id}::text AS id FROM ${from}
          WHERE (${cursor}::uuid IS NULL OR ${resource.id}>${cursor}::uuid)
            AND (${allowed.join(' OR ') || 'FALSE'})
            ${options.resourceType === 'report' ? 'AND r.deleted_at IS NULL' : ''}
          ORDER BY ${resource.id} LIMIT ${limit}),
        predicates AS MATERIALIZED (SELECT ${resource.id}::text AS id${columns.length ? ',' + columns.join(',') : ''}
          FROM ${from} WHERE ${resource.id}::text IN (SELECT id FROM permitted)), preview AS (SELECT id,
          array_remove(ARRAY[${expressions.length ? expressions.join(',') : 'NULL::jsonb'}],NULL) AS actions FROM predicates)
        SELECT id,actions FROM preview WHERE cardinality(actions)>0 AND (${cursor}::uuid IS NULL OR id::uuid>${cursor}::uuid)
        ORDER BY id LIMIT ${limit}`, params);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    const page = rows.rows.slice(0, options.limit);
    return {
      ...inventory,
      grants: inventory.grants.slice(0, 50), profiles: inventory.profiles.slice(0, 50),
      inventoryTruncated: inventory.grants.length > 50 || inventory.profiles.length > 50,
      evaluatedAt: new Date().toISOString(), mode: presenting ? 'self' : 'what-if',
      needsCredential,
      credentials: presenting ? undefined : credentials.rows.slice(0, 50).map(row => ({
        id: row.id, live: row.live, transport: row.transport, expiresAt: row.expires_at,
      })),
      credentialsTruncated: !presenting && credentials.rows.length > 50,
      envelope: { alive, scopes, credentialId: selected?.id ?? null, transport: selected?.transport ?? (presenting ? 'session-or-legacy' : 'login-session'),
        expiresAt: selected?.expires_at ?? null,
        chain: chain.links.map(link => ({ principalId: link.principalId, kind: link.kind, status: link.status,
          ownScopes: link.ownExpression?.scopes ?? null,
          objectCap: link.ownExpression?.objects === 'parent' ? 'parent' : link.ownExpression?.objects ? 'explicit' : 'absent',
          boundTaskId: link.boundTaskId, boundTaskRole: link.boundTaskRole ?? null })),
      },
      resourceType: options.resourceType,
      resources: page.map(row => ({ id: row.id, actions: row.actions.map((action: { action: string; sources: string[] }) =>
        ({ ...action, sources: [...new Set(action.sources)] })) })),
      hasMore: rows.rows.length > options.limit,
      nextCursor: rows.rows.length > options.limit ? page[page.length - 1].id : null,
      semantics: 'Current object-predicate actions within the scope ceiling. Transport pins, task state, step-up and handler-specific conditions still gate each real act. Stored sources are inventory, not a permission promise.',
    };
  }
}
export const authorityPreviewService = new AuthorityPreviewService();
