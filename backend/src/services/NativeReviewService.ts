import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';
import type { TaskActor } from './TaskHistoryService';
import { taskHistoryService } from './TaskHistoryService';
import { reportManager } from './ReportManager';
import { taskAuthoritySnapshot } from './TaskAuthoritySnapshot';
import { assertTaskCompletionAuthority } from './TaskCompletionAuthority';
import { verifierStanding } from './VerificationModes';
import { authorizationRepository } from './AuthorizationRepository';
import { authorizationService } from './AuthorizationService';
import { taskManagerDB } from './TaskManagerDB';
import { TaskReviewAttemptService, hashReviewReports } from './TaskReviewAttemptService';
import { telemetryPrincipalService } from './TelemetryPrincipalService';
import { productIsDeclared } from './TelemetryDescriptorPolicy';
import { telemetryReadScopeFor } from './TelemetryReadScope';
import { telemetryProjectionService } from './TelemetryProjectionService';
import { activeTelemetryPepperId, telemetrySessionReference } from '../utils/telemetryPepper';
import { telemetryEventExpiry } from '../utils/telemetryRetention';
import { feedEventService, feedActorFields } from './FeedEventService';
import { ConflictFault, ForbiddenFault, InvalidRequestFault, NotFoundFault } from '../utils/httpErrors';
import { exactFields, NATIVE_REVIEW_INPUT_REPORTS_SQL, NATIVE_REVIEW_LEASE_SECONDS, nativeReviewScope, reviewDigest, validateNativeVerdict } from '../utils/nativeReview';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEASE = /^[0-9a-f]{64}$/;
/** Card e5240c73: the pause before the one retry of a refused dependency share lock. */
export const NATIVE_REVIEW_DEPENDENCY_RETRY_MS = 250;
const DEPENDENCY_EVIDENCE_SQL = `SELECT d.depends_on_task_id, t.status, t.updated_at, t.archived_at
      FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=$1
      ORDER BY d.depends_on_task_id`;
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InvalidRequestFault('Expected UUID');
  return value;
}

/** Verification never claims or modifies the implementation execution profile.
 * Authority is re-resolved at every decision; authority revocation is not a
 * globally serialized credential/grant transaction. Evidence IS serialized. */
export class NativeReviewService {
  constructor(private readonly pool: Pool = defaultPool) {}
  private async transaction<T>(operation: (client: PoolClient, afterCommit: (effect:()=>void|Promise<void>)=>void) => Promise<T>, readOnly = false): Promise<T> {
    const client = await this.pool.connect();
    const effects:Array<()=>void|Promise<void>>=[];
    try { await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN'); await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s'"); const result = await operation(client,effect=>effects.push(effect)); await client.query('COMMIT'); for(const effect of effects) { try { await effect(); } catch { /* A notifier cannot undo a committed verdict. */ } } return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  private async task(client: PoolClient, taskId: string, lock = true) {
    const result = await client.query('SELECT * FROM tasks WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [uuid(taskId)]);
    if (!result.rows[0]) throw new NotFoundFault('Task not found');
    return result.rows[0];
  }
  private async capability(client: PoolClient, serviceId: string, version: number, verifier: string) {
    const result = await client.query(`SELECT s.*, d.descriptor, d.retired_at AS descriptor_retired
      FROM services s JOIN service_descriptor_versions d ON d.service_id=s.id AND d.version=$2
      WHERE s.id=$1 FOR SHARE OF s,d`, [uuid(serviceId), version]);
    const service = result.rows[0];
    if (!service || service.status !== 'published' || service.kind !== 'connector'
      || service.principal_id !== verifier || service.current_descriptor_version !== version || service.retired_at || service.descriptor_retired
      || service.descriptor?.nativeReview?.protocolVersion !== 1) {
      throw new ConflictFault('Current registered Connector does not support this native review pin', 'NATIVE_REVIEW_CAPABILITY_UNAVAILABLE');
    }
    return service;
  }
  private async evidence(client: PoolClient, task: any, lock = true) {
    if (lock) {
    const locked = await client.query('SELECT pg_try_advisory_xact_lock(1397653301, hashtext($1::text)) AS acquired', [task.id]);
    if (!locked.rows[0]?.acquired) throw new ConflictFault('Task review evidence is busy');
    }
    const subtasks = (await client.query('SELECT * FROM subtasks WHERE task_id=$1 ORDER BY index' + (lock ? ' FOR UPDATE' : ''), [task.id])).rows;
    const references = (await client.query('SELECT * FROM task_references WHERE task_id=$1 ORDER BY id' + (lock ? ' FOR UPDATE' : ''), [task.id])).rows;
    const dependencies = lock ? await this.lockedDependencies(client, task.id)
      : (await client.query(DEPENDENCY_EVIDENCE_SQL, [task.id])).rows;
    if (dependencies.some(row => row.status !== 'completed' && !row.archived_at)) throw new ConflictFault('Task dependencies are not satisfied');
    const reportRefs = references.filter(row => row.kind === 'report' && row.target_id).map(row => row.target_id);
    const reports = (await client.query(NATIVE_REVIEW_INPUT_REPORTS_SQL + (lock ? ' FOR SHARE NOWAIT' : ''), [task.id])).rows;
    if (!reports.length || reportRefs.some(id => !reports.some(row => row.id === id))) throw new ConflictFault('Review requires available linked Report evidence');
    const { scope, criteria } = nativeReviewScope(task, subtasks.map(s => ({...s, text:s.title})));
    const inputDigest = reviewDigest({ task, subtasks, references, dependencies, reports, scope, criteria });
    return { inputDigest, scope, criteria, reports, reportDigest: hashReviewReports(reports) };
  }
  /** Dependency Tasks are share-locked NOWAIT, so evidence never waits on them
   * (no wait edge). A dashboard GET /tasks/:id holds a Task row for the few
   * statements of its display projection (card e5240c73), so one refused
   * attempt is rolled back to a savepoint and retried once after a short pause.
   * A second refusal is surfaced as 409 NATIVE_REVIEW_EVIDENCE_BUSY. */
  private async lockedDependencies(client: PoolClient, taskId: string): Promise<any[]> {
    for (let attempt = 1; ; attempt++) {
      await client.query('SAVEPOINT native_review_dependencies');
      try {
        const result = await client.query(`${DEPENDENCY_EVIDENCE_SQL} FOR SHARE OF d,t NOWAIT`, [taskId]);
        await client.query('RELEASE SAVEPOINT native_review_dependencies');
        return result.rows;
      } catch (error) {
        if ((error as { code?: unknown })?.code !== '55P03') throw error;
        await client.query('ROLLBACK TO SAVEPOINT native_review_dependencies');
        await client.query('RELEASE SAVEPOINT native_review_dependencies');
        if (attempt >= 2) throw new ConflictFault('A dependency Task is held by another transaction; retry the review', 'NATIVE_REVIEW_EVIDENCE_BUSY');
        await new Promise(resolve => setTimeout(resolve, NATIVE_REVIEW_DEPENDENCY_RETRY_MS));
      }
    }
  }
  private async current(client: PoolClient, task: any, request: any, actor: TaskActor) {
    // Section 6.8 (E462 S4b): the requested Verifier, or a `verifier-agent` of
    // it; the completion check below applies the chain guard to both.
    if (request.verifier_principal_id !== task.verifier_principal_id
      || !(await verifierStanding(client, task, actor.principalId))) throw new ForbiddenFault('Only the requested Verifier may execute');
    await assertTaskCompletionAuthority(client, task, actor);
    const service = await this.capability(client, request.service_id, request.descriptor_version, task.verifier_principal_id);
    const actors = await taskAuthoritySnapshot(client, actor, task.id);
    if (!actors) throw new ForbiddenFault('Current review authority is unavailable');
    for (const value of actors) {
      if (!authorizationService.authorizeRoute(value, 'reports:write').allowed
        || !authorizationService.authorizeRoute(value, 'services:invoke').allowed
        || !(await authorizationRepository.authorizedIds(value, 'service', [service.id], 'invoke', client)).has(service.id)) {
        throw new ForbiddenFault('Current Service invocation authority is required');
      }
      const readable=await authorizationRepository.authorizedIds(value,'report',request.report_ids,'read',client);
      if(readable.size!==request.report_ids.length) throw new ForbiddenFault('Review input Reports are restricted');
    }
    return service;
  }
  async request(taskId: string, body: unknown, actor: TaskActor) {
    exactFields(body, ['serviceId', 'descriptorVersion', 'requestKey', 'expectedInputDigest']);
    const serviceId = uuid(body.serviceId), requestKey = uuid(body.requestKey);
    if (!Number.isInteger(body.descriptorVersion) || Number(body.descriptorVersion) < 1) throw new InvalidRequestFault('Descriptor version required');
    return this.transaction(async client => {
      const task = await this.task(client, taskId);
      const actors = await taskAuthoritySnapshot(client, actor, taskId);
      if (!actors || task.archived_at || !task.verifier_principal_id
        || task.verifier_principal_id === task.owner_principal_id) throw new ForbiddenFault('Task needs an independent assigned Verifier in Review');
      for (const value of actors) {
        const action = (await verifierStanding(client, task, actor.principalId)) ? 'verify' : 'shepherd';
        if (!(await authorizationRepository.authorizedIds(value, 'task', [taskId], action, client)).has(taskId)
          || !authorizationService.authorizeRoute(value, 'services:invoke').allowed
          || !(await authorizationRepository.authorizedIds(value, 'service', [serviceId], 'invoke', client)).has(serviceId)) {
          throw new ForbiddenFault('Review dispatch requires Task and Service authority');
        }
      }
      const prior = (await client.query('SELECT * FROM task_native_reviews WHERE request_key=$1', [requestKey])).rows[0];
      if (prior) {
        if (prior.task_id !== taskId || prior.service_id !== serviceId || prior.descriptor_version !== body.descriptorVersion
          || prior.input_digest !== body.expectedInputDigest || prior.requested_by_principal_id !== actor.principalId) throw new ConflictFault('Request key conflict');
        return this.publicRequest(prior);
      }
      await this.capability(client, serviceId, Number(body.descriptorVersion), task.verifier_principal_id);
      if(task.status!=='review') throw new ConflictFault('Task must be in Review before dispatch');
      const input = await this.evidence(client, task);
      if (input.inputDigest !== body.expectedInputDigest) throw new ConflictFault('Task review inputs changed', 'NATIVE_REVIEW_INPUT_CHANGED');
      await client.query(`UPDATE task_native_reviews SET state=CASE WHEN state='pending' THEN 'expired' ELSE 'uncertain' END, finished_at=NOW()
        WHERE task_id=$1 AND ((state='pending' AND request_expires_at<=NOW()) OR (state IN ('leased','attested') AND lease_expires_at<=NOW()))`, [taskId]);
      // Unknown launch is not automatically eligible for another request.
      if ((await client.query("SELECT id FROM task_native_reviews WHERE task_id=$1 AND state IN ('pending','leased','attested','uncertain')", [taskId])).rowCount) throw new ConflictFault('Existing review requires reconciliation');
      const result = await client.query(`INSERT INTO task_native_reviews(task_id,service_id,descriptor_version,verifier_principal_id,requested_by_principal_id,request_key,input_digest,criteria,report_ids,review_scope)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [taskId,serviceId,body.descriptorVersion,task.verifier_principal_id,actor.principalId,requestKey,input.inputDigest,JSON.stringify(input.criteria),input.reports.map(r => r.id),JSON.stringify(input.scope)]);
      await feedEventService.emit(client, { name:'task.review_requested',objectType:'task',objectId:taskId,...feedActorFields(actor),projectId:task.project_id,ownerPrincipalId:task.owner_principal_id,payload:{ reviewId:result.rows[0].id, serviceId } });
      return this.publicRequest(result.rows[0]);
    });
  }
  private publicRequest(row: any) {
    const state=row.state==='pending' && new Date(row.request_expires_at)<=new Date()?'expired'
      :['leased','attested'].includes(row.state) && new Date(row.lease_expires_at)<=new Date()?'uncertain':row.state;
    return { id:row.id,taskId:row.task_id,purpose:'verification',serviceId:row.service_id,descriptorVersion:row.descriptor_version,
      verifierPrincipalId:row.verifier_principal_id,state,reviewScope:row.review_scope,inputDigest:row.input_digest,criteria:row.criteria,reportIds:row.report_ids,
      leaseExpiresAt:row.lease_expires_at,requestExpiresAt:row.request_expires_at,createdAt:row.created_at,finishedAt:row.finished_at,reviewAttemptId:row.review_attempt_id,verdict:row.verdict };
  }
  async capabilities(taskId:string,actor:TaskActor) {
    const rows=(await this.pool.query(`SELECT s.id,s.name,d.version FROM tasks t JOIN services s ON s.principal_id=t.verifier_principal_id
      JOIN service_descriptor_versions d ON d.service_id=s.id AND d.version=s.current_descriptor_version
      WHERE t.id=$1 AND s.kind='connector' AND s.status='published' AND s.retired_at IS NULL AND d.retired_at IS NULL
      AND d.descriptor->'nativeReview'->>'protocolVersion'='1'`,[uuid(taskId)])).rows;
    const allowed=await authorizationRepository.authorizedIds(actor.authorization!,'service',rows.map(r=>r.id),'read');
    return rows.filter(row=>allowed.has(row.id));
  }
  async inputs(taskId: string, actor: TaskActor) {
    return this.transaction(async client => {
      const task = await this.task(client, taskId, false);
      const actors = await taskAuthoritySnapshot(client, actor, taskId);
      if (!actors) throw new ForbiddenFault('Task review authority required');
      for (const value of actors) {
        const action = (await verifierStanding(client, task, actor.principalId)) ? 'verify' : 'shepherd';
        if (!(await authorizationRepository.authorizedIds(value,'task',[taskId],action,client)).has(taskId)) throw new ForbiddenFault('Task review authority required');
      }
      const input = await this.evidence(client, task, false);
      // Respect each Report's own visibility before exposing its digest/ID.
      for (const value of actors) {
        const allowed = await authorizationRepository.authorizedIds(value,'report',input.reports.map(r=>r.id),'read',client);
        if (allowed.size !== input.reports.length) throw new ForbiddenFault('Review input Reports are restricted');
      }
      return { inputDigest:input.inputDigest,reviewScope:input.scope,criteria:input.criteria,reportIds:input.reports.map(r=>r.id) };
    }, true);
  }
  async pull(serviceId: string, actor: TaskActor) {
    const rows = (await this.pool.query(`SELECT id,task_id FROM task_native_reviews WHERE service_id=$1 AND verifier_principal_id=$2
      AND state='pending' AND request_expires_at>NOW() ORDER BY created_at LIMIT 50`, [uuid(serviceId),actor.principalId])).rows;
    const result = [];
    for (const row of rows) {
      try { result.push(await this.transaction(async client => {
        const task=await this.task(client,row.task_id);
        const request=(await client.query('SELECT * FROM task_native_reviews WHERE id=$1', [row.id])).rows[0];
        await this.current(client,task,request,actor); return this.publicRequest(request);
      })); } catch (error) { if (!(error instanceof ForbiddenFault || error instanceof ConflictFault)) throw error; }
    }
    return result;
  }
  /** Never-leased cancellation needs no claim about provider termination: the server
   * has never issued launch authority. Leased uncertainty uses authored reconciliation. */
  async cancel(taskId:string,reviewId:string,body:unknown,actor:TaskActor) {
    exactFields(body,['inputDigest']);
    return this.transaction(async client=>{
      const task=await this.task(client,taskId);
      const request=(await client.query('SELECT * FROM task_native_reviews WHERE id=$1 AND task_id=$2 FOR UPDATE',[uuid(reviewId),taskId])).rows[0];
      if(!request || request.input_digest!==body.inputDigest) throw new ConflictFault('Cancellation input mismatch');
      const actors=await taskAuthoritySnapshot(client,actor,taskId);
      if(!actors) throw new ForbiddenFault('Current cancellation authority required');
      for(const value of actors) {
        const action=actor.principalId===task.verifier_principal_id?'verify':'shepherd';
        if(!(await authorizationRepository.authorizedIds(value,'task',[taskId],action,client)).has(taskId)) throw new ForbiddenFault('Current cancellation authority required');
      }
      if(request.state==='cancelled' && request.reconciliation?.outcome==='never-leased') return this.publicRequest(request);
      if(!['pending','expired'].includes(request.state) || request.lease_hash || request.lease_expires_at) throw new ConflictFault('Leased execution requires explicit reconciliation');
      const result=await client.query("UPDATE task_native_reviews SET state='cancelled',finished_at=NOW(),reconciliation=$2 WHERE id=$1 RETURNING *",[reviewId,JSON.stringify({outcome:'never-leased',actorPrincipalId:actor.principalId})]);
      await taskHistoryService.recordChange(taskId,task.title,'native-review-cancelled',request.state,'cancelled',actor.handle,actor.principalId,client);
      return this.publicRequest(result.rows[0]);
    });
  }
  /** Explicit operator attestation of stopped/absent execution. It closes an
   * uncertain request, never approves work, and never dispatches its successor. */
  async reconcile(taskId:string,reviewId:string,body:unknown,actor:TaskActor) {
    exactFields(body,['evidenceReportId','inputDigest']);
    const reportId=uuid(body.evidenceReportId);
    return this.transaction(async client=>{
      const task=await this.task(client,taskId);
      const request=(await client.query('SELECT * FROM task_native_reviews WHERE id=$1 AND task_id=$2 FOR UPDATE',[uuid(reviewId),taskId])).rows[0];
      if(!request || request.input_digest!==body.inputDigest) throw new ConflictFault('Reconciliation input mismatch');
      const actors=await taskAuthoritySnapshot(client,actor,taskId);
      if(!actors) throw new ForbiddenFault('Current reconciliation authority required');
      for(const value of actors) {
        const action=actor.principalId===task.verifier_principal_id?'verify':'shepherd';
        if(!(await authorizationRepository.authorizedIds(value,'task',[taskId],action,client)).has(taskId)
          || !(await authorizationRepository.authorizedIds(value,'report',[reportId],'read',client)).has(reportId)) throw new ForbiddenFault('Current reconciliation authority required');
      }
      if(request.state==='cancelled' && request.reconciliation?.evidenceReportId===reportId) return this.publicRequest(request);
      if(request.state!=='uncertain' && !(['leased','attested'].includes(request.state) && new Date(request.lease_expires_at)<=new Date())) throw new ConflictFault('Only uncertain or expired execution may be reconciled');
      const report=(await client.query(`SELECT id,content,author_principal_id FROM reports WHERE id=$1 AND $2::uuid=ANY(task_ids)
        AND deleted_at IS NULL FOR SHARE NOWAIT`,[reportId,taskId])).rows[0];
      if(!report || report.author_principal_id!==actor.principalId || !report.content.trim()) throw new ForbiddenFault('Reconciliation requires the acting principal’s linked evidence Report');
      const receipt={evidenceReportId:reportId,evidenceDigest:reviewDigest(report.content),actorPrincipalId:actor.principalId,outcome:'closed-without-verdict'};
      const result=await client.query("UPDATE task_native_reviews SET state='cancelled',reconciliation=$2,finished_at=NOW() WHERE id=$1 RETURNING *",[reviewId,JSON.stringify(receipt)]);
      await taskHistoryService.recordChange(taskId,task.title,'native-review-reconciled',request.state,'cancelled',actor.handle,actor.principalId,client);
      return this.publicRequest(result.rows[0]);
    });
  }
  async act(taskId:string, reviewId:string, action:'lease'|'attest'|'verdict'|'uncertain', body:unknown, actor:TaskActor) {
    exactFields(body, action==='attest' ? ['leaseToken','correlation'] : action==='verdict' ? ['leaseToken','inputDigest','verdict'] : ['leaseToken']);
    if (typeof body.leaseToken!=='string' || !LEASE.test(body.leaseToken)) throw new InvalidRequestFault('A 32-byte lease token is required');
    return this.transaction(async (client,afterCommit) => {
      const task=await this.task(client,taskId);
      const request=(await client.query('SELECT * FROM task_native_reviews WHERE id=$1 AND task_id=$2 FOR UPDATE', [uuid(reviewId),taskId])).rows[0];
      if (!request) throw new NotFoundFault('Review request not found');
      const leaseHash=reviewDigest(body.leaseToken);
      if (action==='verdict' && ['passed','rejected'].includes(request.state)) {
        const actors=await taskAuthoritySnapshot(client,actor,taskId);
        if(!actors || task.verifier_principal_id!==actor.principalId || task.owner_principal_id===actor.principalId) throw new ForbiddenFault('Current independent Verifier required');
        for(const value of actors) if(!(await authorizationRepository.authorizedIds(value,'task',[taskId],'verify',client)).has(taskId)) throw new ForbiddenFault('Current verification authority required');
        if (request.verifier_principal_id!==actor.principalId || request.lease_hash!==leaseHash || request.input_digest!==body.inputDigest
          || reviewDigest(request.verdict?.submission)!==reviewDigest(body.verdict)) throw new ConflictFault('Verdict retry conflicts');
        return this.publicRequest(request);
      }
      const service=await this.current(client,task,request,actor);
      if (action==='lease') {
        if (request.state==='leased' && request.lease_hash===leaseHash && new Date(request.lease_expires_at)>new Date()) return this.publicRequest(request);
        if (request.state!=='pending' || new Date(request.request_expires_at)<=new Date()) throw new ConflictFault('Review cannot be leased again');
        const input=await this.evidence(client,task);
        if (input.inputDigest!==request.input_digest) throw new ConflictFault('Review inputs changed');
        const allowed=await authorizationRepository.authorizedIds(actor.authorization!,'report',request.report_ids,'read',client);
        if (allowed.size!==request.report_ids.length) throw new ForbiddenFault('Review evidence is restricted');
        const result=await client.query(`UPDATE task_native_reviews SET state='leased',lease_hash=$2,lease_expires_at=NOW()+$3*INTERVAL '1 second' WHERE id=$1 RETURNING *`,[reviewId,leaseHash,NATIVE_REVIEW_LEASE_SECONDS]);
        return this.publicRequest(result.rows[0]);
      }
      if (request.lease_hash!==leaseHash || !['leased','attested'].includes(request.state) || new Date(request.lease_expires_at)<=new Date()) throw new ConflictFault('Review lease unavailable; reconcile, never relaunch');
      if (action==='uncertain') {
        const result=await client.query("UPDATE task_native_reviews SET state='uncertain',finished_at=NOW() WHERE id=$1 RETURNING *",[reviewId]);
        return this.publicRequest(result.rows[0]);
      }
      if (action==='attest') {
        exactFields(body.correlation,['session_id','conversation_id']);
        const correlation=body.correlation as {session_id?:unknown;conversation_id?:unknown};
        if (typeof correlation.session_id!=='string' || !correlation.session_id || correlation.session_id.length>256
          || (correlation.conversation_id!==undefined && (typeof correlation.conversation_id!=='string' || !correlation.conversation_id || correlation.conversation_id.length>256))) throw new InvalidRequestFault('Actual native init correlation required');
        if (!authorizationService.authorizeRoute(actor.authorization!,'telemetry:write').allowed) throw new ForbiddenFault('Telemetry write scope required');
        const derived=await telemetryPrincipalService.derive({actingPrincipalId:actor.principalId!,delegationLinks:actor.authorization?.delegation?.links});
        const product=service.descriptor.nativeReview.sourceProduct;
        if (!derived.ok || derived.binding.connectorId!==actor.principalId || !productIsDeclared(derived.descriptor,product)) throw new ForbiddenFault('Native session identity/product unavailable');
        const pepper=activeTelemetryPepperId();
        const sessionRef=telemetrySessionReference(product,correlation as {session_id:string;conversation_id?:string},pepper);
        const prior=(await client.query('SELECT * FROM task_native_review_sessions WHERE review_id=$1',[reviewId])).rows;
        // A generation cannot be rebound to another real session. Rotation
        // requires a fresh explicit review, not an inferred cross-key match.
        if (prior.some(row=>row.pepper_id!==pepper || row.session_ref!==sessionRef)) throw new ConflictFault('Session attestation differs or pepper rotated');
        const expiry=telemetryEventExpiry(new Date());
        await client.query(`INSERT INTO task_native_review_sessions(review_id,connector_id,account_id,source_product,session_ref,pepper_id,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[reviewId,derived.binding.connectorId,derived.binding.accountId,product,sessionRef,pepper,expiry]);
        const result=await client.query("UPDATE task_native_reviews SET state='attested',session_expires_at=COALESCE(session_expires_at,$2) WHERE id=$1 RETURNING *",[reviewId,expiry]);
        return this.publicRequest(result.rows[0]);
      }
      if (request.state!=='attested' || body.inputDigest!==request.input_digest) throw new ConflictFault('Verdict needs an attested session and exact input digest');
      const input=await this.evidence(client,task);
      if (input.inputDigest!==request.input_digest) throw new ConflictFault('Task or evidence changed before verdict','NATIVE_REVIEW_INPUT_CHANGED');
      const verdict=validateNativeVerdict(body.verdict,request.criteria,request.report_ids);
      const hydrated=await taskManagerDB.getTask(taskId,client);
      if (!hydrated) throw new NotFoundFault('Task not found');
      const ledger=new TaskReviewAttemptService(this.pool);
      const attempt=await ledger.beginAttempt(hydrated,{nativeReviewId:reviewId,inputDigest:input.inputDigest,reportDigest:input.reportDigest,reviewScope:input.scope},client,input.scope);
      const result=await ledger.recordVerdict(attempt.id,verdict.decision,verdict.criteria,verdict,undefined,verdict.decision==='reject',client,actor);
      if (!result.applied) throw new ConflictFault('Review ledger already resolved');
      await taskHistoryService.recordChange(taskId,task.title,'status','review',result.status,actor.handle,actor.principalId,client);
      // Output is created after validating all input hashes, in the same
      // transaction. It is not part of its own immutable input manifest.
      const report=await reportManager.create({title:`Native verification ${reviewId}`,content:JSON.stringify({protocol:'rh.native-review/1',reviewId,inputDigest:input.inputDigest,reviewAttemptId:attempt.id,reviewScope:input.scope,taskStatus:result.status,verdict},null,2),summary:verdict.summary.slice(0,500),task_ids:[taskId],project_id:task.project_id,author:actor.handle,author_actor_id:actor.handle,author_principal_id:actor.principalId!,origin:'api',visibility:task.visibility||'default'}, {client,actor,afterCommit});
      const updated=await client.query(`UPDATE task_native_reviews SET state=$2,review_attempt_id=$3,verdict=$4,finished_at=NOW() WHERE id=$1 RETURNING *`,[reviewId,verdict.decision==='pass'?'passed':'rejected',attempt.id,JSON.stringify({submission:body.verdict,actorPrincipalId:actor.principalId,reportId:report.id,result})]);
      return this.publicRequest(updated.rows[0]);
    });
  }
  async list(taskId:string, actor:TaskActor) {
    const rows=(await this.pool.query('SELECT * FROM task_native_reviews WHERE task_id=$1 ORDER BY created_at DESC LIMIT 50',[uuid(taskId)])).rows;
    const scope=actor.authorization && telemetryReadScopeFor(actor.authorization);
    const mayRead=actor.authorization && authorizationService.authorizeRoute(actor.authorization,'services:read').allowed;
    const result=[];
    for(const row of rows) {
      const links=(await this.pool.query('SELECT * FROM task_native_review_sessions WHERE review_id=$1 ORDER BY attested_at DESC',[row.id])).rows;
      const link=links[0];
      // Scope precedes retention: denied readers must not learn that a session expired.
      const restricted=!mayRead || !scope || (scope.kind==='account' && (!link || scope.accountId!==link.account_id));
      let session:Record<string,unknown>=restricted?{state:'restricted'}:
        {state: row.session_expires_at && new Date(row.session_expires_at)<=new Date()?'expired':row.state==='pending'?'not-started':'unavailable'};
      if(link && !restricted) {
        if(new Date(link.expires_at)<=new Date()) session={state:'expired'};
        else {
          const key={sessionRef:link.session_ref,connectorId:link.connector_id,sourceProduct:link.source_product};
          const detail=await telemetryProjectionService.session(scope,key,{events:1});
          session=detail?{state:'available',...key}:{state:'unavailable'};
        }
      }
      const readable=await authorizationRepository.authorizedIds(actor.authorization!,'report',row.report_ids,'read');
      const outputId=row.verdict?.reportId;
      const outputReadable=outputId && (await authorizationRepository.authorizedIds(actor.authorization!,'report',[outputId],'read')).has(outputId);
      const publicRow=this.publicRequest(row);
      result.push({...publicRow,reportIds:row.report_ids.filter((id:string)=>readable.has(id)),verdict:outputReadable?publicRow.verdict:null,session});
    }
    return result;
  }
}
export const nativeReviewService=new NativeReviewService();
