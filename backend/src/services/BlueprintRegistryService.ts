import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { authorizationRepository } from './AuthorizationRepository';
import { authorizationService, type AuthorizationActor, type AuthorizationAction } from './AuthorizationService';
import { auditService, type AuditActor } from './AuditService';
import { BlueprintError, blueprintDigests, validateBlueprintDocument, stableBlueprintJson,
  type BlueprintBodyConfiguration, type BlueprintDocument } from '../utils/blueprintDocument';
import type { RequiredScope } from '../utils/scopeMap';

export interface BlueprintReader {
  actor: AuthorizationActor;
  audit: AuditActor;
  rootSession: boolean;
}
type Queryable = Pick<PoolClient, 'query'>;
export function blueprintScope(caller: BlueprintReader, scope: RequiredScope): boolean {
  return authorizationService.authorizeRoute(caller.actor, scope).allowed;
}
export function requireBlueprintScope(caller: BlueprintReader, scope: RequiredScope): void {
  if (!blueprintScope(caller, scope)) throw new BlueprintError(403, 'SCOPE_REQUIRED', `Required scope: ${scope}`);
}
export function blueprintNotFound(): never { throw new BlueprintError(404, 'BLUEPRINT_NOT_FOUND', 'Blueprint not found'); }
export class BlueprintRegistryService {
  constructor(readonly bodyConfiguration: BlueprintBodyConfiguration) {}

  /** The narrowing is part of this query, including key lookups. No candidate
   * document is read before its caller-specific predicate has admitted it. */
  async resolve(identifier: string, caller: BlueprintReader, action: AuthorizationAction,
    queryable: Queryable = pool, lock = false): Promise<any> {
    const scope = authorizationRepository.listScope(caller.actor, 'blueprint', action);
    const condition = scope.render(2);
    const found = await queryable.query(`SELECT b.* FROM ${scope.from}
      WHERE (b.id::text = $1 OR b.key = $1) AND ${condition.sql} ORDER BY b.id LIMIT 2${lock ? ' FOR UPDATE OF b' : ''}`,
    [identifier, ...condition.params]);
    if (found.rows.length !== 1) return blueprintNotFound();
    return found.rows[0];
  }
  async availableActions(parentId: string, version: any, caller: BlueprintReader): Promise<string[]> {
    const actions: string[] = [];
    const can = async (scope: RequiredScope, action: AuthorizationAction) => blueprintScope(caller, scope)
      && (await authorizationRepository.authorizedIds(caller.actor, 'blueprint', [parentId], action)).has(parentId);
    if (version.status === 'published' && await can('blueprints:use','use')) actions.push('instantiate');
    if (await can('blueprints:write','write')) {
      actions.push('new-version');
      if (version.status === 'draft') actions.push('edit','submit');
      if (version.status === 'review' && version.author_principal_id === caller.actor.principalId) actions.push('withdraw');
    }
    const agent = caller.actor.role === 'agent' || caller.actor.delegation?.links[0]?.kind === 'agent';
    if (!agent && await can('blueprints:admin','admin')) {
      if (version.status === 'review') { actions.push('reject'); if (version.author_principal_id !== caller.actor.principalId) actions.push('publish'); }
      if (version.status === 'published') actions.push('retire');
    }
    if (await can('blueprints:read','read')) {
      actions.push('history','ledger');
      if (['published','retired'].includes(version.status)) actions.push('export');
    }
    return actions;
  }
  async list(caller: BlueprintReader): Promise<any[]> {
    const read = blueprintScope(caller, 'blueprints:read');
    if (!read) requireBlueprintScope(caller, 'blueprints:use');
    const scope = authorizationRepository.listScope(caller.actor, 'blueprint', read ? 'read' : 'use');
    const condition = scope.render(1);
    const found = await pool.query(`SELECT b.id,b.key,b.published_version_id,v.version,v.status,v.author_principal_id,v.document
      FROM ${scope.from} JOIN blueprint_versions v ON v.id=b.published_version_id
      WHERE ${condition.sql} AND v.status='published' ORDER BY b.key`, condition.params);
    const published = found.rows.map(r => ({ id: r.id, key: r.key, version: r.version, status: r.status, authorPrincipalId: read ? r.author_principal_id : undefined, ...this.describe(r.document), projection: read ? 'read' : 'use' }));
    if (!read || !blueprintScope(caller, 'blueprints:write')) return published;
    const writable = authorizationRepository.listScope(caller.actor, 'blueprint', 'write');
    const writeCondition = writable.render(1);
    const drafts = await pool.query(`SELECT b.id,b.key,v.version,v.status,v.author_principal_id,v.document FROM ${writable.from}
      JOIN LATERAL (SELECT version,status,author_principal_id,document FROM blueprint_versions WHERE blueprint_id=b.id ORDER BY version DESC LIMIT 1) v ON true
      WHERE b.published_version_id IS NULL AND ${writeCondition.sql} ORDER BY b.key`, writeCondition.params);
    return [...published, ...drafts.rows.map(r => ({ id: r.id, key: r.key, version: r.version, status: r.status, authorPrincipalId: read ? r.author_principal_id : undefined, ...this.describe(r.document), projection: 'read' }))].sort((a,b) => a.key.localeCompare(b.key));
  }
  describe(document: BlueprintDocument) {
    return { name: document.blueprint.name, summary: document.blueprint.summary, tags: document.blueprint.tags,
      parameters: document.parameters, references: document.references, target: { mode: document.target.mode, ...(document.target.allowExisting === true ? {allowExisting:true} : {}) },
      counts: { phases: document.phases.length, tasks: document.tasks.length + document.humanGates.length,
        reports: document.reports.length, humanGates: document.humanGates.length }, document };
  }
  async get(identifier: string, caller: BlueprintReader, version?: number): Promise<any> {
    const read = blueprintScope(caller, 'blueprints:read'); if (!read) requireBlueprintScope(caller, 'blueprints:use');
    const parent = await this.resolve(identifier, caller, read ? 'read' : 'use');
    const found = version === undefined
      ? await pool.query('SELECT * FROM blueprint_versions WHERE id=$1', [parent.published_version_id])
      : await pool.query('SELECT * FROM blueprint_versions WHERE blueprint_id=$1 AND version=$2', [parent.id, version]);
    const row = found.rows[0]; if (!row) return blueprintNotFound();
    if (!read && row.id !== parent.published_version_id) return blueprintNotFound();
    if (row.status === 'draft' || row.status === 'review') {
      if (!blueprintScope(caller, 'blueprints:write')) return blueprintNotFound();
      await this.resolve(identifier, caller, 'write');
    }
    return { id: parent.id, key: parent.key, version: row.version, status: row.status,
      contentSha256: row.content_sha256, identitySha256: row.identity_sha256,
      ...(read ? { statusNote: row.status_note, authorPrincipalId: row.author_principal_id } : {}),
      ...this.describe(row.document), projection: read ? 'read' : 'use', availableActions: await this.availableActions(parent.id,row,caller) };
  }
  async versions(identifier: string, caller: BlueprintReader) {
    requireBlueprintScope(caller, 'blueprints:read'); const parent = await this.resolve(identifier, caller, 'read');
    let drafts = false;
    if (blueprintScope(caller, 'blueprints:write')) {
      const allowed = await authorizationRepository.authorizedIds(caller.actor, 'blueprint', [parent.id], 'write'); drafts = allowed.has(parent.id);
    }
    return (await pool.query(`SELECT version,status,status_note,content_sha256,identity_sha256,status_changed_at,author_principal_id
      FROM blueprint_versions WHERE blueprint_id=$1 AND ($2 OR status IN ('published','retired')) ORDER BY version DESC`, [parent.id, drafts])).rows;
  }
  async save(caller: BlueprintReader, input: unknown, identifier?: string, editVersion?: number) {
    return this.store(caller,input,identifier,editVersion);
  }
  async importDocument(caller: BlueprintReader, input: unknown, rename?: string) {
    // Design 2.2 preserves every document field except explicit key rename.
    // An imported snapshot reached N in its source history; do not fabricate
    // local predecessor rows or reset N. Ordinary author-time create stays 1.
    return this.store(caller,input,undefined,undefined,rename,true);
  }
  private async store(caller: BlueprintReader, input: unknown, identifier?: string, editVersion?: number, rename?: string, importedSnapshot = false) {
    requireBlueprintScope(caller, 'blueprints:write');
    if (!caller.actor.principalId) throw new BlueprintError(403, 'PRINCIPAL_REQUIRED', 'A resolved Principal is required');
    let document = validateBlueprintDocument(input, this.bodyConfiguration);
    if (rename !== undefined) document = validateBlueprintDocument({ ...document, blueprint: { ...document.blueprint, key: rename } }, this.bodyConfiguration);
    const digest = blueprintDigests(document); const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let parent: any;
      if (identifier) parent = await this.resolve(identifier, caller, 'write', client, true);
      else {
        const inserted = await client.query(`INSERT INTO blueprints(key,created_by_principal_id) VALUES($1,$2)
          ON CONFLICT(key) DO NOTHING RETURNING *`, [document.blueprint.key, caller.actor.principalId]);
        if (!inserted.rows[0]) throw new BlueprintError(409, 'BLUEPRINT_KEY_IN_USE', 'Blueprint key is already in use; choose an explicit rename');
        parent = inserted.rows[0];
      }
      if (document.blueprint.key !== parent.key) throw new BlueprintError(422, 'BLUEPRINT_KEY_MISMATCH', 'Version key must match the Blueprint');
      if (editVersion !== undefined) {
        const current = await client.query('SELECT * FROM blueprint_versions WHERE blueprint_id=$1 AND version=$2 FOR UPDATE', [parent.id, editVersion]);
        if (!current.rows[0]) return blueprintNotFound();
        if (current.rows[0].status !== 'draft') throw new BlueprintError(409, 'BLUEPRINT_VERSION_IMMUTABLE', 'Only a draft version is editable');
        if (document.blueprint.version !== editVersion) throw new BlueprintError(422, 'BLUEPRINT_VERSION_MISMATCH', 'Version number must match');
        await client.query(`UPDATE blueprint_versions SET document=$3,content_sha256=$4,identity_sha256=$5,author_principal_id=$6
          WHERE blueprint_id=$1 AND version=$2`, [parent.id, editVersion, document, digest.contentSha256, digest.identitySha256, caller.actor.principalId]);
      } else {
        const next = await client.query('SELECT COALESCE(MAX(version),0)+1 AS version FROM blueprint_versions WHERE blueprint_id=$1', [parent.id]);
        if (!importedSnapshot && document.blueprint.version !== next.rows[0].version) throw new BlueprintError(422, 'BLUEPRINT_VERSION_MISMATCH', 'Document must carry the next monotonic version');
        await client.query(`INSERT INTO blueprint_versions(blueprint_id,version,document,content_sha256,identity_sha256,author_principal_id)
          VALUES($1,$2,$3,$4,$5,$6)`, [parent.id, document.blueprint.version, document, digest.contentSha256, digest.identitySha256, caller.actor.principalId]);
      }
      await auditService.record({ action: importedSnapshot ? 'blueprint.import' : editVersion ? 'blueprint.version.edit' : 'blueprint.version.create', actor: caller.audit,
        resourceType: 'blueprint', resourceId: parent.id, metadata: { version: document.blueprint.version } }, client);
      await client.query('COMMIT');
      return { id: parent.id, key: parent.key, version: document.blueprint.version, status: 'draft', ...digest };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async transition(identifier: string, version: number, act: 'submit' | 'withdraw' | 'reject' | 'publish' | 'retire', caller: BlueprintReader, note?: string) {
    if (!caller.actor.principalId) throw new BlueprintError(403,'PRINCIPAL_REQUIRED','A resolved Principal is required');
    const admin = ['reject','publish','retire'].includes(act); requireBlueprintScope(caller, admin ? 'blueprints:admin' : 'blueprints:write');
    if (admin && (caller.actor.delegation?.links[0]?.kind === 'agent' || caller.actor.role === 'agent')) throw new BlueprintError(403, 'BLUEPRINT_AGENT_ADMIN_REFUSED', 'Agent-layer principals cannot administer Blueprint publication');
    if (act === 'reject' && (typeof note !== 'string' || !note.trim() || note.length > 2000)) throw new BlueprintError(422, 'BLUEPRINT_NOTE_REQUIRED', 'A rejection note of 1..2000 characters is required');
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); const parent = await this.resolve(identifier, caller, admin ? 'admin' : 'write', client, true);
      const found = await client.query('SELECT * FROM blueprint_versions WHERE blueprint_id=$1 AND version=$2 FOR UPDATE', [parent.id, version]);
      const row = found.rows[0]; if (!row) return blueprintNotFound();
      const required = { submit: 'draft', withdraw: 'review', reject: 'review', publish: 'review', retire: 'published' }[act];
      if (row.status !== required) throw new BlueprintError(409, 'BLUEPRINT_VERSION_STATE', `Required version state: ${required}`);
      if (act === 'publish' && row.author_principal_id === caller.actor.principalId) throw new BlueprintError(403, 'BLUEPRINT_SELF_REVIEW_REFUSED', 'Publication requires independent judgement');
      if (act === 'withdraw' && row.author_principal_id !== caller.actor.principalId) throw new BlueprintError(403, 'BLUEPRINT_AUTHOR_REQUIRED', 'Only the author may withdraw a version');
      validateBlueprintDocument(row.document, this.bodyConfiguration);
      if (act === 'submit' && row.document.tasks.length + row.document.humanGates.length === 0) {
        throw new BlueprintError(422, 'BLUEPRINT_EMPTY_PLAN', 'Add at least one Task before submitting this Blueprint for review', 'tasks');
      }
      let superseded: number | null = null;
      if (act === 'publish') {
        await client.query('UPDATE blueprints SET published_version_id=$2 WHERE id=$1', [parent.id, row.id]);
        if (parent.published_version_id) {
          const previous = await client.query(`UPDATE blueprint_versions SET status='retired',status_note=$2,status_changed_at=now()
            WHERE id=$1 RETURNING version`, [parent.published_version_id, `superseded by version ${version}`]);
          superseded = previous.rows[0]?.version ?? null;
        }
      } else if (act === 'retire') await client.query('UPDATE blueprints SET published_version_id=NULL WHERE id=$1', [parent.id]);
      const status = { submit: 'review', withdraw: 'draft', reject: 'draft', publish: 'published', retire: 'retired' }[act];
      await client.query('UPDATE blueprint_versions SET status=$2,status_note=$3,status_changed_at=now() WHERE id=$1', [row.id, status, note?.trim() || null]);
      await auditService.record({ action: `blueprint.${act}`, actor: caller.audit, resourceType: 'blueprint', resourceId: parent.id,
        metadata: { version, superseded_version: superseded, status } }, client);
      await client.query('COMMIT'); return { id: parent.id, version, status, supersededVersion: superseded };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async export(identifier: string, version: number, caller: BlueprintReader): Promise<string> {
    requireBlueprintScope(caller, 'blueprints:read');
    const result = await this.get(identifier, caller, version);
    if (!['published', 'retired'].includes(result.status)) throw new BlueprintError(409, 'BLUEPRINT_NOT_PUBLISHED', 'Only reviewed published content is exportable');
    return stableBlueprintJson(validateBlueprintDocument(result.document, this.bodyConfiguration));
  }
}
