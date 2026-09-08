import { warrantService } from './WarrantService';
import { credentialLifecycleService } from './CredentialLifecycleService';
import { delegationService } from './DelegationService';
import { stepUpService } from './StepUpService';
import { isLoginSessionKind } from '../utils/administratorSession';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { runCreationTransaction } from '../db/creationTransaction';
import { authorizationRepository } from './AuthorizationRepository';
import { requireBlueprintScope } from './BlueprintRegistryService';
import type { BlueprintCreationCaller } from './BlueprintInstantiationService';
import { BlueprintError, blueprintDigest, currentBlueprintLimits } from '../utils/blueprintDocument';
import { validateConnectorProfile } from '../utils/executionProfile';
import { taskManagerDB } from './TaskManagerDB';
import { auditService } from './AuditService';

type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, code: string, message: string, field?: string): never => {
  throw new BlueprintError(status, code, message, field);
};
export interface BlueprintSetupInput {
  warrantId?: string;
  createWarrant?: { holderPrincipalId: string; ceilingProfileId: string; expiresAt: string };
  stepUpToken?: string;
  tasks?: Array<{ id: string; revision: string }>;
  confirmationHash?: string;
}

/** The created workflow is durable before this explicit act. The immutable
 * defaults are private data, not authority. Only canonical Task assignment
 * creates access effects. New Warrant creation requires a human session and
 * step-up confirmation; no activation or future enrollment. */
export class BlueprintSetupService {
  private input(value: BlueprintSetupInput, confirmed: boolean): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !(confirmed ? ['warrantId','createWarrant','stepUpToken','tasks','confirmationHash'] : ['warrantId','createWarrant']).includes(key))
      || (value.createWarrant ? value.warrantId !== undefined
        || typeof value.createWarrant !== 'object' || Array.isArray(value.createWarrant)
        || Object.keys(value.createWarrant).some(key => !['holderPrincipalId','ceilingProfileId','expiresAt'].includes(key))
        || !UUID.test(value.createWarrant.holderPrincipalId || '') || !UUID.test(value.createWarrant.ceilingProfileId || '')
        || typeof value.createWarrant.expiresAt !== 'string'
        : typeof value.warrantId !== 'string' || !UUID.test(value.warrantId))) {
      fail(422, 'BLUEPRINT_SETUP_INPUT_INVALID', 'Select an existing Warrant or a new Warrant holder, profile and expiry', 'warrantId');
    }
    if (confirmed && (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > currentBlueprintLimits().tasks
      || value.tasks.some(task => !task || typeof task !== 'object' || Array.isArray(task)
        || Object.keys(task).some(key => !['id','revision'].includes(key))
        || typeof task.id !== 'string' || !UUID.test(task.id) || typeof task.revision !== 'string' || !/^[0-9a-f]{32}$/.test(task.revision))
      || new Set(value.tasks.map(task => task.id)).size !== value.tasks.length
      || typeof value.confirmationHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.confirmationHash))) {
      fail(422, 'BLUEPRINT_SETUP_INPUT_INVALID', 'Confirm the exact displayed Task set and versions');
    }
  }
  private caller(caller: BlueprintCreationCaller): void {
    requireBlueprintScope(caller, 'blueprints:use');
    requireBlueprintScope(caller, 'tasks:write');
    requireBlueprintScope(caller, 'services:invoke');
    if (!caller.actor.principalId || caller.taskActor.principalId !== caller.actor.principalId
      || caller.audit.principalId !== caller.actor.principalId) fail(403, 'PRINCIPAL_REQUIRED', 'A resolved caller is required');
  }
  private async instance(id: string, caller: BlueprintCreationCaller, client: PoolClient): Promise<Row> {
    const blueprint = authorizationRepository.listScope(caller.actor, 'blueprint', 'use').render(4);
    const project = authorizationRepository.listScope(caller.actor, 'project', 'read').render(4 + blueprint.params.length);
    const result = await client.query(`SELECT i.id,i.root_project_id,i.response_snapshot,
      CASE WHEN i.actor_principal_id::text=$2 OR $3::boolean THEN i.execution_defaults ELSE NULL END AS execution_defaults
      FROM blueprint_instantiations i JOIN blueprints b ON b.id=i.blueprint_id JOIN projects p ON p.id=i.root_project_id
      WHERE i.id::text=$1 AND p.status<>'archived' AND ${blueprint.sql} AND ${project.sql} FOR UPDATE OF i`,
    [id, caller.actor.principalId, caller.rootSession, ...blueprint.params, ...project.params]);
    if (result.rows.length !== 1 || result.rows[0].execution_defaults === null) {
      fail(404, 'BLUEPRINT_SETUP_NOT_FOUND', 'Workflow setup not found');
    }
    const row = result.rows[0];
    if (!Array.isArray(row.execution_defaults) || !row.execution_defaults.length) {
      fail(409, 'BLUEPRINT_SETUP_NOT_REQUIRED', 'This instance has no staged execution defaults');
    }
    return row;
  }
  private async tasks(instance: Row, caller: BlueprintCreationCaller, client: PoolClient): Promise<Row[]> {
    const defaults: Row[] = instance.execution_defaults;
    const ids = defaults.map(item => item.taskId).sort();
    const scope = authorizationRepository.listScope(caller.actor, 'task', 'read');
    const condition = scope.render(2);
    const result = await client.query(`SELECT t.*,md5(row_to_json(t)::text) AS setup_revision FROM ${scope.from}
      WHERE t.id=ANY($1::uuid[]) AND ${condition.sql} ORDER BY t.id FOR UPDATE OF t`, [ids, ...condition.params]);
    if (result.rows.length !== ids.length || new Set(ids).size !== ids.length) {
      fail(404, 'BLUEPRINT_SETUP_NOT_FOUND', 'Workflow setup not found');
    }
    const writable = await authorizationRepository.authorizedIds(caller.actor, 'task', ids, 'write', client);
    if (writable.size !== ids.length) fail(403, 'BLUEPRINT_AUTHORITY_REQUIRED', 'Required Task assignment authority: tasks:write');
    for (const task of result.rows) {
      const staged = defaults.find(item => item.taskId === task.id)!;
      if (task.instantiation_id !== instance.id || task.project_id !== instance.root_project_id
        || (task.phase_id ?? null) !== staged.phaseId) {
        fail(409, 'BLUEPRINT_SETUP_CHANGED', 'The displayed workflow membership changed; review setup again');
      }
    }
    const services: string[] = [...new Set<string>(defaults.map(item => item.executionProfile.serviceId))];
    const invocable = await authorizationRepository.authorizedIds(caller.actor, 'service', services, 'invoke', client);
    if (invocable.size !== services.length) fail(403, 'BLUEPRINT_AUTHORITY_REQUIRED', 'Required Service invoke authority: services:invoke');
    return result.rows;
  }
  private async plan(instance: Row, input: BlueprintSetupInput, tasks: Row[], client: PoolClient): Promise<Row> {
    // Only existing Phase/Project anchoring is admitted for this grouped act.
    // Canonical AccessVehicleService independently checks holder, expiry,
    // profile/delegation caps and readability when each assignment is made.
    const warrant = (await client.query(`SELECT id,status,expires_at,holder_principal_id,ceiling_profile_version_id
      FROM warrants WHERE id=$1 FOR UPDATE`, [input.warrantId])).rows[0];
    if (!warrant || warrant.status !== 'active' || warrant.expires_at && new Date(warrant.expires_at).getTime() <= Date.now()) {
      fail(409, 'BLUEPRINT_SETUP_WARRANT_UNAVAILABLE', 'The selected Warrant cannot carry this setup', 'warrantId');
    }
    // Bind the actual live assignment plane as well as the pinned mint
    // ceiling. Publishing a different profile after preview requires a new
    // confirmation; the canonical writer still applies its own cap checks.
    const profile = (await client.query(`SELECT ap.id,ap.published_version_id
      FROM access_profile_versions v JOIN access_profiles ap ON ap.id=v.profile_id
      WHERE v.id=$1 FOR SHARE OF ap`, [warrant.ceiling_profile_version_id])).rows[0];
    if (!profile?.published_version_id) fail(409, 'BLUEPRINT_SETUP_WARRANT_UNAVAILABLE',
      'The selected Warrant cannot carry this setup', 'warrantId');
    const anchors = (await client.query(`SELECT anchor_type,anchor_id FROM warrant_anchors
      WHERE warrant_id=$1 ORDER BY anchor_type,anchor_id`, [input.warrantId])).rows;
    const entries = [];
    for (const task of tasks) {
      if (task.auto_start || task.execution_service_id || task.owner_principal_id || ['completed','archived'].includes(task.status)) {
        fail(409, 'BLUEPRINT_SETUP_CHANGED', 'Setup requires the displayed unassigned, parked Tasks');
      }
      if (!anchors.some(anchor => anchor.anchor_type === 'project' && anchor.anchor_id === task.project_id
        || anchor.anchor_type === 'phase' && anchor.anchor_id === task.phase_id)) {
        fail(409, 'BLUEPRINT_SETUP_WARRANT_UNAVAILABLE', 'The selected Phase/Project Warrant does not cover this setup', 'warrantId');
      }
      const staged = instance.execution_defaults.find((item: Row) => item.taskId === task.id);
      const executionProfile = await validateConnectorProfile(staged.executionProfile);
      entries.push({ id: task.id, revision: task.setup_revision, title: task.title, phaseId: task.phase_id ?? null, executionProfile });
    }
    const plan = { instantiationId: instance.id, projectId: instance.root_project_id,
      warrantId: warrant.id,
      tasks: entries, allParked: true, assignmentOnly: true };
    return { ...plan, confirmationHash: blueprintDigest({ plan, warrant, anchors, profile }) };
  }
  private async newWarrantPlan(instance: Row, input: BlueprintSetupInput, tasks: Row[], caller: BlueprintCreationCaller, client: PoolClient): Promise<Row> {
    if (!isLoginSessionKind(caller.audit.authMethod)) fail(403,'SESSION_ONLY','Creating a workflow Warrant requires a human login session');
    const proposed=input.createWarrant!;
    if (!caller.rootSession && proposed.holderPrincipalId !== caller.actor.principalId
      && !await credentialLifecycleService.isDescendant(caller.actor.principalId!,proposed.holderPrincipalId)) fail(404,'HOLDER_NOT_FOUND','The Warrant holder is unavailable');
    const createWarrant={name:'Blueprint workflow '+instance.id.slice(0,8),holderPrincipalId:proposed.holderPrincipalId,
      ceilingProfileId:proposed.ceilingProfileId,expiresAt:proposed.expiresAt,
      anchors:[{anchorType:'project',anchorId:instance.root_project_id}]};
    await client.query('SELECT id FROM access_profiles WHERE id=$1 FOR SHARE',[proposed.ceilingProfileId]);
    const authority=await warrantService.previewCreate(createWarrant,
      {principalId:caller.actor.principalId!,isRoot:caller.rootSession,sessionScopes:caller.actor.scopes,stepUp:null},caller.audit);
    const entries: Row[]=[]; const grants: Row[]=[];
    for (const task of tasks) {
      if (task.auto_start || task.execution_service_id || task.owner_principal_id || ['completed','archived'].includes(task.status)) fail(409,'BLUEPRINT_SETUP_CHANGED','Setup requires unassigned, parked Tasks');
      const staged=instance.execution_defaults.find((item: Row)=>item.taskId===task.id);
      const executionProfile=await validateConnectorProfile(staged.executionProfile);
      const service=(await client.query('SELECT principal_id FROM services WHERE id=$1',[executionProfile.serviceId])).rows[0];
      if (!service?.principal_id) fail(422,'ASSIGNEE_NOT_IDENTITY','Execution setup requires a Connector identity');
      const chain=await delegationService.resolveChain(service.principal_id);
      if (!chain.links.some(link=>link.principalId===proposed.holderPrincipalId)) fail(409,'WARRANT_HOLDER_MISMATCH','The selected holder must contain every workflow Connector');
      entries.push({id:task.id,revision:task.setup_revision,title:task.title,phaseId:task.phase_id??null,executionProfile});
      grants.push({kind:'profile-assignment',profileId:proposed.ceilingProfileId,
        granteePrincipalId:chain.links[chain.links.length-1].principalId,taskId:task.id,rules:authority.ceilingRulesForCheck});
    }
    const plan={instantiationId:instance.id,projectId:instance.root_project_id,createWarrant,
      grants,tasks:entries,allParked:true,assignmentOnly:false,requiresStepUp:true};
    return {...plan,confirmationHash:blueprintDigest({plan,authority})};
  }
  async preview(id: string, input: BlueprintSetupInput, caller: BlueprintCreationCaller) {
    this.caller(caller); this.input(input, false);
    return runCreationTransaction(pool, caller.taskActor, async transaction => {
      const instance = await this.instance(id, caller, transaction.client);
      const tasks=await this.tasks(instance,caller,transaction.client);
      return input.createWarrant ? this.newWarrantPlan(instance,input,tasks,caller,transaction.client)
        : this.plan(instance,input,tasks,transaction.client);
    });
  }
  async apply(id: string, input: BlueprintSetupInput, key: unknown, caller: BlueprintCreationCaller) {
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
      fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header of 16..128 characters is required');
    }
    this.caller(caller); this.input(input, true);
    return runCreationTransaction(pool, caller.taskActor, async transaction => {
      const client = transaction.client;
      const instance = await this.instance(id, caller, client);
      const tasks = await this.tasks(instance, caller, client);
      const hash = blueprintDigest({ id, ...(input.createWarrant ? {createWarrant:input.createWarrant} : {warrantId:input.warrantId}), tasks: [...input.tasks!].sort((a,b) => a.id.localeCompare(b.id)), confirmationHash: input.confirmationHash });
      const prior = (await client.query('SELECT request_hash,response_snapshot FROM blueprint_setup_requests WHERE caller=$1 AND instantiation_id=$2 AND idempotency_key=$3',
        [caller.actor.principalId,id,key])).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with different input');
        return prior.response_snapshot;
      }
      const plan = input.createWarrant ? await this.newWarrantPlan(instance,input,tasks,caller,client)
        : await this.plan(instance,input,tasks,client);
      if (plan.confirmationHash !== input.confirmationHash
        || blueprintDigest(plan.tasks.map((task: Row) => ({ id: task.id, revision: task.revision })))
          !== blueprintDigest([...input.tasks!].sort((a,b) => a.id.localeCompare(b.id)))) {
        fail(409, 'BLUEPRINT_SETUP_CHANGED', 'The displayed setup changed; preview and confirm it again');
      }
      let warrantId=input.warrantId;
      if (input.createWarrant) {
        const stepUp=await stepUpService.consume(client,{token:input.stepUpToken || '',principalId:caller.actor.principalId!,
          action:'warrant.create',targetId:input.createWarrant.holderPrincipalId});
        const warrant=await warrantService.create(plan.createWarrant,
          {principalId:caller.actor.principalId!,isRoot:caller.rootSession,sessionScopes:caller.actor.scopes,stepUp},caller.audit,client);
        warrantId=warrant.id;
      }
      for (const task of plan.tasks) {
        await taskManagerDB.updateTask(task.id, { executionProfile: task.executionProfile,
          executionServiceId: task.executionProfile.serviceId, executionDescriptorVersion: task.executionProfile.descriptorVersion,
          executionWarrantId: warrantId } as any, caller.taskActor, undefined, transaction);
      }
      const response = { status: 200, instantiationId: id, taskIds: plan.tasks.map((task: Row) => task.id),
        warrantId, assigned: true, armed: false };
      await auditService.record({ action: 'blueprint.setup', actor: caller.audit, resourceType: 'project', resourceId: instance.root_project_id,
        metadata: { instantiationId: id, taskIds: response.taskIds, warrantId, armed: false } }, client);
      await client.query(`INSERT INTO blueprint_setup_requests(caller,instantiation_id,idempotency_key,request_hash,response_snapshot)
        VALUES($1,$2,$3,$4,$5)`, [caller.actor.principalId,id,key,hash,response]);
      return response;
    });
  }
}
