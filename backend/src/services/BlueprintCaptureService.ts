import { randomUUID } from 'crypto';
import { pool } from '../db/connection';
import { authorizationRepository } from './AuthorizationRepository';
import { BlueprintRegistryService, requireBlueprintScope, type BlueprintReader } from './BlueprintRegistryService';
import { taskManagerDB } from './TaskManagerDB';
import { BLUEPRINT_SCHEMA, BlueprintError, blueprintDigest, currentBlueprintLimits, type BlueprintDocument } from '../utils/blueprintDocument';
import { blueprintReferenceRegistry } from './BlueprintReferenceRegistry';

const unavailable = (): never => { throw new BlueprintError(404, 'BLUEPRINT_CAPTURE_NOT_FOUND', 'The Phase and its complete readable work are unavailable'); };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Capture is a caller-filtered snapshot. A restricted member refuses the whole
 * capture: returning only visible members would silently change the workflow. */
export class BlueprintCaptureService {
  constructor(private readonly registry: BlueprintRegistryService) {}
  async capture(caller: BlueprintReader, input: { phaseId: string; projectId?: string; name?: string; key?: string }) {
    requireBlueprintScope(caller, 'blueprints:write');
    if (!input || !UUID.test(input.phaseId || '') || input.projectId !== undefined && !UUID.test(input.projectId)
      || input.name !== undefined && typeof input.name !== 'string' || input.key !== undefined && typeof input.key !== 'string') {
      throw new BlueprintError(422, 'BLUEPRINT_CAPTURE_INPUT_INVALID', 'Select a Phase and provide a text name/key');
    }
    const client = await pool.connect();
    let document: BlueprintDocument;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const scope = authorizationRepository.listScope(caller.actor, 'phase', 'read');
      const condition = scope.render(2);
      const phase = (await client.query(`SELECT ph.* FROM ${scope.from} WHERE ph.id=$1 AND ${condition.sql}`,
        [input.phaseId, ...condition.params])).rows[0];
      if (!phase || input.projectId && phase.project_id !== input.projectId) return unavailable();
      if (!(await authorizationRepository.authorizedIds(caller.actor, 'project', [phase.project_id], 'read', client)).has(phase.project_id)) return unavailable();
      const project = (await client.query('SELECT name,description,goal FROM projects WHERE id=$1', [phase.project_id])).rows[0];
      const rows = (await client.query('SELECT id FROM tasks WHERE phase_id=$1 ORDER BY created_at,id LIMIT $2',
        [phase.id, currentBlueprintLimits().tasks + 1])).rows;
      if (rows.length > currentBlueprintLimits().tasks) throw new BlueprintError(422, 'BLUEPRINT_CAPTURE_TOO_LARGE', 'The Phase exceeds the Blueprint Task limit');
      const ids = rows.map(row => row.id);
      const readable = await authorizationRepository.authorizedIds(caller.actor, 'task', ids, 'read', client);
      if (readable.size !== ids.length) return unavailable();
      const keys = new Map<string, string>(ids.map((id, index) => [id, 'task-' + (index + 1)]));
      const name = input.name?.trim() || phase.name;
      document = {
        schemaVersion: BLUEPRINT_SCHEMA,
        blueprint: { key: input.key || 'captured-' + randomUUID().replace(/-/g, '').slice(0, 12), name,
          version: 1, summary: '', description: '', tags: [], provenance: caller.actor.role === 'agent' ? 'agent-drafted' : 'human-authored' },
        parameters: [{ key: 'project_name', label: 'New Project name', promptText: 'New Project name', type: 'string', required: true }],
        references: [], target: { mode: 'new-project', allowExisting: true, project: { name: '{{project_name}}',
          ...(project.description ? { description: project.description } : {}), ...(project.goal ? { goal: project.goal } : {}) } },
        phases: [{ key: 'phase-1', name: phase.name, ...(phase.goal ? { goal: phase.goal } : {}), position: 0, status: 'todo' }],
        tasks: [], humanGates: [], dependencies: [], reports: [],
      };
      const addReference = async (kind: string, id: string, taskKey: string, service?: string, descriptorVersion?: number) => {
        const reference = await blueprintReferenceRegistry.capture(kind, id, caller, client, service);
        if (kind==='service' && descriptorVersion !== undefined) {
          const pinned=(await client.query('SELECT version,descriptor FROM service_descriptor_versions WHERE service_id=$1 AND version=$2 AND retired_at IS NULL',[id,descriptorVersion])).rows[0];
          if (!pinned) throw new BlueprintError(422,'BLUEPRINT_CAPTURE_REFERENCE_UNAVAILABLE','The Task Connector descriptor pin is unavailable','executionProfile');
          reference.minVersion=pinned.version;reference.descriptor=pinned.descriptor;
        }
        const prior = document.references.find(row => row.kind === reference.kind && row.name === reference.name && row.service === reference.service);
        if (prior && (prior.minVersion!==reference.minVersion || blueprintDigest(prior.descriptor ?? null)!==blueprintDigest(reference.descriptor ?? null))) {
          throw new BlueprintError(422,'BLUEPRINT_CAPTURE_REFERENCE_CONFLICT','Tasks require different versions of the same portable function; align their pins before capture','references');
        }
        if (prior) prior.usedBy = [...new Set([...(prior.usedBy || []), taskKey])];
        else document.references.push({ ...reference, requirement: 'required', usedBy: [taskKey] });
        return reference.name as string;
      };
      for (const id of ids) {
        const task = await taskManagerDB.getTask(id, client);
        if (!task) return unavailable();
        const key = keys.get(id)!;
        const captured: Record<string, any> = { key, title: task.title, phase: 'phase-1', status: 'todo',
          description: task.description, priority: task.priority, tags: task.tags,
          subtasks: task.subtasks.map(subtask => ({ text: subtask.text })), references: [] };
        for (const field of ['definitionOfDone', 'successCriteria', 'constraints', 'thinking', 'notes'] as const) {
          if (task[field] !== undefined && task[field] !== null) captured[field] = task[field];
        }
        captured.defaults = {};
        if (task.model) captured.defaults.model = task.model;
        if (task.maxRetries !== undefined) captured.defaults.maxRetries = task.maxRetries;
        if (task.personalityId) captured.defaults.personality = await addReference('personality', task.personalityId, key);
        for (const [role, principal] of [['shepherd', task.shepherdPrincipalId], ['verifier', task.verifierPrincipalId]]) {
          if (principal) {
            const name = await addReference('principal', principal, key);
            captured.roles = { ...captured.roles, [role!]: name };
          }
        }
        if (task.executionProfile) {
          const service = await addReference('service', task.executionProfile.serviceId, key, undefined, task.executionProfile.descriptorVersion);
          captured.defaults.executionProfile = { service, options: task.executionProfile.options,
            ...(task.executionProfile.parameters ? {parameters:task.executionProfile.parameters} : {}) };
        }
        if (task.legacyExecutionProfile) throw new BlueprintError(422, 'BLUEPRINT_CAPTURE_UNSUPPORTED', 'Replace the legacy execution profile before capture', 'executionProfile');
        for (const dependency of task.dependsOn || []) if (keys.has(dependency)) document.dependencies.push({ task: key, dependsOn: keys.get(dependency)! });
        const references = (await client.query('SELECT kind,target_id,target_uri,label,metadata FROM task_references WHERE task_id=$1 ORDER BY id', [id])).rows;
        for (const reference of references) {
          if (reference.kind === 'session') continue; // Session state is deliberately never portable.
          if (reference.kind === 'task' && keys.has(reference.target_id)) continue;
          const kind = reference.metadata?.capabilityKind || reference.kind;
          captured.references.push(await addReference(kind, kind==='tool' ? reference.metadata?.toolName || reference.label : reference.target_id || reference.target_uri, key, reference.metadata?.service || (kind==='tool' ? reference.target_id : undefined)));
        }
        for (const link of task.links || []) {
          if (link.type === 'session') continue;
          const match = /^(?:\/dashboard)?\/reports\/([0-9a-f-]{36})$/i.exec(link.url);
          if (link.type === 'report' && match) captured.references.push(await addReference('report', match[1], key));
          else throw new BlueprintError(422, 'BLUEPRINT_CAPTURE_UNSUPPORTED', 'Convert the Task link to a named registry reference before capture', 'links');
        }
        captured.references = [...new Set(captured.references)];
        document.tasks.push(captured);
      }
      // Bound proof evidence belongs to references, never raw runtime rows.
      for (const reference of document.references) if (reference.descriptor) {
        reference.descriptorSha256 = blueprintDigest(reference.descriptor); delete reference.descriptor;
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return this.registry.save(caller, document!);
  }
}
