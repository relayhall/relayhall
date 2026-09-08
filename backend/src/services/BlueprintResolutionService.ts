import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { authorizationRepository } from './AuthorizationRepository';
import { authorizationService } from './AuthorizationService';
import { BlueprintCreationCaller } from './BlueprintInstantiationService';
import { BlueprintPlanContext, BlueprintResolution, BlueprintAuthorityRequirement } from './BlueprintPlanService';
import { requiredScopeFor, type RequiredScope } from '../utils/scopeMap';
import type { PluginRegistryEntry } from './PluginLoader';

type Row = Record<string, any>;
/** Caller-specific resolution queries carry visibility in WHERE, before any
 * registry row, descriptor or Principal field is returned to the builder. */
export class BlueprintResolutionService {
  constructor(private readonly plugins: () => PluginRegistryEntry[]) {}
  context(caller: BlueprintCreationCaller, target: BlueprintPlanContext['target'], client?: PoolClient): BlueprintPlanContext {
    const queryable = client ?? pool;
    const principals = new Map<string, Row>();
    const route = (scope: RequiredScope) => authorizationService.authorizeRoute(caller.actor, scope).allowed;
    const resolve = async (kind: string, name: string, minimum?: number | string, service?: string): Promise<BlueprintResolution | null> => {
      if (kind === 'principal') {
        const permitted = route('principals:read');
        const rows = await queryable.query(`SELECT id,handle,kind,bound_task_id,legacy_identity FROM principals
          WHERE (id::text=$1 OR handle=$1) AND status='active' AND ($2::boolean OR id::text=$3) ORDER BY id LIMIT 2`, [name,permitted,caller.actor.principalId]);
        if (rows.rows.length !== 1) return null;
        const row = rows.rows[0]; principals.set(row.id,row);
        return { kind, name, id: row.id, handle: row.handle };
      }
      if (kind.startsWith('plugin:')) {
        if (!route(requiredScopeFor('GET','/plugins')) || !service) return null;
        const matches=this.plugins().flatMap(plugin => (plugin.blueprintReferences || []).filter(reference =>
          kind === 'plugin:' + plugin.name + ':' + reference.kind && reference.name === name && reference.service === service).map(reference=>({...reference,pluginVersion:plugin.version})));
        if (matches.length !== 1) return null;
        const connector=await resolve('service',service,minimum);
        if (!connector?.descriptor?.tools?.some(tool=>tool.name===matches[0].tool)) return null;
        return {...connector,kind,name,serviceName:service,pluginVersion:matches[0].pluginVersion,tool:matches[0].tool};
      }
      if (kind === 'plugin') {
        // Plugin discovery has no invented Blueprint-specific audience rule.
        if (!route(requiredScopeFor('GET','/plugins'))) return null;
        const matches = this.plugins().filter(plugin => plugin.name === name);
        if (matches.length !== 1) return null;
        const plugin = matches[0];
        if (minimum !== undefined && !this.semverAtLeast(plugin.version,String(minimum))) return null;
        return { kind, name, id: plugin.name, version: plugin.version };
      }
      if (kind === 'tool') {
        if (!service) return null;
        const connector = await resolve('service', service, minimum);
        if (!connector || !connector.descriptor?.tools?.some((tool: Row) => tool.name === name)) return null;
        return { kind, name, id: connector.id, version: connector.version, descriptor:connector.descriptor, serviceName:service };
      }
      if (!['project','phase','skill','personality','service','report','task'].includes(kind)) return null;
      const type = kind as 'project' | 'phase' | 'skill' | 'personality' | 'service' | 'report' | 'task';
      const scope = authorizationRepository.listScope(caller.actor, type, 'read'); const condition = scope.render(2);
      let select: string; let predicate: string; let from = scope.from;
      if (kind === 'task') { select = 't.id,t.title AS name'; predicate = '(t.id::text=$1 OR t.title=$1)'; }
      else if (kind === 'project') { select = 'p.id,p.name'; predicate = '(p.id::text=$1 OR p.name=$1)'; }
      else if (kind === 'report') { select = 'r.id,r.title AS name'; predicate = '(r.id::text=$1 OR r.title=$1)'; }
      else if (kind === 'phase') { select = 'ph.id,ph.name,ph.project_id'; predicate = "(ph.id::text=$1 OR ph.name=$1) AND ph.status <> 'archived'"; }
      else if (kind === 'skill') {
        select = 's.id,s.name,v.version'; from += ' JOIN skill_version_state v ON v.id=s.current_published_version_id';
        predicate = "(s.id::text=$1 OR s.name=$1) AND v.status='published'";
      } else if (kind === 'personality') {
        select = 'pe.id,pe.slug AS name,pv.version';
        from += ' JOIN personality_versions pv ON pv.personality_id=pe.id AND pv.version=pe.current_version';
        predicate = '(pe.id::text=$1 OR pe.slug=$1) AND pe.retired_at IS NULL';
      } else {
        select = 'se.id,se.slug AS name,se.kind AS service_kind,se.current_descriptor_version AS version,d.descriptor';
        from += ' JOIN service_descriptor_versions d ON d.service_id=se.id AND d.version=se.current_descriptor_version';
        predicate = "(se.id::text=$1 OR se.slug=$1) AND se.status='published' AND d.retired_at IS NULL";
      }
      const result = await queryable.query(`SELECT ${select} FROM ${from} WHERE ${predicate} AND ${condition.sql} ORDER BY ${scope.id} LIMIT 2`, [name,...condition.params]);
      if (result.rows.length !== 1) return null;
      const row = result.rows[0];
      // Versioned references resolve their current immutable row. Personality
      // content has committed versions, not a separate publication lifecycle.
      if (minimum !== undefined && (typeof row.version !== 'number' || typeof minimum !== 'number' || row.version < minimum)) return null;
      return { kind, name, id: row.id, version: row.version, projectId: row.project_id, descriptor: row.descriptor, serviceKind: row.service_kind };
    };
    const authorize = async (requirement: BlueprintAuthorityRequirement): Promise<boolean> => {
      if (requirement.operation !== 'project.read' && !route(requirement.scope as RequiredScope)) return false;
      if (requirement.operation === 'project.write') {
        return !!target.projectId && (await authorizationRepository.authorizedIds(caller.actor, 'project', [target.projectId], 'write', queryable)).has(target.projectId);
      }
      if (requirement.operation === 'project.read') {
        if (!target.projectId) return false;
        if (target.mode === 'existing-project') return (await authorizationRepository.authorizedIds(caller.actor,'project',[target.projectId],'read',queryable)).has(target.projectId);
        const shape = authorizationRepository.sqlResource('project');
        if (!caller.actor.principalId || !route('projects:write')) return false;
        const condition = authorizationService.sqlCondition(caller.actor, 'read', shape.resource, 3);
        // Evaluate the SAME canonical predicate against the exact prospective
        // Project and the two approved creator Grants. The CTE shadows only
        // this query's grant relation; it writes nothing, invents no owner and
        // leaves delegation/own()/Agent caps in the canonical SQL unchanged.
        const result = await queryable.query(`WITH grants AS (
          SELECT grantee_type,grantee_id,resource_type,resource_id,verb,expires_at FROM grants
          UNION ALL SELECT 'principal'::text,$2::uuid,'project'::text,$1::uuid,verb,NULL::timestamptz
          FROM unnest(ARRAY['read','write']::text[]) AS verb
        ) SELECT p.id FROM (SELECT $1::uuid AS id,NULL::uuid AS owner_principal_id,'private'::text AS visibility) p WHERE ${condition.sql}`, [target.projectId,caller.actor.principalId,...condition.params]);
        return result.rows.length === 1;
      }
      if (requirement.operation === 'skill.use' || requirement.operation === 'personality.use') {
        const kind=requirement.operation === 'skill.use' ? 'skill' : 'personality';
        return !!requirement.resourceId && (await authorizationRepository.authorizedIds(caller.actor,kind,[requirement.resourceId],'use',queryable)).has(requirement.resourceId);
      }
      if (requirement.operation === 'service.invoke') return !!requirement.resourceId && (await authorizationRepository.authorizedIds(caller.actor,'service',[requirement.resourceId],'invoke',queryable)).has(requirement.resourceId);
      if (requirement.operation === 'task.create' || requirement.operation === 'task.roles') {
        // The canonical predicate applies the Agent task cap and Shepherd
        // act to a new ordinary Task. Its non-UUID marker cannot equal any
        // persisted bound_task_id UUID; creation cannot be the bound Task.
        // It is not owned/claimed.
        const resource = { type: 'task' as const, id: `new-task:${requirement.localKey}`, creatorPrincipalId: caller.actor.principalId, shepherdPrincipalId: caller.actor.principalId };
        if (requirement.operation === 'task.create') {
          const link = caller.actor.delegation?.links[0];
          if (link?.kind === 'agent' && !link.legacyIdentity) return authorizationService.authorizeResource(caller.actor,'write',resource,[]).allowed;
        } else {
          if (!authorizationService.authorizeResource(caller.actor,'shepherd',resource,[]).allowed) return false;
          for (const id of requirement.principalIds || []) {
            const principal = principals.get(id);
            if (!principal || principal.kind === 'agent' && !principal.legacy_identity && principal.bound_task_id) return false;
            // Match the ordinary /tasks/:id/roles act: only a Service
            // Shepherd adds invoke scope; a Verifier does not assign execution.
            if (id === requirement.shepherdPrincipalId && principal.kind === 'service' && !route('services:invoke')) return false;
          }
        }
      }
      return true;
    };
    return { target, resolve, authorize };
  }
  private semverAtLeast(actual: string, minimum: string): boolean {
    if (!/^\d+\.\d+\.\d+$/.test(actual) || !/^\d+\.\d+\.\d+$/.test(minimum)) return false;
    const a=actual.split('.').map(Number), b=minimum.split('.').map(Number);
    for (let i=0;i<3;i++) if (a[i] !== b[i]) return a[i]>b[i];
    return true;
  }
}
