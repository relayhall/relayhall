import type { Pool, PoolClient } from 'pg';
import { createHash } from 'crypto';
import { validateLegacyNativeImport } from './LegacyNativeImport';
import { hashReviewReports } from './TaskReviewAttemptService';
function sha256(value:string) {return createHash('sha256').update(value,'utf8').digest('hex');}
import { pool as defaultPool } from '../db/connection';
import type { TaskActor } from './TaskHistoryService';
import { taskAuthoritySnapshot } from './TaskAuthoritySnapshot';
import { explicitTaskActionCaps } from './ExplicitTaskActionCaps';
import { authorizationRepository } from './AuthorizationRepository';
import { authorizationService } from './AuthorizationService';
import { TelemetryPrincipalService } from './TelemetryPrincipalService';
import { productIsDeclared } from './TelemetryDescriptorPolicy';
import { telemetryReadScopeFor } from './TelemetryReadScope';
import { telemetryProjectionService } from './TelemetryProjectionService';
import { activeTelemetryPepperId, telemetrySessionReference } from '../utils/telemetryPepper';
import { telemetryEventExpiry } from '../utils/telemetryRetention';
import { ConflictFault, ForbiddenFault, InvalidRequestFault, NotFoundFault } from '../utils/httpErrors';
import { exactFields, reviewDigest } from '../utils/nativeReview';
import { feedEventService, feedActorFields } from './FeedEventService';
import { CORRELATION_ID_RE } from '../utils/telemetryEnvelopeValidator';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
/** A generation still inside its original joint-finish authority ($1 generation, $2 execution hard deadline):
 * the predicate the finish UPDATE writes under and the finish dry run reads (card 19dd180c). */
const JOINT_FINISH_OPEN='id=$1 AND expires_at>clock_timestamp() AND clock_timestamp()<$2';
const ACTIVE=['opened','launch_authorized','running','uncertain','ownership_lost'];
function uuid(value:unknown):string {
  if(typeof value!=='string' || !UUID.test(value)) throw new InvalidRequestFault('Expected UUID');
  return value;
}
function token(value:unknown):string {
  if(typeof value!=='string' || !HASH.test(value)) throw new InvalidRequestFault('Expected 32-byte lease token');
  return reviewDigest(value);
}
export type NativeExecutionAction='authorize-launch'|'heartbeat'|'attest'|'close'|'cancel'|'reconcile';

/** Ordinary implementation participation. Never claims, completes, or judges a Task.
 * Task/assignment changes serialize on the Task row. Permission ceilings are a fresh
 * decision-time intersection, not a claim of atomic revocation across grant writers. */
export class NativeExecutionService {
  constructor(private readonly pool:Pool=defaultPool) {}
  private async transaction<T>(operation:(client:PoolClient)=>Promise<T>,readOnly=false):Promise<T> {
    const client=await this.pool.connect();
    try {
      await client.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
      await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s'");
      const result=await operation(client);await client.query('COMMIT');return result;
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  private async task(client:PoolClient,id:string,actor:TaskActor,lock=true) {
    const row=(await client.query('SELECT * FROM tasks WHERE id=$1'+(lock?' FOR UPDATE':''),[uuid(id)])).rows[0];
    if(!row || !actor.authorization || !(await authorizationRepository.authorizedIds(actor.authorization,'task',[id],'read',client)).has(id)) throw new NotFoundFault('Task not found');
    const epoch=(await client.query('SELECT epoch FROM task_native_assignment_epochs WHERE task_id=$1',[id])).rows[0];
    if(!epoch) throw new ConflictFault('Assignment epoch unavailable');
    return {...row,native_epoch:String(epoch.epoch)};
  }
  /** One semantic predicate for reservation and every current native authority boundary.
   * NULL/abandoned archived outcomes remain blocking; historical timestamps are not completion. */
  private async dependenciesSatisfied(client:PoolClient,taskId:string) {
    if((await client.query(`SELECT 1 FROM task_dependencies d JOIN tasks prerequisite ON prerequisite.id=d.depends_on_task_id
      WHERE d.task_id=$1 AND NOT COALESCE(prerequisite.status='completed'
        OR (prerequisite.status='archived' AND prerequisite.archive_disposition='completed'),FALSE) LIMIT 1`,[taskId])).rowCount)
      throw new ConflictFault('Task dependencies are not semantically completed');
  }
  private async authority(client:PoolClient,task:any,actor:TaskActor,execution?:any) {
    // Acquire potentially blocking capability locks before taking decision-time identity/cap snapshots.
    const service=(await client.query(`SELECT s.*,d.descriptor,d.retired_at AS descriptor_retired FROM services s
      JOIN service_descriptor_versions d ON d.service_id=s.id AND d.version=$2 WHERE s.id=$1 FOR SHARE OF s,d`,[task.execution_service_id,task.execution_descriptor_version])).rows[0];
    const actors=await taskAuthoritySnapshot(client,actor,task.id);
    if(!actors || task.owner_principal_id!==actor.principalId || task.verifier_principal_id===actor.principalId
      || task.archived_at || task.status!=='in-progress') throw new ForbiddenFault('Current independent implementation owner in progress required');
    if(execution && (execution.actor_principal_id!==actor.principalId || String(execution.assignment_epoch)!==task.native_epoch)) throw new ConflictFault('Assignment changed; stop and reconcile', 'NATIVE_EXECUTION_ASSIGNMENT_CHANGED');
    for(const value of actors) {
      if(!explicitTaskActionCaps(value,{type:'task',id:task.id,projectId:task.project_id},'write')
        || !(await authorizationRepository.authorizedIds(value,'task',[task.id],'write',client)).has(task.id)
        || !authorizationService.authorizeRoute(value,'services:invoke').allowed
        || !(await authorizationRepository.authorizedIds(value,'service',[task.execution_service_id],'invoke',client)).has(task.execution_service_id)) throw new ForbiddenFault('Current Task and Service invocation authority required');
    }
    await this.dependenciesSatisfied(client,task.id);
    const fresh=actors[actors.length-1];
    const derived=await new TelemetryPrincipalService(client as unknown as Pool).derive({actingPrincipalId:actor.principalId!,delegationLinks:fresh.delegation?.links});
    if(!derived.ok) throw new ForbiddenFault('Current registered native identity unavailable');
    const capability=service?.descriptor?.nativeExecution;
    if(!service || service.status!=='published' || service.kind!=='connector' || service.retired_at || service.descriptor_retired
      || service.principal_id!==derived.binding.connectorId || service.current_descriptor_version!==task.execution_descriptor_version
      || capability?.protocolVersion!==1 || !productIsDeclared(derived.descriptor,capability.sourceProduct)) throw new ConflictFault('Pinned registered implementation capability unavailable','NATIVE_EXECUTION_CAPABILITY_UNAVAILABLE');
    if(execution && (execution.service_id!==service.id || execution.descriptor_version!==task.execution_descriptor_version
      || execution.connector_id!==derived.binding.connectorId || execution.account_id!==derived.binding.accountId
      || execution.agent_id!==derived.binding.agentId || execution.source_product!==capability.sourceProduct)) throw new ConflictFault('Execution identity changed');
    return {actors,derived,service,capability};
  }
  private publicRow(row:any) {
    const expired=ACTIVE.includes(row.state) && row.state!=='ownership_lost' && new Date(row.lease_expires_at)<=new Date();
    return {id:row.id,taskId:row.task_id,purpose:'implementation',assignmentEpoch:String(row.assignment_epoch),
      actorPrincipalId:row.actor_principal_id,serviceId:row.service_id,descriptorVersion:row.descriptor_version,
      dispatchKey:row.dispatch_key,runOrdinal:row.run_ordinal,state:expired?'uncertain':row.state,
      launchKey:row.launch_key,launchAuthorizedAt:row.launch_authorized_at,leaseExpiresAt:row.lease_expires_at,
      hardDeadline:row.hard_deadline,openedAt:row.opened_at,finishedAt:row.finished_at,outcome:row.outcome,
      reconciliation:row.reconciliation?{actorPrincipalId:row.reconciliation.actorPrincipalId,stoppedAt:row.reconciliation.stoppedAt,kind:'authenticated-custody-evidence'}:null};
  }
  async open(taskId:string,body:unknown,actor:TaskActor) {
    exactFields(body,['dispatchKey','assignmentEpoch','serviceId','descriptorVersion','leaseToken','budgetSeconds']);
    const dispatch=uuid(body.dispatchKey),serviceId=uuid(body.serviceId),leaseHash=token(body.leaseToken);
    if(typeof body.assignmentEpoch!=='string' || !/^[1-9][0-9]{0,17}$/.test(body.assignmentEpoch)
      || !Number.isInteger(body.descriptorVersion) || Number(body.descriptorVersion)<1
      || !Number.isInteger(body.budgetSeconds) || Number(body.budgetSeconds)<30 || Number(body.budgetSeconds)>3600) throw new InvalidRequestFault('Exact assignment and bounded run budget required');
    const digest=reviewDigest({...body,leaseToken:leaseHash});
    return this.transaction(async client=>{
      const task=await this.task(client,taskId,actor);
      const prior=(await client.query('SELECT * FROM task_native_executions WHERE dispatch_key=$1',[dispatch])).rows[0];
      if(prior) {
        if(prior.task_id!==taskId || prior.actor_principal_id!==actor.principalId || prior.request_digest!==digest) throw new ConflictFault('Dispatch key conflict');
        return this.publicRow(prior);
      }
      await this.quarantineFence(client,taskId);
      const {derived,capability}=await this.authority(client,task,actor);
      if(task.native_epoch!==body.assignmentEpoch || task.execution_service_id!==serviceId || task.execution_descriptor_version!==body.descriptorVersion) throw new ConflictFault('Assignment pin changed');
      if((await client.query('SELECT id FROM task_native_executions WHERE task_id=$1 AND state=ANY($2::text[])',[taskId,ACTIVE])).rowCount) throw new ConflictFault('Prior execution requires reconciliation','NATIVE_EXECUTION_UNRESOLVED');
      const row=(await client.query(`INSERT INTO task_native_executions(task_id,assignment_epoch,actor_principal_id,connector_id,account_id,agent_id,
        service_id,descriptor_version,source_product,dispatch_key,request_digest,run_ordinal,lease_hash,lease_expires_at,hard_deadline)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE(MAX(run_ordinal),0)+1,$12,NOW()+LEAST(120,$13)*INTERVAL '1 second',NOW()+$13*INTERVAL '1 second'
        FROM task_native_executions WHERE task_id=$1 RETURNING *`,[taskId,task.native_epoch,actor.principalId,derived.binding.connectorId,
        derived.binding.accountId,derived.binding.agentId,serviceId,body.descriptorVersion,capability.sourceProduct,
        dispatch,digest,leaseHash,body.budgetSeconds])).rows[0];
      await this.hint(client,task,row.id,actor);return this.publicRow(row);
    });
  }
  private async hint(client:PoolClient,task:any,executionId:string,actor:TaskActor) {
    // Card 5854f0d6 (design section 4.3): the acting principal.
    await feedEventService.emit(client,{name:'task.updated',objectType:'task',objectId:task.id,...feedActorFields(actor),projectId:task.project_id,ownerPrincipalId:task.owner_principal_id,payload:{nativeExecutionId:executionId}});
  }
  private async recoveryAuthority(client:PoolClient,task:any,row:any,actor:TaskActor) {
    const actors=await taskAuthoritySnapshot(client,actor,task.id);
    if(!actors) throw new ForbiddenFault('Current reconciliation authority required');
    for(const value of actors) {
      const action=row.actor_principal_id===actor.principalId && task.owner_principal_id===actor.principalId?'write':'shepherd';
      if((action==='write' && !explicitTaskActionCaps(value,{type:'task',id:task.id,projectId:task.project_id},'write'))
        || !(await authorizationRepository.authorizedIds(value,'task',[task.id],action,client)).has(task.id)) throw new ForbiddenFault('Current owner or Shepherd authority required');
    }
  }
  async act(taskId:string,id:string,action:NativeExecutionAction,body:unknown,actor:TaskActor) {
    const fields:Record<NativeExecutionAction,string[]>={
      'authorize-launch':['leaseToken','launchKey'],heartbeat:['leaseToken'],
      attest:['leaseToken','slotId','parentSlotId','relationship','correlation'],close:['leaseToken','outcome','reportId'],
      cancel:[],reconcile:['launchKey','intentDigest','processIdentityDigest','treeAbsent','stoppedAt']};
    exactFields(body,fields[action]);
    return this.transaction(async client=>{
      const task=await this.task(client,taskId,actor);
      let row=(await client.query('SELECT * FROM task_native_executions WHERE id=$1 AND task_id=$2 FOR UPDATE',[uuid(id),taskId])).rows[0];
      if(!row) throw new NotFoundFault('Execution not found');
      if(action==='cancel' || action==='reconcile') {
        await this.recoveryAuthority(client,task,row,actor);
        if(action==='cancel') {
          if(row.launch_key || !['opened','ownership_lost','cancelled'].includes(row.state)) throw new ConflictFault('Launch was authorized; custody reconciliation required');
          row=(await client.query("UPDATE task_native_executions SET state='cancelled',finished_at=COALESCE(finished_at,NOW()) WHERE id=$1 RETURNING *",[id])).rows[0];
        } else {
          uuid(body.launchKey);
          const stopped=typeof body.stoppedAt==='string'?new Date(body.stoppedAt):new Date(NaN);
          const now=Date.now(),clockSkewMs=120_000;
          if(body.launchKey!==row.launch_key || !HASH.test(String(body.intentDigest)) || !HASH.test(String(body.processIdentityDigest))
            || body.treeAbsent!==true || !Number.isFinite(stopped.getTime()) || stopped.getTime()>now+clockSkewMs
            || stopped.getTime()<new Date(row.opened_at).getTime()-clockSkewMs) throw new InvalidRequestFault('Exact launch and bounded stopped-tree evidence required');
          const proof={...body,actorPrincipalId:actor.principalId};
          if(row.state==='stopped_unresolved') {
            if(reviewDigest(row.reconciliation)!==reviewDigest(proof)) throw new ConflictFault('Reconciliation retry differs');
          } else {
            if(!ACTIVE.includes(row.state)) throw new ConflictFault('Execution is already terminal');
            // A Shepherd does not own the provider process. Do not clear a live
            // owner's fence merely on another actor's custody assertion.
            if(actor.principalId!==row.actor_principal_id && row.state!=='ownership_lost'
              && new Date(row.lease_expires_at).getTime()>now && new Date(row.hard_deadline).getTime()>now)
              throw new ConflictFault('Owner lease remains live','NATIVE_EXECUTION_OWNER_LEASE_LIVE');
            row=(await client.query("UPDATE task_native_executions SET state='stopped_unresolved',finished_at=NOW(),reconciliation=$2 WHERE id=$1 RETURNING *",[id,JSON.stringify(proof)])).rows[0];
          }
        }
      } else {
        const leaseHash=token(body.leaseToken);
        if(row.actor_principal_id!==actor.principalId || row.lease_hash!==leaseHash) throw new ForbiddenFault('Exact execution actor and lease required');
        if(action==='close' && row.state==='closed') {
          if(row.close_digest!==reviewDigest(body)) throw new ConflictFault('Close retry differs');
          return this.publicRow(row);
        }
        const {actors}=await this.authority(client,task,actor,row);
        if(!['opened','launch_authorized','running'].includes(row.state) || new Date(row.lease_expires_at)<=new Date() || new Date(row.hard_deadline)<=new Date()) throw new ConflictFault('Execution lease unavailable; reconcile without relaunch','NATIVE_EXECUTION_LEASE_UNAVAILABLE');
        if(action==='authorize-launch') {
          await this.quarantineFence(client,taskId);
          if((await client.query('SELECT id FROM task_native_generations WHERE task_id=$1 LIMIT 1',[taskId])).rowCount) throw new ConflictFault('Versioned generation requires one-time consume, never replay launch');
          const launch=uuid(body.launchKey);
          if(row.launch_key && row.launch_key!==launch) throw new ConflictFault('Launch key conflict');
          if(!row.launch_key) row=(await client.query("UPDATE task_native_executions SET state='launch_authorized',launch_key=$2,launch_authorized_at=NOW() WHERE id=$1 RETURNING *",[id,launch])).rows[0];
        } else {
          if(!row.launch_key) throw new ConflictFault('Launch not authorized');
          if(action==='heartbeat') row=(await client.query("UPDATE task_native_executions SET lease_expires_at=LEAST(hard_deadline,NOW()+INTERVAL '120 seconds') WHERE id=$1 RETURNING *",[id])).rows[0];
          else if(action==='attest') {
            for(const value of actors) if(!authorizationService.authorizeRoute(value,'telemetry:write').allowed) throw new ForbiddenFault('Current telemetry write required');
            await this.attest(client,row,body);
            row=(await client.query("UPDATE task_native_executions SET state='running',session_expires_at=COALESCE(session_expires_at,$2) WHERE id=$1 RETURNING *",[id,telemetryEventExpiry(new Date())])).rows[0];
          } else if(action==='close') {
            if(!['completed','failed','cancelled'].includes(String(body.outcome))) throw new InvalidRequestFault('Closed process outcome required');
            const report=body.reportId===undefined?null:uuid(body.reportId);
            if(report) {
              const own=(await client.query('SELECT id FROM reports WHERE id=$1 AND author_principal_id=$2 AND $3::uuid=ANY(task_ids) AND deleted_at IS NULL',[report,actor.principalId,taskId])).rows[0];
              if(!own) throw new ForbiddenFault('Own Task result Report required');
              for(const value of actors) if(!(await authorizationRepository.authorizedIds(value,'report',[report],'read',client)).has(report)) throw new ForbiddenFault('Result Report is restricted');
            }
            row=(await client.query("UPDATE task_native_executions SET state='closed',finished_at=NOW(),outcome=$2,report_id=$3,close_digest=$4 WHERE id=$1 RETURNING *",[id,body.outcome,report,reviewDigest(body)])).rows[0];
          }
        }
      }
      await this.hint(client,task,id,actor);return this.publicRow(row);
    });
  }
  private deployment():string {
    const value=process.env.RELAYHALL_DEPLOYMENT_ID;
    if(!value || !UUID.test(value)) throw new ConflictFault('Versioned coordination deployment identity is unbound');
    return value;
  }
  private generationTaskDigest(task:any):string {
    return reviewDigest({description:task.description,definitionOfDone:task.definition_of_done,
      executionProfile:task.execution_profile,serviceId:task.execution_service_id,
      descriptorVersion:task.execution_descriptor_version,autoStart:task.auto_start});
  }
  private generationPublic(row:any) {
    return {schemaVersion:2,id:row.id,deploymentId:row.deployment_id,taskId:row.task_id,
      actorPrincipalId:row.actor_principal_id,serviceId:row.service_id,descriptorVersion:row.descriptor_version,
      reservedEpoch:String(row.reserved_epoch),claimEpoch:row.claim_epoch===null?null:String(row.claim_epoch),
      requestKey:row.request_key,requestSha256:row.request_digest,sourceSha256:row.source_digest,inputSha256:row.input_digest,
      predecessorExecutionId:row.predecessor_execution_id,reviewAttemptId:row.review_attempt_id,
      workerInstanceId:row.worker_instance_id,state:row.state,executionId:row.execution_id,
      boundEpoch:row.bound_epoch===null?null:String(row.bound_epoch),createdAt:row.created_at,expiresAt:row.expires_at,
      consumedAt:row.consumed_at,publicationIntent:row.publication_intent,launchPermit:false};
  }
  private async quarantineFence(client:PoolClient,taskId:string) {
    if((await client.query('SELECT id FROM task_native_import_quarantine WHERE task_id=$1 LIMIT 1',[taskId])).rowCount)
      throw new ConflictFault('Imported legacy uncertainty requires explicit cutover; no runnable authority','NATIVE_GENERATION_IMPORT_HOLD');
  }
  async reserveGeneration(taskId:string,body:unknown,actor:TaskActor) {
    exactFields(body,['schemaVersion','deploymentId','requestKey','assignmentEpoch','serviceId','descriptorVersion','workerInstanceId','workerToken','sourceSha256','inputSha256','budgetSeconds','predecessorExecutionId','reviewAttemptId']);
    const b=body as any;
    if(b.schemaVersion!==2||b.deploymentId!==this.deployment()||typeof b.assignmentEpoch!=='string'||!/^[1-9][0-9]{0,17}$/.test(b.assignmentEpoch)
      ||!Number.isInteger(b.descriptorVersion)||b.descriptorVersion<1||!Number.isInteger(b.budgetSeconds)||b.budgetSeconds<30||b.budgetSeconds>600
      ||typeof b.sourceSha256!=='string'||typeof b.inputSha256!=='string'||!HASH.test(b.sourceSha256)||!HASH.test(b.inputSha256)||!actor.credentialId) throw new InvalidRequestFault('Exact versioned intent and credential required');
    uuid(b.requestKey);uuid(b.workerInstanceId);uuid(b.serviceId);
    const workerHash=token(b.workerToken),digest=reviewDigest({...b,workerToken:workerHash});
    if((b.predecessorExecutionId===null)!==(b.reviewAttemptId===null)) throw new InvalidRequestFault('Exact predecessor and rejection pairing required');
    if(b.predecessorExecutionId!==null) {uuid(b.predecessorExecutionId);uuid(b.reviewAttemptId);}
    return this.transaction(async client=>{
      const task=await this.task(client,taskId,actor);
      await this.quarantineFence(client,taskId);
      const prior=(await client.query('SELECT * FROM task_native_generations WHERE request_key=$1',[b.requestKey])).rows[0];
      if(prior) {
        if(prior.task_id!==taskId||prior.actor_principal_id!==actor.principalId||prior.credential_id!==actor.credentialId||prior.request_digest!==digest) throw new ConflictFault('Generation request differs');
        return this.generationPublic(prior); // Evidence only; never renew or grant launch.
      }
      const service=(await client.query(`SELECT s.*,d.descriptor,d.retired_at AS descriptor_retired FROM services s JOIN service_descriptor_versions d ON d.service_id=s.id AND d.version=$2 WHERE s.id=$1 FOR SHARE OF s,d`,[b.serviceId,b.descriptorVersion])).rows[0];
      const actors=await taskAuthoritySnapshot(client,actor,taskId);
      if(!actors||task.status!=='todo'||task.archived_at||task.auto_start!==true||task.verifier_principal_id===actor.principalId
        ||(task.owner_principal_id!==null&&task.owner_principal_id!==actor.principalId)||task.native_epoch!==b.assignmentEpoch
        ||task.execution_service_id!==b.serviceId||task.execution_descriptor_version!==b.descriptorVersion) throw new ConflictFault('Exact preclaim assignment required');
      for(const value of actors) {
        if(!explicitTaskActionCaps(value,{type:'task',id:taskId,projectId:task.project_id},'write')
          || !(await authorizationRepository.authorizedIds(value,'task',[taskId],'claim',client)).has(taskId)
          ||!authorizationService.authorizeRoute(value,'services:invoke').allowed
          ||!(await authorizationRepository.authorizedIds(value,'service',[b.serviceId],'invoke',client)).has(b.serviceId)) throw new ForbiddenFault('Current claim and service authority required');
      }
      await this.dependenciesSatisfied(client,taskId);
      const fresh=actors[actors.length-1];
      const derived=await new TelemetryPrincipalService(client as unknown as Pool).derive({actingPrincipalId:actor.principalId!,delegationLinks:fresh.delegation?.links});
      if(!derived.ok) throw new ForbiddenFault('Current registered identity unavailable');
      const capability=service?.descriptor?.nativeExecution;
      if(!service||service.status!=='published'||service.kind!=='connector'||service.retired_at||service.descriptor_retired||service.principal_id!==derived.binding.connectorId||service.current_descriptor_version!==b.descriptorVersion||capability?.protocolVersion!==1||!productIsDeclared(derived.descriptor,capability.sourceProduct)) throw new ConflictFault('Pinned registered implementation capability unavailable');
      if((await client.query("SELECT id FROM task_native_executions WHERE task_id=$1 AND state<>'closed' LIMIT 1",[taskId])).rowCount) throw new ConflictFault('Unresolved native ancestor forbids generation');
      const last=(await client.query('SELECT * FROM task_native_executions WHERE task_id=$1 ORDER BY run_ordinal DESC LIMIT 1',[taskId])).rows[0];
      if(!last) {
        if(b.predecessorExecutionId!==null) throw new ConflictFault('First generation cannot invent predecessor');
      } else {
        if(last.id!==b.predecessorExecutionId||last.state!=='closed'||last.outcome!=='completed'||!last.report_id) throw new ConflictFault('Exact closed completed predecessor required');
        const predecessorGeneration=(await client.query("SELECT * FROM task_native_generations WHERE execution_id=$1 AND state='finished'",[last.id])).rows[0];
        if(!predecessorGeneration || predecessorGeneration.deployment_id!==b.deploymentId) throw new ConflictFault('Predecessor generation is unmapped or unfinished');
        const attempt=(await client.query("SELECT * FROM task_review_attempts WHERE id=$1 AND task_id=$2 AND status='rejected'",[b.reviewAttemptId,taskId])).rows[0];
        if(!attempt||!attempt.finished_at||new Date(attempt.finished_at)<new Date(last.finished_at)
          ||(await client.query('SELECT id FROM task_review_attempts WHERE task_id=$1 AND attempt_no>$2 LIMIT 1',[taskId,attempt.attempt_no])).rowCount) throw new ConflictFault('Current authoritative rejected attempt required');
        const reports=(await client.query(`SELECT id,title,summary,content FROM reports WHERE deleted_at IS NULL AND $1::uuid=ANY(task_ids) ORDER BY id`,[taskId])).rows;
        const marker=Array.isArray(attempt.review_slice)?attempt.review_slice.find((x:any)=>x.kind==='flat_task_review'||x.kind==='native_review'):null;
        if(!marker||marker.reportDigest!==hashReviewReports(reports)||!reports.some((r:any)=>r.id===last.report_id)) throw new ConflictFault('Rejected Report bytes changed or unavailable');
        if(!(await client.query("SELECT id FROM task_stream_entries WHERE task_id=$1 AND report_id=$2 AND event_type='handover.finish' LIMIT 1",[taskId,last.report_id])).rowCount) throw new ConflictFault('Predecessor handover unavailable');
      }
      const row=(await client.query(`INSERT INTO task_native_generations(deployment_id,task_id,actor_principal_id,credential_id,service_id,descriptor_version,
        reserved_epoch,reserved_owner,request_key,request_digest,task_digest,source_digest,input_digest,predecessor_execution_id,review_attempt_id,
        worker_instance_id,worker_token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,clock_timestamp()+$18*INTERVAL '1 second') RETURNING *`,
        [b.deploymentId,taskId,actor.principalId,actor.credentialId,b.serviceId,b.descriptorVersion,task.native_epoch,task.owner_principal_id,b.requestKey,digest,
          this.generationTaskDigest(task),b.sourceSha256,b.inputSha256,b.predecessorExecutionId,b.reviewAttemptId,b.workerInstanceId,workerHash,b.budgetSeconds])).rows[0];
      return this.generationPublic(row);
    });
  }
  async readGeneration(taskId:string,generationId:string,actor:TaskActor) {
    return this.transaction(async client=>{
      await this.task(client,taskId,actor,false);
      const row=(await client.query('SELECT * FROM task_native_generations WHERE id=$1 AND task_id=$2 AND deployment_id=$3',[uuid(generationId),taskId,this.deployment()])).rows[0];
      if(!row) throw new NotFoundFault('Generation not found');return this.generationPublic(row);
    },true);
  }
  async consumeGeneration(taskId:string,generationId:string,body:unknown,actor:TaskActor) {
    exactFields(body,['schemaVersion','executionId','workerInstanceId','workerToken','launchKey']);
    const b=body as any;
    if(b.schemaVersion!==2) throw new InvalidRequestFault('Versioned consume required');
    uuid(b.executionId);uuid(b.workerInstanceId);uuid(b.launchKey);const workerHash=token(b.workerToken),digest=reviewDigest({...b,workerToken:workerHash});
    return this.transaction(async client=>{
      const task=await this.task(client,taskId,actor);await this.quarantineFence(client,taskId);
      const row=(await client.query('SELECT * FROM task_native_generations WHERE id=$1 AND task_id=$2 FOR UPDATE',[uuid(generationId),taskId])).rows[0];
      if(!row||row.deployment_id!==this.deployment()||row.actor_principal_id!==actor.principalId||row.credential_id!==actor.credentialId
        ||row.worker_instance_id!==b.workerInstanceId||row.worker_token_hash!==workerHash) throw new ForbiddenFault('Exact registered instance and credential required');
      if(row.state!=='reserved') {
        if(row.consume_digest!==digest||row.execution_id!==b.executionId) throw new ConflictFault('Consume retry differs');
        return {...this.generationPublic(row),freshConsume:false};
      }
      const execution=(await client.query('SELECT * FROM task_native_executions WHERE id=$1 AND task_id=$2 FOR UPDATE',[b.executionId,taskId])).rows[0];
      if(!execution) throw new NotFoundFault('Execution not found');
      await this.authority(client,task,actor,execution);
      const clock=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now;
      if(!row.claimed_at||String(row.claim_epoch)!==task.native_epoch||String(execution.assignment_epoch)!==task.native_epoch
        ||BigInt(row.reserved_epoch)+(row.reserved_owner===null?BigInt(1):BigInt(0))!==BigInt(task.native_epoch)
        ||row.task_digest!==this.generationTaskDigest(task)||row.service_id!==execution.service_id||row.descriptor_version!==execution.descriptor_version
        ||execution.state!=='opened'||execution.launch_key||new Date(row.expires_at)<=new Date(clock)
        ||new Date(execution.lease_expires_at)<=new Date(clock)||new Date(execution.hard_deadline)<=new Date(clock)) throw new ConflictFault('Claim advancement, source or original deadline changed');
      const result=(await client.query("UPDATE task_native_generations SET state='consumed',execution_id=$2,bound_epoch=$3,consume_digest=$4,consumed_at=clock_timestamp() WHERE id=$1 AND expires_at>clock_timestamp() RETURNING *",[generationId,b.executionId,task.native_epoch,digest])).rows[0];
      if(!result) throw new ConflictFault('Original generation deadline exhausted');
      const advanced=await client.query("UPDATE task_native_executions SET state='launch_authorized',launch_key=$2,launch_authorized_at=clock_timestamp(),hard_deadline=LEAST(hard_deadline,$3),lease_expires_at=LEAST(lease_expires_at,$3) WHERE id=$1 AND clock_timestamp()<LEAST(hard_deadline,lease_expires_at,$3)",[b.executionId,b.launchKey,row.expires_at]);
      if(advanced.rowCount!==1) throw new ConflictFault('Original native deadline exhausted');
      // A fresh conditional transition only, not an exactly-once OS guarantee.
      return {...this.generationPublic(result),freshConsume:true};
    });
  }
  private async generationReport(client:PoolClient,taskId:string,row:any,reportId:string,contentSha256:string,actor:TaskActor) {
    const report=(await client.query('SELECT * FROM reports WHERE id=$1 AND author_principal_id=$2 AND $3::uuid=ANY(task_ids) AND deleted_at IS NULL FOR SHARE',[uuid(reportId),row.actor_principal_id,taskId])).rows[0];
    const actors=await taskAuthoritySnapshot(client,actor,taskId);
    if(!actors) throw new ForbiddenFault('Current Report identity unavailable');
    for(const value of actors) {
      if(!authorizationService.authorizeRoute(value,'reports:read').allowed || !(await authorizationRepository.authorizedIds(value,'report',[reportId],'read',client)).has(reportId)) throw new ForbiddenFault('Current own Report read authority required');
    }
    if(!report||sha256(report.content)!==contentSha256||report.content_hash!==contentSha256) throw new ConflictFault('Exact own Task Report bytes required');
  }
  async publishGenerationIntent(taskId:string,generationId:string,body:unknown,actor:TaskActor) {
    exactFields(body,['schemaVersion','executionId','workerInstanceId','workerToken','publicationKey','reportId','contentSha256','requestSha256','outcome']);
    const b=body as any;
    if(b.schemaVersion!==2||b.outcome!=='completed'||typeof b.contentSha256!=='string'||typeof b.requestSha256!=='string'||!HASH.test(b.contentSha256)||!HASH.test(b.requestSha256)) throw new InvalidRequestFault('Exact completed publication intent required');
    for(const key of ['executionId','workerInstanceId','publicationKey','reportId']) uuid(b[key]);const workerHash=token(b.workerToken);
    const expected=reviewDigest({taskId,generationId,executionId:b.executionId,publicationKey:b.publicationKey,reportId:b.reportId,contentSha256:b.contentSha256,outcome:b.outcome});
    if(expected!==b.requestSha256) throw new InvalidRequestFault('Publication request digest differs');
    return this.transaction(async client=>{
      const task=await this.task(client,taskId,actor);await this.quarantineFence(client,taskId);
      const row=(await client.query('SELECT * FROM task_native_generations WHERE id=$1 AND task_id=$2 FOR UPDATE',[uuid(generationId),taskId])).rows[0];
      if(!row||row.deployment_id!==this.deployment()||row.actor_principal_id!==actor.principalId||row.credential_id!==actor.credentialId||row.worker_instance_id!==b.workerInstanceId||row.worker_token_hash!==workerHash||row.execution_id!==b.executionId) throw new ForbiddenFault('Exact consumed generation required');
      const execution=(await client.query('SELECT * FROM task_native_executions WHERE id=$1 AND task_id=$2',[b.executionId,taskId])).rows[0];
      await this.authority(client,task,actor,execution);
      if(row.state!=='consumed'||row.task_digest!==this.generationTaskDigest(task)||String(row.bound_epoch)!==task.native_epoch
        ||execution?.state!=='closed'||execution.outcome!=='completed'||execution.report_id!==b.reportId
        ||!(await client.query('SELECT 1 WHERE clock_timestamp()<$1 AND clock_timestamp()<$2',[row.expires_at,execution.hard_deadline])).rowCount) throw new ConflictFault('Closed current generation within original authority required');
      await this.generationReport(client,taskId,row,b.reportId,b.contentSha256,actor);
      await this.authority(client,task,actor,execution);
      const intent={schemaVersion:2,generationId,executionId:b.executionId,publicationKey:b.publicationKey,reportId:b.reportId,contentSha256:b.contentSha256,requestSha256:b.requestSha256,
        actorPrincipalId:actor.principalId,assignmentEpoch:task.native_epoch,sourceSha256:row.source_digest,inputSha256:row.input_digest,outcome:'completed'};
      if(row.publication_intent && reviewDigest(row.publication_intent)!==reviewDigest(intent)) throw new ConflictFault('Immutable publication differs');
      const deadline=(await client.query('SELECT 1 WHERE clock_timestamp()<$1 AND clock_timestamp()<$2',[row.expires_at,execution.hard_deadline])).rowCount;
      if(!deadline) throw new ConflictFault('Original publication deadline expired during Report validation');
      if(!row.publication_intent) {
        const saved=await client.query('UPDATE task_native_generations SET publication_intent=$2 WHERE id=$1 AND expires_at>clock_timestamp() AND clock_timestamp()<$3',[generationId,JSON.stringify(intent),execution.hard_deadline]);
        if(saved.rowCount!==1) throw new ConflictFault('Original publication deadline exhausted');
      }
      return {schemaVersion:2,intent,publicationAuthorized:false};
    });
  }
  /** Called only inside TaskElement's already-owned Task transaction.
   * `dryRun` (card 19dd180c, the finish preview) runs every check below and,
   * in place of the one UPDATE, reads that UPDATE's own deadline predicate. */
  async finishGenerationWithClient(client:PoolClient,taskId:string,reportId:string|null,payload:unknown,actor:TaskActor,options:{dryRun?:boolean}={}) {
    // Quarantine blocks both versioned publication and the legacy no-generation path.
    await this.quarantineFence(client,taskId);
    const latest=(await client.query('SELECT * FROM task_native_generations WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',[taskId])).rows[0];
    if(!latest) {if(payload!==undefined) throw new ConflictFault('Generation unavailable');return;}
    exactFields(payload,['schemaVersion','generationId','executionId','publicationKey','requestSha256']);const b=payload as any;
    if(!b||b.schemaVersion!==2||latest.deployment_id!==this.deployment()||latest.id!==b.generationId||latest.execution_id!==b.executionId
      ||latest.state!=='consumed'||!latest.publication_intent||latest.publication_intent.publicationKey!==b.publicationKey
      ||latest.publication_intent.requestSha256!==b.requestSha256||latest.publication_intent.reportId!==reportId
      ||latest.actor_principal_id!==actor.principalId||latest.credential_id!==actor.credentialId||reportId===null) throw new ConflictFault('Exact current publication required');
    const task=await this.task(client,taskId,actor);await this.quarantineFence(client,taskId);
    const execution=(await client.query('SELECT * FROM task_native_executions WHERE id=$1 AND task_id=$2',[b.executionId,taskId])).rows[0];
    await this.authority(client,task,actor,execution);
    if(latest.task_digest!==this.generationTaskDigest(task)||String(latest.bound_epoch)!==task.native_epoch||execution?.state!=='closed'||execution.outcome!=='completed'||execution.report_id!==reportId
      ||!(await client.query('SELECT 1 WHERE clock_timestamp()<$1 AND clock_timestamp()<$2',[latest.expires_at,execution.hard_deadline])).rowCount) throw new ConflictFault('Publication authority expired or changed');
    await this.generationReport(client,taskId,latest,reportId,latest.publication_intent.contentSha256,actor);
    await this.authority(client,task,actor,execution);
    if(options.dryRun) {
      const open=await client.query(`SELECT 1 FROM task_native_generations WHERE ${JOINT_FINISH_OPEN}`,[latest.id,execution.hard_deadline]);
      if(open.rowCount!==1) throw new ConflictFault('Original joint finish deadline exhausted');
      return;
    }
    const finished=await client.query(`UPDATE task_native_generations SET state='finished' WHERE ${JOINT_FINISH_OPEN}`,[latest.id,execution.hard_deadline]);
    if(finished.rowCount!==1) throw new ConflictFault('Original joint finish deadline exhausted');
  }
  async quarantineImport(taskId:string,body:unknown,actor:TaskActor,dryRun:boolean) {
    validateLegacyNativeImport(body);const b=body as any;
    if(b.deploymentId!==this.deployment()||b.taskId!==taskId) throw new InvalidRequestFault('Exact deployment and Task required');
    return this.transaction(async client=>{
      await this.task(client,taskId,actor);
      const actors=await taskAuthoritySnapshot(client,actor,taskId);
      if(!actors||actors.some(x=>!x.scopes?.includes('root'))) throw new ForbiddenFault('Current privileged owner session required');
      const digest=reviewDigest(b);
      if(dryRun) return {schemaVersion:1,valid:true,manifestSha256:digest,cutoverAuthorized:false,artifactPresenceVerified:false,backendIngestionVerified:false};
      const prior=(await client.query('SELECT * FROM task_native_import_quarantine WHERE deployment_id=$1 AND store_id=$2 AND task_id=$3',[b.deploymentId,b.storeId,taskId])).rows[0];
      if(prior) {if(prior.manifest_digest!==digest) throw new ConflictFault('Quarantine snapshot differs');return {id:prior.id,manifestSha256:digest,cutoverAuthorized:false};}
      const row=(await client.query(`INSERT INTO task_native_import_quarantine(deployment_id,store_id,task_id,snapshot_digest,manifest_digest,manifest,imported_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[b.deploymentId,b.storeId,taskId,b.snapshotSha256,digest,JSON.stringify(b),actor.principalId])).rows[0];
      return {id:row.id,manifestSha256:digest,cutoverAuthorized:false,artifactPresenceVerified:false,backendIngestionVerified:false};
    });
  }
  async readQuarantine(taskId:string,id:string,actor:TaskActor) {
    return this.transaction(async client=>{
      await this.task(client,taskId,actor,false);const actors=await taskAuthoritySnapshot(client,actor,taskId);
      if(!actors||actors.some(x=>!x.scopes?.includes('root'))) throw new ForbiddenFault('Current privileged migration identity required');
      const row=(await client.query('SELECT * FROM task_native_import_quarantine WHERE id=$1 AND task_id=$2 AND deployment_id=$3',[uuid(id),taskId,this.deployment()])).rows[0];
      if(!row) throw new NotFoundFault('Quarantine not found');
      validateLegacyNativeImport(row.manifest);
      if(reviewDigest(row.manifest)!==row.manifest_digest) throw new ConflictFault('Quarantine integrity changed');
      return {id:row.id,manifestSha256:row.manifest_digest,manifest:row.manifest,cutoverAuthorized:false,artifactPresenceVerified:false,backendIngestionVerified:false};
    },true);
  }

  private async attest(client:PoolClient,row:any,body:Record<string,unknown>) {
    const slot=uuid(body.slotId),parent=body.parentSlotId===undefined?null:uuid(body.parentSlotId);
    if(!['primary','resumed','child'].includes(String(body.relationship)) || (body.relationship==='child')!==(parent!==null) || parent===slot) throw new InvalidRequestFault('Explicit native slot relationship required');
    exactFields(body.correlation,['session_id','conversation_id']);
    const correlation=body.correlation;
    for(const key of ['session_id','conversation_id']) {
      const value=correlation[key];
      if((key==='session_id' || value!==undefined) && (typeof value!=='string' || !CORRELATION_ID_RE.test(value))) throw new InvalidRequestFault('Actual bounded native init identity required');
    }
    const seed=correlation as {session_id:string;conversation_id?:string};
    const prior=(await client.query('SELECT * FROM task_native_execution_sessions WHERE execution_id=$1 ORDER BY attested_at',[row.id])).rows;
    if(parent && !prior.some(p=>p.slot_id===parent)) throw new ConflictFault('Parent session slot unavailable');
    const segments=prior.filter(p=>p.slot_id===slot);
    if(!segments.length && new Set(prior.map(p=>p.slot_id)).size>=16) throw new ConflictFault('Execution session slot limit reached');
    const pepper=activeTelemetryPepperId(),ref=telemetrySessionReference(row.source_product,seed,pepper);
    for(const previous of segments) {
      if(previous.relationship!==body.relationship || previous.parent_slot_id!==parent || new Date(previous.expires_at)<=new Date()) throw new ConflictFault('Session slot changed or expired');
    }
    const sameKey=segments.find(previous=>previous.pepper_id===pepper);
    if(sameKey) {
      if(sameKey.session_ref!==ref) throw new ConflictFault('Native session changed within slot');
      return; // Exact retry does not require a retired historical pepper or extend retention.
    }
    const previous=segments[segments.length-1];
    if(previous) {
      let previousRef:string|null;
      try {previousRef=telemetrySessionReference(row.source_product,seed,previous.pepper_id);} catch {throw new ConflictFault('Prior pepper unavailable; correlation cannot be rebound');}
      if(previousRef!==previous.session_ref) throw new ConflictFault('Native session changed within slot');
    }
    const expiry=segments.length?segments[0].expires_at:telemetryEventExpiry(new Date());
    await client.query(`INSERT INTO task_native_execution_sessions(execution_id,slot_id,parent_slot_id,relationship,connector_id,account_id,source_product,session_ref,pepper_id,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(execution_id,slot_id,pepper_id) DO NOTHING`,[row.id,slot,parent,body.relationship,row.connector_id,row.account_id,row.source_product,ref,pepper,expiry]);
  }
  async list(taskId:string,actor:TaskActor) {
    return this.transaction(async client=>{
      const task=await this.task(client,taskId,actor,false);
      const rows=(await client.query('SELECT * FROM task_native_executions WHERE task_id=$1 ORDER BY run_ordinal DESC LIMIT 50',[taskId])).rows;
      const scope=actor.authorization && telemetryReadScopeFor(actor.authorization);
      const mayRead=actor.authorization && authorizationService.authorizeRoute(actor.authorization,'services:read').allowed;
      const result=[];
      for(const row of rows) {
        let session:Record<string,unknown>={state:'unavailable'};
        if(!mayRead || !scope || (scope.kind==='account' && scope.accountId!==row.account_id)) session={state:'restricted'};
        else {
          const links=(await client.query('SELECT * FROM task_native_execution_sessions WHERE execution_id=$1 ORDER BY attested_at',[row.id])).rows;
          const sessions=[];
          for(const link of links) {
            if(new Date(link.expires_at)<=new Date()) {sessions.push({state:'expired'});continue;}
            const key={connectorId:link.connector_id,sourceProduct:link.source_product,sessionRef:link.session_ref};
            const observed=await telemetryProjectionService.session(scope,key,{events:1});
            sessions.push({state:observed?'available':'attested_unobserved',slotId:link.slot_id,parentSlotId:link.parent_slot_id,relationship:link.relationship,...(observed?key:{}),expiresAt:link.expires_at});
          }
          session=sessions.length?{state:'attested',sessions}:{state:row.session_expires_at?'expired':'unavailable'};
        }
        const reportId=row.report_id && (await authorizationRepository.authorizedIds(actor.authorization!,'report',[row.report_id],'read',client)).has(row.report_id)?row.report_id:null;
        result.push({...this.publicRow(row),reportId,session});
      }
      return {assignmentEpoch:task.native_epoch,serviceId:task.execution_service_id,descriptorVersion:task.execution_descriptor_version,executions:result};
    },true);
  }
}
export const nativeExecutionService=new NativeExecutionService();
