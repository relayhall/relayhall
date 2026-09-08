import { pool } from '../db/connection';
import { BlueprintReader, requireBlueprintScope, blueprintNotFound, BlueprintRegistryService } from './BlueprintRegistryService';
import { authorizationRepository } from './AuthorizationRepository';
export class BlueprintLedgerService {
  constructor(private readonly registry: BlueprintRegistryService) {}
  private async rows(caller: BlueprintReader, identifier: string, byInstance: boolean) {
    requireBlueprintScope(caller, 'blueprints:read');
    const blueprintScope = authorizationRepository.listScope(caller.actor,'blueprint','read');
    const blueprint = blueprintScope.render(4);
    const projectScope = authorizationRepository.listScope(caller.actor,'project','read');
    const project = projectScope.render(4 + blueprint.params.length);
    return (await pool.query(`SELECT i.id,b.key AS blueprint_key,v.version AS blueprint_version,i.root_project_id,i.actor_principal_id,i.created_at,
      i.parameter_projection,i.reference_outcomes,i.response_snapshot,
      CASE WHEN i.actor_principal_id::text=$2 OR $3::boolean THEN i.parameter_values ELSE NULL END AS parameter_values,
      CASE WHEN i.actor_principal_id::text=$2 OR $3::boolean THEN i.execution_defaults ELSE NULL END AS execution_defaults
      FROM blueprint_instantiations i JOIN blueprints b ON b.id=i.blueprint_id
      JOIN blueprint_versions v ON v.id=i.blueprint_version_id JOIN projects p ON p.id=i.root_project_id
      WHERE ${byInstance ? 'i.id::text=$1' : 'b.id::text=$1'} AND ${blueprint.sql} AND ${project.sql}
      ORDER BY i.created_at DESC,i.id`, [identifier,caller.actor.principalId,caller.rootSession,...blueprint.params,...project.params])).rows;
  }
  async list(identifier: string, caller: BlueprintReader) {
    requireBlueprintScope(caller,'blueprints:read');
    const parent = await this.registry.resolve(identifier,caller,'read');
    return this.rows(caller,parent.id,false);
  }
  async get(identifier: string, caller: BlueprintReader) {
    const rows = await this.rows(caller,identifier,true);
    if (rows.length !== 1) return blueprintNotFound();
    return rows[0];
  }
}
