import { validateConnectorProfile } from '../utils/executionProfile';
import type { AuthorizedProjectTarget } from '../middleware/sharedAuthorization';
import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/connection';
import { runCreationTransaction } from '../db/creationTransaction';
import type { TaskActor } from './TaskHistoryService';
import { BlueprintRegistryService, BlueprintReader, requireBlueprintScope, blueprintNotFound } from './BlueprintRegistryService';
import { authorizationRepository } from './AuthorizationRepository';
import { buildBlueprintPlan, enforceBlueprintPlan, blueprintRequestHash, BlueprintPlanContext } from './BlueprintPlanService';
import { validateBlueprintValues, blueprintDigest, BlueprintError, type BlueprintDocument } from '../utils/blueprintDocument';
import { projectService } from './ProjectService';
import { phaseService } from './PhaseService';
import { taskManagerDB } from './TaskManagerDB';
import { taskElementService } from './TaskElementService';
import { reportManager } from './ReportManager';
import { blueprintProvenanceService } from './BlueprintProvenanceService';
import { auditService } from './AuditService';

type Row = Record<string, any>;
export interface BlueprintInstantiationInput {
  target: { mode: 'new-project' | 'existing-project'; project?: string };
  parameterValues: Row;
}
export interface BlueprintCreationCaller extends BlueprintReader { taskActor: TaskActor }
export type BlueprintPlanContextFactory = (caller: BlueprintCreationCaller,
  target: BlueprintPlanContext['target'], client?: PoolClient) => BlueprintPlanContext;

/** No request version selector: the locked parent supplies the published head,
 * while a committed retry pins its original version. Registry/ledger SQL lives
 * here; object SQL remains behind the ordinary canonical writers. */
export class BlueprintInstantiationService {
  constructor(private readonly registry: BlueprintRegistryService, private readonly context: BlueprintPlanContextFactory) {}

  private validateInput(input: BlueprintInstantiationInput): void {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['target','parameterValues'].includes(key))
      || !input.target || typeof input.target !== 'object' || Array.isArray(input.target)
      || Object.keys(input.target).some(key => !['mode','project'].includes(key))
      || !['new-project','existing-project'].includes(input.target.mode)
      || input.target.mode === 'existing-project' && (typeof input.target.project !== 'string' || !input.target.project)
      || input.target.mode === 'new-project' && input.target.project !== undefined) {
      throw new BlueprintError(422, 'BLUEPRINT_INPUT_INVALID', 'A target mode and parameterValues are required');
    }
  }
  private async target(identifier: string, caller: BlueprintReader, client?: PoolClient, lock = false): Promise<Row> {
    const scope = authorizationRepository.listScope(caller.actor, 'project', 'read'); const condition = scope.render(2);
    const result = await (client ?? pool).query(`SELECT p.id,p.status FROM ${scope.from}
      WHERE (p.id::text=$1 OR p.name=$1) AND ${condition.sql} ORDER BY p.id LIMIT 2${lock ? ' FOR UPDATE OF p' : ''}`, [identifier,...condition.params]);
    if (result.rows.length !== 1) throw new BlueprintError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    return result.rows[0];
  }
  private activeTarget(target: Row): void {
    if (target.status === 'archived') throw new BlueprintError(409, 'PROJECT_ARCHIVED', 'Project is archived');
  }
  private requirePublished(version: Row | undefined): asserts version is Row {
    if (!version || version.status !== 'published') throw new BlueprintError(409, 'BLUEPRINT_NOT_PUBLISHED', 'Blueprint has no published version');
  }
  async preview(identifier: string, input: BlueprintInstantiationInput, caller: BlueprintCreationCaller) {
    requireBlueprintScope(caller, 'blueprints:use'); this.validateInput(input);
    const target = input.target.mode === 'existing-project' ? await this.target(input.target.project!, caller) : null;
    const parent = await this.registry.resolve(identifier, caller, 'use');
    const version = (await pool.query('SELECT * FROM blueprint_versions WHERE id=$1', [parent.published_version_id])).rows[0];
    this.requirePublished(version);
    const plan = await buildBlueprintPlan(version.document, input.parameterValues, this.registry.bodyConfiguration,
      this.context(caller, { mode: input.target.mode, projectId: target?.id ?? uuidv4() }));
    return { blueprint: { id: parent.id, key: parent.key, version: version.version }, plan, targetArchived: target?.status === 'archived' };
  }
  async instantiate(identifier: string, input: BlueprintInstantiationInput, key: unknown, caller: BlueprintCreationCaller) {
    // This check precedes even connection acquisition.
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) throw new BlueprintError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header of 16..128 characters is required');
    requireBlueprintScope(caller, 'blueprints:use'); this.validateInput(input);
    if (!caller.actor.principalId || caller.taskActor.principalId !== caller.actor.principalId || caller.audit.principalId !== caller.actor.principalId) throw new BlueprintError(403, 'PRINCIPAL_REQUIRED', 'A single resolved caller is required');
    let admittedBlueprintId: string | undefined;
    return runCreationTransaction(pool, caller.taskActor, async transaction => {
      const client = transaction.client;
      const target = input.target.mode === 'existing-project' ? await this.target(input.target.project!, caller, client, true) : null;
      if (target) this.activeTarget(target);
      // Parent row lock serializes publish and retry-key contenders before
      // either can create rows; no process-local idempotency lock is used.
      const parent = await this.registry.resolve(identifier, caller, 'use', client, true);
      admittedBlueprintId = parent.id;
      const existing = (await client.query('SELECT * FROM blueprint_instantiation_requests WHERE caller=$1 AND blueprint_id=$2 AND idempotency_key=$3', [caller.actor.principalId,parent.id,key])).rows[0];
      const versionId = existing?.blueprint_version_id ?? parent.published_version_id;
      if (!versionId) this.requirePublished(undefined);
      const version = (await client.query('SELECT * FROM blueprint_versions WHERE id=$1 AND blueprint_id=$2', [versionId,parent.id])).rows[0];
      if (!version) return blueprintNotFound();
      const document = version.document as BlueprintDocument;
      // Runtime credential screening and defaults precede hash/substitution.
      const values = validateBlueprintValues(document, input.parameterValues, input.target.mode);
      const canonicalTarget = { mode: input.target.mode, ...(target ? { projectId: target.id } : {}) };
      const hash = blueprintRequestHash(version.id, canonicalTarget, values);
      if (existing) {
        if (hash !== existing.request_hash) throw new BlueprintError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with different input');
        const root = await this.target(existing.response_snapshot.projectId, caller, client, true);
        this.activeTarget(root);
        return existing.response_snapshot;
      }
      this.requirePublished(version);
      const allocatedProjectId = target?.id ?? uuidv4();
      const plan = await buildBlueprintPlan(document, values, this.registry.bodyConfiguration, this.context(caller, { ...canonicalTarget, projectId: allocatedProjectId }, client));
      enforceBlueprintPlan(plan);
      // The same descriptor validator as the manual task route runs before
      // any canonical object write, after invoke authority is admitted.
      for (const task of plan.tasks) if (task.executionProfile) task.executionProfile = await validateConnectorProfile(task.executionProfile);
      const created: { projectId: string; phases: Record<string,string>; tasks: Record<string,string>; reports: Record<string,string> } = {
        projectId: target?.id ?? '', phases: {}, tasks: {}, reports: {},
      };
      if (plan.project) {
        const project = await projectService.create({ name: plan.project.name, description: plan.project.description, goal: plan.project.goal },
          { authorization: caller.actor, principalId: caller.actor.principalId, authMethod: caller.taskActor.authMethod, scopes: caller.actor.scopes, audit: caller.audit }, transaction, allocatedProjectId);
        created.projectId = project.id;
      }
      for (const phase of plan.phases) {
        created.phases[phase.key] = (await phaseService.create({ projectId: created.projectId, name: phase.name, goal: phase.goal, position: phase.position, status: phase.status }, transaction)).id;
      }
      const projectTarget: AuthorizedProjectTarget = async (projectIdentifier, queryable) => {
        if (projectIdentifier !== created.projectId) return null;
        const allowed = await authorizationRepository.authorizedIds(caller.actor, 'project', [created.projectId], 'read', queryable);
        return allowed.has(created.projectId) ? created.projectId : null;
      };
      for (const task of plan.tasks) {
        const createdTask = await taskManagerDB.createTask({ title: task.title, description: task.description,
          definitionOfDone: task.definitionOfDone, successCriteria: task.successCriteria, notes: task.notes, constraints: task.constraints, status: task.status ?? 'todo', priority: task.priority ?? 'normal',
          project: created.projectId, phaseId: task.phaseId ?? created.phases[task.phaseKey] ?? null, autoStart: false,
          tags: task.tags ?? [], thinking: task.thinking, model: task.defaults?.model, maxRetries: task.defaults?.maxRetries,
          personalityId: task.personalityId, // Execution defaults are staged; setup is a separate explicit act.
          subtasks: (task.subtasks || []).map((subtask: Row, index: number) => ({ text: subtask.text, completed: false, status: 'empty', index })),
        }, caller.taskActor, projectTarget, transaction);
        created.tasks[task.key] = createdTask.id;
      }
      for (const edge of plan.dependencies) await taskManagerDB.addDependency(created.tasks[edge.task], created.tasks[edge.dependsOn], caller.taskActor, transaction);
      for (const task of plan.tasks) {
        const assignments = { ...(task.roles.shepherdPrincipalId ? { shepherdPrincipalId: task.roles.shepherdPrincipalId } : {}),
          ...(task.roles.verifierPrincipalId ? { verifierPrincipalId: task.roles.verifierPrincipalId } : {}) };
        if (Object.keys(assignments).length) {
          const outcome = await taskManagerDB.assignTaskRoles(created.tasks[task.key], assignments, caller.audit, transaction);
          if (outcome !== 'updated') throw new BlueprintError(422, 'BLUEPRINT_ROLE_ASSIGNMENT_REFUSED', 'Task role assignment could not be completed');
        }
        for (const reference of task.references || []) await taskElementService.createReference(created.tasks[task.key],
          { kind: ['skill','report'].includes(reference.kind) || reference.kind.startsWith('plugin:') ? reference.kind : 'reference',
            ...((reference.kind === 'plugin' || reference.kind.startsWith('plugin:')) ? { targetUri: `urn:relayhall:${reference.kind}:${reference.name}` } : { targetId: reference.id }), label: reference.name,
            metadata: { capabilityKind: reference.kind, ...(reference.serviceName ? {service:reference.serviceName} : {}), version: reference.version ?? null } },
          { principalId: caller.actor.principalId!, handle: caller.actor.handle, authorization: caller.actor }, transaction);
      }
      for (const report of plan.reports) {
        created.reports[report.key] = (await reportManager.create({ title: report.title, summary: report.summary, content: report.content,
          tags: report.tags ?? [], project_id: created.projectId, task_ids: report.tasks.map((key: string) => created.tasks[key]),
          author: caller.actor.handle, author_actor_id: caller.actor.handle, author_principal_id: caller.actor.principalId }, transaction)).id;
      }
      const instantiationId = uuidv4();
      await blueprintProvenanceService.stamp(transaction, { key: parent.key, version: version.version,
        contentSha256: version.content_sha256, identitySha256: version.identity_sha256, instantiationId },
      { project: plan.project ? created.projectId : undefined, phases: Object.values(created.phases), tasks: Object.values(created.tasks), reports: Object.values(created.reports) });
      const executionDefaults = plan.tasks.filter(task => task.executionProfile).map(task => ({
        taskId: created.tasks[task.key], localKey: task.key, projectId: created.projectId,
        phaseId: task.phaseId ?? created.phases[task.phaseKey] ?? null,
        executionProfile: task.executionProfile,
      }));
      const response = { status: 201, instantiationId, ...created, blueprint: { key: parent.key, version: version.version },
        executionSetup: { required: executionDefaults.length > 0, taskCount: executionDefaults.length },
        warnings: plan.references.filter(reference => reference.outcome === 'missing-optional') };
      const projection = Object.fromEntries(document.parameters.map(parameter => [parameter.key, { type: parameter.type, sha256: blueprintDigest(values[parameter.key] ?? null) }]));
      await client.query(`INSERT INTO blueprint_instantiations(id,blueprint_id,blueprint_version_id,root_project_id,actor_principal_id,parameter_values,parameter_projection,reference_outcomes,response_snapshot,execution_defaults)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [instantiationId,parent.id,version.id,created.projectId,caller.actor.principalId,values,projection,JSON.stringify(plan.references),response,JSON.stringify(executionDefaults)]);
      await client.query(`INSERT INTO blueprint_instantiation_requests(caller,blueprint_id,idempotency_key,blueprint_version_id,request_hash,response_snapshot,instantiation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [caller.actor.principalId,parent.id,key,version.id,hash,response,instantiationId]);
      await auditService.record({ action: 'blueprint.instantiate', actor: caller.audit, resourceType: 'blueprint', resourceId: parent.id,
        metadata: { version: version.version, instantiationId, counts: plan.counts } }, client);
      return response;
    }, 'blueprint').catch(async error => {
      // This diagnostic survives the rolled-back creation transaction. It
      // carries no supplied values, partial object IDs or elevated identity.
      if (admittedBlueprintId && error instanceof BlueprintError && error.code === 'BLUEPRINT_AUTHORITY_REQUIRED') {
        await auditService.record({ action: 'blueprint.instantiate_refused', outcome: 'denied', actor: caller.audit,
          resourceType: 'blueprint', resourceId: admittedBlueprintId,
          metadata: { reason: 'missing-authority', createdIds: [] } });
      }
      throw error;
    });
  }
}

