import type { PluginRegistryEntry } from './PluginLoader';
import type { PoolClient } from 'pg';
import type { BlueprintReader } from './BlueprintRegistryService';
import { authorizationService } from './AuthorizationService';
import { authorizationRepository } from './AuthorizationRepository';
import { BlueprintError } from '../utils/blueprintDocument';
import type { GrantResourceType } from './GrantService';

type Reference = Record<string, any>;
export interface BlueprintReferenceAdapter {
  kind: string;
  capture(id: string, caller: BlueprintReader, client: PoolClient, service?: string): Promise<Reference | null>;
}
/** Server-owned extension point. Capture enumerates the installed adapters;
 * plugins can register a namespaced kind without modifying capture itself. */
class BlueprintReferenceRegistry {
  private plugins: () => PluginRegistryEntry[] = () => [];
  usePlugins(plugins: () => PluginRegistryEntry[]): void { this.plugins = plugins; }
  private readonly adapters = new Map<string, BlueprintReferenceAdapter>();
  register(adapter: BlueprintReferenceAdapter): void {
    if (this.adapters.has(adapter.kind)) throw new Error('Duplicate portable reference kind');
    this.adapters.set(adapter.kind, adapter);
  }
  kinds(): string[] { return [...new Set([...this.adapters.keys(), ...this.plugins().flatMap(plugin =>
    (plugin.blueprintReferences || []).map(reference => 'plugin:' + plugin.name + ':' + reference.kind))])]; }
  async capture(kind: string, id: string, caller: BlueprintReader, client: PoolClient, service?: string): Promise<Reference> {
    if (kind.startsWith('plugin:') && this.kinds().includes(kind)) {
      const matches = this.plugins().flatMap(plugin => (plugin.blueprintReferences || []).filter(reference =>
        kind === 'plugin:' + plugin.name + ':' + reference.kind && (id === reference.name || id === 'urn:relayhall:' + kind + ':' + reference.name))
        .map(reference => ({plugin, reference})));
      if (matches.length === 1) {
        const {plugin,reference} = matches[0];
        // Derive the function from the installed registry, never from a Task's label.
        const scope = authorizationRepository.listScope(caller.actor,'service','read'); const condition=scope.render(2);
        const rows=(await client.query(`SELECT se.id FROM ${scope.from} WHERE se.slug=$1 AND ${condition.sql}`,[reference.service,...condition.params])).rows;
        if (rows.length === 1) {
          const connector = await this.capture('service',rows[0].id,caller,client);
          if (connector.descriptor?.tools?.some((tool: any)=>tool.name===reference.tool)) {
            return {kind,name:reference.name,service:reference.service,tool:reference.tool,pluginVersion:plugin.version,
              minVersion:connector.minVersion,descriptor:connector.descriptor};
          }
        }
      }
      throw new BlueprintError(422,'BLUEPRINT_CAPTURE_REFERENCE_UNAVAILABLE','The linked plugin function is unavailable','references');
    }
    const adapter = [...this.adapters.values()].find(item => item.kind === kind);
    const reference = adapter && await adapter.capture(id, caller, client, service);
    if (!reference) throw new BlueprintError(422, 'BLUEPRINT_CAPTURE_REFERENCE_UNAVAILABLE', 'A linked ' + kind + ' cannot be captured as a visible portable registry reference', 'references');
    return { kind, ...reference };
  }
}
export const blueprintReferenceRegistry = new BlueprintReferenceRegistry();
const resources: Array<{ kind: GrantResourceType; select: string; extra?: string; predicate?: string }> = [
  { kind: 'skill', select: 's.name,v.version AS "minVersion"', extra: ' JOIN skill_version_state v ON v.id=s.current_published_version_id', predicate: "v.status='published'" },
  { kind: 'personality', select: 'pe.slug AS name,pe.current_version AS "minVersion"', predicate: 'pe.retired_at IS NULL' },
  { kind: 'service', select: 'se.slug AS name,se.current_descriptor_version AS "minVersion",d.descriptor', extra: ' JOIN service_descriptor_versions d ON d.service_id=se.id AND d.version=se.current_descriptor_version', predicate: "se.status='published' AND d.retired_at IS NULL" },
  { kind: 'report', select: 'r.title AS name' },
  { kind: 'task', select: 't.title AS name' },
  { kind: 'phase', select: 'ph.name' },
  { kind: 'project', select: 'p.name' },
];
for (const resource of resources) blueprintReferenceRegistry.register({
  kind: resource.kind,
  async capture(id, caller, client) {
    const scope = authorizationRepository.listScope(caller.actor, resource.kind, 'read');
    const condition = scope.render(2);
    const result = await client.query(`SELECT ${resource.select} FROM ${scope.from}${resource.extra || ''} WHERE ${scope.id}::text=$1 AND ${condition.sql} AND (${resource.predicate || 'TRUE'})`, [id, ...condition.params]);
    return result.rows.length === 1 ? result.rows[0] : null;
  },
});
blueprintReferenceRegistry.register({ kind: 'principal', async capture(id, caller, client) {
  if (!authorizationService.authorizeRoute(caller.actor,'principals:read').allowed && caller.actor.principalId !== id) return null;
  const rows = (await client.query("SELECT handle AS name FROM principals WHERE id::text=$1 AND status='active'", [id])).rows;
  return rows.length === 1 ? rows[0] : null;
} });

blueprintReferenceRegistry.register({kind:'tool',async capture(name,caller,client,service){
  if (!service) return null;
  const scope=authorizationRepository.listScope(caller.actor,'service','read');const condition=scope.render(2);
  const rows=(await client.query(`SELECT se.id FROM ${scope.from} WHERE (se.id::text=$1 OR se.slug=$1) AND ${condition.sql}`,[service,...condition.params])).rows;
  if(rows.length!==1)return null;
  const connector=await blueprintReferenceRegistry.capture('service',rows[0].id,caller,client);
  if(!connector.descriptor?.tools?.some((tool:any)=>tool.name===name))return null;
  return {name,service:connector.name,minVersion:connector.minVersion,descriptor:connector.descriptor};
}});
