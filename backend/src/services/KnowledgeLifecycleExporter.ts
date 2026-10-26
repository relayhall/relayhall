import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from '../db/connection';
import { pairwiseSubject } from './KnowledgeAssertionSigner';
import { isKnowledgeCapable } from './KnowledgeSourcePolicy';
import { OPAQUE_COMPARTMENT_PATTERN } from './KnowledgeV2';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { auditService } from './AuditService';

type Grant = { subject_type: 'user'|'group'; subject_id: string; operation: 'read'|'write'; consent_ref: string };
type Consent = { owner_id: string; reader_id: string; consent_ref: string };
export interface LifecycleExportConfig {
  accountSelection?: 'explicit'|'all-human'; projectSelection?: 'explicit'|'all-projects';
  enabled: boolean; sourceId: string; sourceConfigVersion: string; expectedServiceRevision: string;
  issuer: string; actorRef: string; accountIds: string[]; projectIds: string[];
  projectGrants: { projectId: string; grants: Grant[] }[]; personalConsents: Consent[];
  keyRef: string; kid: string; outputPath: string; generationPath: string;
}
export interface LifecycleRows {
  source: { id:string; slug:string; status:string; retired_at:unknown; descriptor_retired_at?:unknown; revision:string; knowledge_query_endpoint:string;
    knowledge_claims_mode:string; knowledge_subject_mode:string; knowledge_relevant_groups:string[]; descriptor:any };
  accounts: {id:string;display_name:string|null;handle:string;status:string;kind:string}[];
  projects: {id:string;name:string;status:string}[];
  groups: {id:string}[];
  /** Card 549cc51f: the unexpired Account ids on the source's organisation
   * writer list (readLifecycleSharedWriters). Optional: absent = an empty list. */
  sharedWriters?: string[];
  /** Card 502fb19e (E308, change-request design section 7.2): the unexpired
   * rows of the core table knowledge_compartment_grants
   * (readLifecycleCompartmentGrants). When present they are emitted as
   * projects[].grants IN PLACE of the configuration's projectGrants; when
   * absent the configuration is read (the form before the carry-over, and the
   * other side of the carry-over's read-back). */
  compartmentGrants?: CompartmentGrantRow[];
  /** Card 502fb19e (E308, section 7.3): the rows of the core table
   * knowledge_personal_consents, emitted in place of personalConsents when present. */
  personalConsents?: Consent[];
}
/** One row of knowledge_compartment_grants as the snapshot reads it. */
export interface CompartmentGrantRow extends Grant { project_id: string; approval_id: string | null }
/** The writer-list rows one snapshot may carry before the export refuses (the payload's own cap). */
export const LIFECYCLE_SHARED_WRITER_CAP=10000;
/** The compartment rows one snapshot may read before the export refuses (validateLifecycleConfig's own bound). */
export const LIFECYCLE_COMPARTMENT_GRANT_CAP=100000;
const fail = (): never => { throw new Error('LIFECYCLE_EXPORT_REFUSED'); };
/** JSON duplicate keys are rejected before configuration/snapshot shape use. */
export function parseLifecycleJson(text: string): unknown {
  if (Buffer.byteLength(text)>8*1024*1024) return fail();
  let at=0;
  const ws=()=>{while(/\s/.test(text[at]??'')&&at<text.length)at++;};
  const string=():string=>{const start=at++;while(at<text.length){if(text[at]==='\\'){at+=2;continue;}if(text[at++]==='"')return JSON.parse(text.slice(start,at));}return fail();};
  const value=():unknown=>{
    ws();const c=text[at];
    if(c==='"')return string();
    if(c==='{'){at++;const out:Record<string,unknown>={};const seen=new Set<string>();ws();if(text[at]==='}'){at++;return out;}for(;;){ws();if(text[at]!=='"')return fail();const k=string();if(seen.has(k))return fail();seen.add(k);ws();if(text[at++]!==':')return fail();Object.defineProperty(out,k,{value:value(),enumerable:true});ws();const next=text[at++];if(next==='}')return out;if(next!==',')return fail();}}
    if(c==='['){at++;const out:unknown[]=[];ws();if(text[at]===']'){at++;return out;}for(;;){out.push(value());ws();const next=text[at++];if(next===']')return out;if(next!==',')return fail();}}
    const token=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));if(!token)return fail();at+=token[0].length;return JSON.parse(token[0]);
  };
  const out=value();ws();if(at!==text.length)return fail();return out;
}
function privateText(file:string, authority=false):string {
  if(!path.isAbsolute(file))return fail();
  for (let directory=path.dirname(file);;directory=path.dirname(directory)) {
    const ancestor=fs.lstatSync(directory);
    if(!ancestor.isDirectory()||ancestor.isSymbolicLink()||(ancestor.mode&0o022)!==0||!(authority?[0]:[0,process.getuid?.()]).includes(ancestor.uid))return fail();
    if(directory===path.dirname(directory))break;
  }
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||(authority ? ((stat.mode&0o027)!==0 || ((stat.mode&0o040)!==0 && stat.gid!==process.getgid?.())) : (stat.mode&0o077)!==0)||!((authority?[0]:[0,process.getuid?.()]).includes(stat.uid))||stat.size>8*1024*1024)return fail();
  return fs.readFileSync(file,'utf8');
}
export function validateLifecycleConfig(raw:unknown):LifecycleExportConfig {
  const c=raw as LifecycleExportConfig;
  if(!c||typeof c.enabled!=='boolean'||!OPAQUE_COMPARTMENT_PATTERN.test(c.sourceId)||typeof c.sourceConfigVersion!=='string'||!c.sourceConfigVersion.length||c.sourceConfigVersion.length>256
    ||typeof c.expectedServiceRevision!=='string'||!OPAQUE_COMPARTMENT_PATTERN.test(c.expectedServiceRevision)
    ||typeof c.issuer!=='string'||!c.issuer.length||typeof c.actorRef!=='string'||!c.actorRef.length||c.actorRef.length>256
    ||typeof c.kid!=='string'||!c.kid.length||typeof c.keyRef!=='string'||!c.keyRef.startsWith('file:'))return fail();
  for(const values of [c.accountIds,c.projectIds])if(!Array.isArray(values)||values.length>10000||new Set(values).size!==values.length||!values.every(v=>typeof v==='string'&&OPAQUE_COMPARTMENT_PATTERN.test(v)))return fail();
  if((c.accountSelection!==undefined&&!['explicit','all-human'].includes(c.accountSelection))||(c.projectSelection!==undefined&&!['explicit','all-projects'].includes(c.projectSelection))
    ||(c.accountSelection==='all-human'&&c.accountIds.length!==0)||(c.projectSelection==='all-projects'&&c.projectIds.length!==0))return fail();
  if(!Array.isArray(c.projectGrants)||!Array.isArray(c.personalConsents)||c.personalConsents.length>100000||c.projectGrants.length>10000)return fail();
  if(![c.outputPath,c.generationPath].every(p=>typeof p==='string'&&path.isAbsolute(p))||c.outputPath===c.generationPath)return fail();
  const projects=new Set<string>();let grants=c.personalConsents.length;
  for(const p of c.projectGrants){
    if(!OPAQUE_COMPARTMENT_PATTERN.test(p.projectId)||(c.projectSelection!=='all-projects'&&!c.projectIds.includes(p.projectId))||projects.has(p.projectId)||!Array.isArray(p.grants))return fail();projects.add(p.projectId);grants+=p.grants.length;
    const seen=new Set<string>();
    for(const g of p.grants){if(!['user','group'].includes(g.subject_type)||!['read','write'].includes(g.operation)||!OPAQUE_COMPARTMENT_PATTERN.test(g.subject_id)||typeof g.consent_ref!=='string'||!g.consent_ref.length||g.consent_ref.length>256)return fail();
      if(g.subject_type==='user'&&c.accountSelection!=='all-human'&&!c.accountIds.includes(g.subject_id))return fail();
      const key=g.subject_type+':'+g.subject_id+':'+g.operation;if(seen.has(key))return fail();seen.add(key);}
  }
  const consentPairs=new Set<string>();
  for(const x of c.personalConsents){if(!OPAQUE_COMPARTMENT_PATTERN.test(x.owner_id)||!OPAQUE_COMPARTMENT_PATTERN.test(x.reader_id)||(c.accountSelection!=='all-human'&&(!c.accountIds.includes(x.owner_id)||!c.accountIds.includes(x.reader_id)))||x.owner_id===x.reader_id||typeof x.consent_ref!=='string'||!x.consent_ref.length||x.consent_ref.length>256)return fail();const k=x.owner_id+':'+x.reader_id;if(consentPairs.has(k))return fail();consentPairs.add(k);}
  if(grants>100000||c.accountIds.length+c.projectIds.length>10000)return fail();
  return c;
}
/** The canonical order of a grant list: subject type, subject id, operation. */
function canonicalGrants(grants: Grant[]): Grant[] {
  return grants.map(g=>({subject_type:g.subject_type,subject_id:g.subject_id,operation:g.operation,consent_ref:g.consent_ref}))
    .sort((a,b)=>(a.subject_type+':'+a.subject_id+':'+a.operation).localeCompare(b.subject_type+':'+b.subject_id+':'+b.operation));
}
/** The canonical order of a consent list: owner, then reader. */
function canonicalConsents(consents: Consent[]): Consent[] {
  return consents.map(x=>({owner_id:x.owner_id,reader_id:x.reader_id,consent_ref:x.consent_ref}))
    .sort((a,b)=>(a.owner_id+':'+a.reader_id).localeCompare(b.owner_id+':'+b.reader_id));
}
/** Table rows grouped per Project, in the configuration's {projectId, grants} shape. */
function groupCompartmentGrants(rows: CompartmentGrantRow[]): { projectId: string; grants: Grant[] }[] {
  const byProject=new Map<string, Grant[]>();
  for(const row of rows){const list=byProject.get(row.project_id)??[];list.push(row);byProject.set(row.project_id,list);}
  return [...byProject.entries()].map(([projectId,grants])=>({projectId,grants:canonicalGrants(grants)}));
}
/** Owner provisioning eligibility does not grant A21 visibility, selection, or content access.
 * Normal core admission and the source's current ACL remain mandatory on every read. */
export function createLifecyclePayload(c:LifecycleExportConfig, rows:LifecycleRows, generation:number, now:number) {
  const s=rows.source;
  if(!c.enabled||!s||s.id!==c.sourceId||s.revision!==c.expectedServiceRevision||s.retired_at||s.descriptor_retired_at||s.status!=='published'||s.knowledge_claims_mode!=='asserted'
    ||!['pairwise','direct'].includes(s.knowledge_subject_mode)||!isKnowledgeCapable({slug:s.slug,knowledgeQueryEndpoint:s.knowledge_query_endpoint},s.descriptor?.knowledgeSource)
    ||!Number.isSafeInteger(generation)||generation<=0||!Number.isSafeInteger(now)||now<=0)return fail();
  const accountIds=new Set(c.accountIds),projectIds=new Set(c.projectIds),relevant=new Set(s.knowledge_relevant_groups??[]);
  const accounts=rows.accounts.filter(a=>(c.accountSelection==='all-human'||accountIds.has(a.id))&&a.kind==='human').map(a=>({id:a.id,assertion_sub:s.knowledge_subject_mode==='direct'?a.id:pairwiseSubject(a.id,s.id),label:a.display_name??a.handle,active:a.status==='active'}));
  const ids=new Set(accounts.filter(a=>a.active).map(a=>a.id));
  const groups=rows.groups.filter(g=>relevant.has(g.id)).map(g=>({id:g.id,assertion_grp:g.id,active:true}));
  const groupIds=new Set(groups.map(g=>g.id));
  // Card 502fb19e (E308): the grants come from the core table once it is read,
  // and from the configuration otherwise. ONE filter below serves both (E299
  // F3: only exported, active, human Accounts and relevant Groups are emitted;
  // a row for any other subject is filtered, never shipped).
  if((rows.compartmentGrants?.length??0)>LIFECYCLE_COMPARTMENT_GRANT_CAP)return fail();
  const grantSource=rows.compartmentGrants?groupCompartmentGrants(rows.compartmentGrants):c.projectGrants;
  const consentSource=rows.personalConsents?canonicalConsents(rows.personalConsents):c.personalConsents;
  const projects=rows.projects.filter(p=>c.projectSelection==='all-projects'||projectIds.has(p.id)).map(p=>({id:p.id,label:p.name,active:p.status==='active',
    grants:p.status!=='active'?[]:(grantSource.find(x=>x.projectId===p.id)?.grants??[]).filter(g=>g.subject_type==='user'?ids.has(g.subject_id):groupIds.has(g.subject_id))}));
  if(accounts.length+groups.length+projects.length>10000||[...accounts,...projects].some(x=>typeof x.label!=='string'||x.label.length>256))return fail();
  // Card 549cc51f (E298, E299 F3): the shared-area writer list. ONLY ids that
  // are also exported, active, human Accounts in THIS payload are emitted, so a
  // listed Account outside the export selection (or disabled since) is simply
  // absent from the element: the source verifies every element it reads, and a
  // snapshot it refuses denies reads as well as writes. Sorted and unique, so
  // equal inputs sign equal bytes. The element is always present: an empty
  // list means nobody writes the shared area.
  const writerRows=rows.sharedWriters??[];
  if(writerRows.length>LIFECYCLE_SHARED_WRITER_CAP)return fail();
  const sharedWriters=[{scope:'organisation' as const,accounts:[...new Set(writerRows)].filter(id=>ids.has(id)).sort()}];
  for(const list of [accounts,projects,groups])if(new Set(list.map(x=>x.id)).size!==list.length)return fail();
  const payload={schema_version:1,iss:c.issuer,aud:s.id,iat:now,exp:now+60,generation,complete:true,source_config_version:c.sourceConfigVersion,accounts,projects,groups,
    personal_consents:consentSource.filter(x=>ids.has(x.owner_id)&&ids.has(x.reader_id)),shared_writers:sharedWriters,actor_ref:c.actorRef};
  if(Buffer.byteLength(JSON.stringify(payload))>8*1024*1024)return fail();
  return payload;
}
export type LifecyclePayload = ReturnType<typeof createLifecyclePayload>;
export function atomicLifecycleWrite(file:string, text:string):void {
  const temporary=file+'.tmp-'+crypto.randomBytes(8).toString('hex');
  let fd:number|undefined;
  try {fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,text);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);
    const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  } finally {if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
export function signLifecyclePayload(payload:object,key:crypto.KeyObject,kid:string):string {
  if(key.asymmetricKeyType!=='ed25519')return fail();
  const input=Buffer.from(JSON.stringify({alg:'EdDSA',typ:'rb-lifecycle-snapshot+jwt',kid})).toString('base64url')+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url');
  const jwt=input+'.'+crypto.sign(null,Buffer.from(input),key).toString('base64url');
  if(Buffer.byteLength(jwt)>12*1024*1024)return fail();return jwt;
}
export function nextLifecycleGeneration(state:{generation:number;lastIat:number},now:number):number {
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(state.generation)||state.generation<0||!Number.isSafeInteger(state.lastIat)||state.lastIat<0||now<state.lastIat-10||state.generation>=Number.MAX_SAFE_INTEGER)return fail();
  return state.generation+1;
}
type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };
/**
 * Card 549cc51f: the writer-list read, run inside the exporter's own REPEATABLE
 * READ snapshot transaction (and by the live suite, which cannot hold the
 * root-owned configuration this exporter requires). The unexpired Account ids
 * on one source's organisation list, sorted, at most the cap plus one so an
 * over-cap list is refused rather than truncated.
 */
export async function readLifecycleSharedWriters(
  queryable: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  sourceId: string,
): Promise<string[]> {
  const rows = await queryable.query(
    `SELECT account_id FROM knowledge_shared_writers
      WHERE source_id = $1 AND scope = 'organisation' AND (expires_at IS NULL OR expires_at > now())
      ORDER BY account_id LIMIT $2`, [sourceId, LIFECYCLE_SHARED_WRITER_CAP + 1]);
  return rows.rows.map((row) => String(row.account_id));
}

// ══════ Card 502fb19e: the core tables (E308; change-request design sections 7.2 and 7.3) ══════

/**
 * The unexpired rows of knowledge_compartment_grants for one source, in a
 * fixed order, at most the cap plus one so an over-cap table is refused rather
 * than truncated. Read inside the exporter's REPEATABLE READ snapshot.
 */
export async function readLifecycleCompartmentGrants(queryable: Queryable, sourceId: string): Promise<CompartmentGrantRow[]> {
  const rows = await queryable.query(
    `SELECT project_id, subject_type, subject_id, operation, consent_ref, approval_id
       FROM knowledge_compartment_grants
      WHERE source_id = $1 AND (expires_at IS NULL OR expires_at > now())
      ORDER BY project_id, subject_type, subject_id, operation LIMIT $2`, [sourceId, LIFECYCLE_COMPARTMENT_GRANT_CAP + 1]);
  return rows.rows.map((row) => ({
    project_id: String(row.project_id), subject_type: row.subject_type, subject_id: String(row.subject_id),
    operation: row.operation, consent_ref: String(row.consent_ref), approval_id: row.approval_id ? String(row.approval_id) : null,
  }));
}

/** The rows of knowledge_personal_consents for one source, in a fixed order. */
export async function readLifecyclePersonalConsents(queryable: Queryable, sourceId: string): Promise<Consent[]> {
  const rows = await queryable.query(
    `SELECT owner_id, reader_id, consent_ref FROM knowledge_personal_consents
      WHERE source_id = $1 ORDER BY owner_id, reader_id LIMIT 100001`, [sourceId]);
  return rows.rows.map((row) => ({ owner_id: String(row.owner_id), reader_id: String(row.reader_id), consent_ref: String(row.consent_ref) }));
}

/** The approval-made writer-list rows of one source: account and approval, unexpired. */
async function readLifecycleSharedWriterApprovals(queryable: Queryable, sourceId: string): Promise<Array<{ accountId: string; approvalId: string }>> {
  const rows = await queryable.query(
    `SELECT account_id, approval_id FROM knowledge_shared_writers
      WHERE source_id = $1 AND scope = 'organisation' AND approval_id IS NOT NULL
        AND (expires_at IS NULL OR expires_at > now())`, [sourceId]);
  return rows.rows.map((row) => ({ accountId: String(row.account_id), approvalId: String(row.approval_id) }));
}

/** The audit name of the carry-over (the family's first audit action, D4 F43). */
export const LIFECYCLE_IMPORT_AUDIT_ACTION = 'knowledge.lifecycle.import';
/** The audit resource the carry-over and its selection record are filed under. */
export const LIFECYCLE_IMPORT_RESOURCE_TYPE = 'knowledge_source';
/** The decide stamp is applied_at; the snapshot that first carries a row adds this
 * many generations of grace before the row is marked stalled (about 5 minutes at 15 s). */
export const LIFECYCLE_STALL_GENERATIONS = 20;

/** Whether this source's configuration rows were carried over into the core tables. */
export async function lifecycleImportRecorded(queryable: Queryable, sourceId: string): Promise<boolean> {
  const rows = await queryable.query(
    `SELECT 1 FROM audit_events WHERE action = $1 AND resource_type = $2 AND resource_id = $3 LIMIT 1`,
    [LIFECYCLE_IMPORT_AUDIT_ACTION, LIFECYCLE_IMPORT_RESOURCE_TYPE, sourceId]);
  return rows.rows.length > 0;
}

/**
 * THE CARRY-OVER (E308; section 7.3 (i)-(ii)). Every projectGrants entry of a
 * configuration `validateLifecycleConfig` admitted becomes one
 * knowledge_compartment_grants row with its consent_ref preserved, no approval
 * and added_by `system`; every personalConsents entry one
 * knowledge_personal_consents row. A Project the board does not hold (the
 * snapshot never emits it either) is skipped, so the read-back compares what
 * both sides emit. Replay-safe (ON CONFLICT DO NOTHING). Runs in the caller's
 * transaction and returns the row counts it found or wrote.
 */
export async function importLifecycleConfig(client: Queryable, c: LifecycleExportConfig): Promise<{ grants: number; consents: number }> {
  let grants = 0;
  for (const project of c.projectGrants) {
    const exists = await client.query('SELECT 1 FROM projects WHERE id::text = $1', [project.projectId]);
    if (exists.rows.length === 0) continue;
    for (const grant of project.grants) {
      await client.query(
        `INSERT INTO knowledge_compartment_grants
           (source_id, project_id, subject_type, subject_id, operation, consent_ref, approval_id, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, 'system')
         ON CONFLICT (source_id, project_id, subject_type, subject_id, operation) DO NOTHING`,
        [c.sourceId, project.projectId, grant.subject_type, grant.subject_id, grant.operation, grant.consent_ref]);
      grants += 1;
    }
  }
  let consents = 0;
  for (const consent of c.personalConsents) {
    await client.query(
      `INSERT INTO knowledge_personal_consents (source_id, owner_id, reader_id, consent_ref, added_by)
       VALUES ($1, $2, $3, $4, 'system')
       ON CONFLICT (source_id, owner_id, reader_id) DO NOTHING`,
      [c.sourceId, consent.owner_id, consent.reader_id, consent.consent_ref]);
    consents += 1;
  }
  return { grants, consents };
}

/**
 * THE READ-BACK (section 7.3 (iii)): the snapshot emitted from the core tables
 * must equal, byte for byte, the snapshot the configuration would have
 * emitted, element by element (projects[].grants and personal_consents), each
 * side in the canonical order. Anything else refuses LIFECYCLE_EXPORT_REFUSED:
 * the carry-over changed nothing, or nothing is exported. Returns the digest
 * and the row count the import audit records.
 */
export function lifecycleImportReadBack(fromConfig: LifecyclePayload, fromTables: LifecyclePayload): { digest: string; rowCount: number } {
  const canonical = (payload: LifecyclePayload) => JSON.stringify({
    projects: payload.projects.map((p) => ({ id: p.id, grants: canonicalGrants(p.grants as Grant[]) })),
    personal_consents: canonicalConsents(payload.personal_consents),
  });
  const expected = canonical(fromConfig);
  if (canonical(fromTables) !== expected) return fail();
  return {
    digest: crypto.createHash('sha256').update(expected).digest('hex'),
    rowCount: fromTables.projects.reduce((n, p) => n + p.grants.length, 0) + fromTables.personal_consents.length,
  };
}

/**
 * The live export selection, per source (section 4.2's KNOWLEDGE_NOT_EXPORTED
 * reads it). Recorded by THIS process each time a generation is written, from
 * the configuration it validated, so a change request is refused at filing and
 * at decide when its subject Account or a named Project lies outside what the
 * exporter would carry. A process that exports nothing has no record, and a
 * knowledge change is then refused: nothing it could approve would be exported.
 */
export interface LifecycleSelection {
  sourceId: string;
  accountSelection: 'explicit' | 'all-human';
  projectSelection: 'explicit' | 'all-projects';
  accountIds: ReadonlySet<string>;
  projectIds: ReadonlySet<string>;
  recordedAt: string;
}
const selections = new Map<string, LifecycleSelection>();
export function recordLifecycleSelection(c: LifecycleExportConfig, at: Date = new Date()): LifecycleSelection {
  const selection: LifecycleSelection = {
    sourceId: c.sourceId,
    accountSelection: c.accountSelection ?? 'explicit',
    projectSelection: c.projectSelection ?? 'explicit',
    accountIds: new Set(c.accountIds.map((id) => id.toLowerCase())),
    projectIds: new Set(c.projectIds.map((id) => id.toLowerCase())),
    recordedAt: at.toISOString(),
  };
  selections.set(c.sourceId.toLowerCase(), selection);
  return selection;
}
export function lifecycleSelectionFor(sourceId: string): LifecycleSelection | null {
  return selections.get(String(sourceId).toLowerCase()) ?? null;
}
/**
 * Card 08792425 (two-way registration, the default-store design's choice C7):
 * the PUBLIC half of the lifecycle signing key this process signs a source's
 * snapshot with, recorded per source each time a generation is signed. The
 * return bundle the Services page offers carries it, so the installer can pin
 * it. Only the public JWK is kept: the private key never leaves the exporter's
 * own read, and a process that exports nothing for a source has no record, so
 * the page says so instead of inventing a key.
 */
export interface LifecyclePublicKey { sourceId: string; kid: string; jwk: Record<string, string>; recordedAt: string }
const lifecyclePublicKeys = new Map<string, LifecyclePublicKey>();
export function recordLifecyclePublicKey(sourceId: string, kid: string, key: crypto.KeyObject, at: Date = new Date()): LifecyclePublicKey {
  const exported = crypto.createPublicKey(key).export({ format: 'jwk' }) as Record<string, unknown>;
  const jwk: Record<string, string> = { kty: String(exported.kty), crv: String(exported.crv), x: String(exported.x), kid, alg: 'EdDSA', use: 'sig' };
  const record: LifecyclePublicKey = { sourceId, kid, jwk, recordedAt: at.toISOString() };
  lifecyclePublicKeys.set(sourceId.toLowerCase(), record);
  return record;
}
export function lifecyclePublicKeyFor(sourceId: string): LifecyclePublicKey | null {
  return lifecyclePublicKeys.get(String(sourceId).toLowerCase()) ?? null;
}
/** The subject Accounts and Projects a selection leaves out (empty lists: all inside). */
export function lifecycleSelectionMisses(selection: LifecycleSelection, input: { accountIds: string[]; projectIds: string[] }): { accounts: string[]; projects: string[] } {
  return {
    accounts: selection.accountSelection === 'all-human' ? [] : input.accountIds.filter((id) => !selection.accountIds.has(id.toLowerCase())),
    projects: selection.projectSelection === 'all-projects' ? [] : input.projectIds.filter((id) => !selection.projectIds.has(id.toLowerCase())),
  };
}

/** What one generation will carry, and what its commit must record. */
export interface PreparedLifecycleGeneration {
  payload: LifecyclePayload;
  /** Set on the generation that carries the configuration over (section 7.3 (iii)). */
  importReadBack: { digest: string; rowCount: number } | null;
  /** The change-request approvals whose core rows this payload carries. */
  carriedApprovalIds: string[];
}

/**
 * Read one generation's rows and build its payload FROM THE CORE TABLES. On the
 * first generation for a source the configuration's rows are carried over
 * first, in their own committed transaction, and the payload is then checked
 * against the configuration-derived one (the read-back), which refuses unless
 * they are equal. `client` is the exporter's locked connection; nothing here
 * touches a file, so the live suite drives it with a fixture configuration.
 */
export async function prepareLifecycleGeneration(
  client: Queryable, c: LifecycleExportConfig, generation: number, now: number,
): Promise<PreparedLifecycleGeneration> {
  const imported = await lifecycleImportRecorded(client, c.sourceId);
  if (!imported) {
    await client.query('BEGIN');
    try {
      await importLifecycleConfig(client, c);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let rows: LifecycleRows;
  let writerApprovals: Array<{ accountId: string; approvalId: string }>;
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    const source=await client.query('SELECT s.*, v.descriptor, v.retired_at AS descriptor_retired_at FROM services s LEFT JOIN service_descriptor_versions v ON v.service_id=s.id AND v.version=s.current_descriptor_version WHERE s.id=$1',[c.sourceId]);
    if(source.rows.length!==1)return fail();
    const accounts=await client.query(c.accountSelection==='all-human'
      ? "SELECT id,display_name,handle,status,kind FROM principals WHERE kind='human' ORDER BY id LIMIT 10001"
      : 'SELECT id,display_name,handle,status,kind FROM principals WHERE id=ANY($1::uuid[]) ORDER BY id LIMIT 10001',c.accountSelection==='all-human'?[]:[c.accountIds]);
    const projects=await client.query(c.projectSelection==='all-projects'
      ? 'SELECT id,name,status FROM projects ORDER BY id LIMIT 10001'
      : 'SELECT id,name,status FROM projects WHERE id=ANY($1::uuid[]) ORDER BY id LIMIT 10001',c.projectSelection==='all-projects'?[]:[c.projectIds]);
    const groups=await client.query('SELECT id FROM groups WHERE id=ANY($1::uuid[]) ORDER BY id LIMIT 10001',[source.rows[0].knowledge_relevant_groups??[]]);
    const sharedWriters=await readLifecycleSharedWriters(client,c.sourceId);
    const compartmentGrants=await readLifecycleCompartmentGrants(client,c.sourceId);
    const personalConsents=await readLifecyclePersonalConsents(client,c.sourceId);
    writerApprovals=await readLifecycleSharedWriterApprovals(client,c.sourceId);
    rows={source:source.rows[0],accounts:accounts.rows.map(stringIds),projects:projects.rows.map(stringIds),groups:groups.rows.map(stringIds),
      sharedWriters,compartmentGrants,personalConsents};
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  const payload=createLifecyclePayload(c,rows,generation,now);
  const importReadBack=imported ? null
    : lifecycleImportReadBack(createLifecyclePayload(c,{...rows,compartmentGrants:undefined,personalConsents:undefined},generation,now),payload);
  // The approvals whose rows this payload CARRIES: a compartment row of an
  // emitted Project whose subject survived the F3 filter, a writer-list row of
  // an emitted writer.
  const carried=new Set<string>();
  const emitted=new Set(payload.projects.flatMap((p)=>p.grants.map((g)=>`${p.id}:${g.subject_type}:${g.subject_id}:${g.operation}`)));
  for(const row of rows.compartmentGrants??[]){
    if(row.approval_id&&emitted.has(`${row.project_id}:${row.subject_type}:${row.subject_id}:${row.operation}`))carried.add(row.approval_id);
  }
  const writers=new Set(payload.shared_writers[0].accounts);
  for(const row of writerApprovals)if(writers.has(row.accountId))carried.add(row.approvalId);
  return {payload,importReadBack,carriedApprovalIds:[...carried].sort()};
}

function stringIds<T extends { id: unknown }>(row: T): T { return { ...row, id: String(row.id) }; }

/**
 * After the snapshot of `generation` is durably written: record the carry-over
 * (once, as the audit row `knowledge.lifecycle.import {generation, rowCount,
 * digest}` with the selection the configuration carries, section 7.3 (iii) and
 * (v)); stamp every change-request approval carried for the FIRST time with
 * its generation and the ledger row `approval.applied {generation}` (it never
 * touches applied_at, which the decide stamped, section 2.3 (d)); mark a row
 * that no generation carried within LIFECYCLE_STALL_GENERATIONS of its decide
 * `export: stalled` with `approval.export_stalled`; and record the live
 * selection for the request door.
 */
export async function commitLifecycleGeneration(
  queryable: Queryable, c: LifecycleExportConfig, generation: number, prepared: PreparedLifecycleGeneration,
): Promise<{ applied: string[]; stalled: string[] }> {
  if (prepared.importReadBack) {
    await auditService.record({
      action: LIFECYCLE_IMPORT_AUDIT_ACTION, actor: { handle: 'system', authMethod: 'system' },
      resourceType: LIFECYCLE_IMPORT_RESOURCE_TYPE, resourceId: c.sourceId,
      metadata: {
        generation, rowCount: prepared.importReadBack.rowCount, digest: prepared.importReadBack.digest,
        sourceConfigVersion: c.sourceConfigVersion,
        selection: {
          accountSelection: c.accountSelection ?? 'explicit', projectSelection: c.projectSelection ?? 'explicit',
          accountCount: c.accountIds.length, projectCount: c.projectIds.length,
        },
      },
    }, queryable);
  }
  const applied = prepared.carriedApprovalIds.length === 0 ? [] : (await queryable.query(
    `UPDATE approvals SET applied_effect = COALESCE(applied_effect, '{}'::jsonb) || jsonb_build_object('generation', $2::bigint),
            updated_at = NOW()
      WHERE id = ANY($1::uuid[]) AND kind = 'change' AND status = 'approved' AND applied_at IS NOT NULL
        AND NOT (COALESCE(applied_effect, '{}'::jsonb) ? 'generation')
      RETURNING id`, [prepared.carriedApprovalIds, generation])).rows.map((row) => String(row.id));
  for (const approvalId of applied) {
    await queryable.query(
      `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata)
       VALUES ($1, 'approval.applied', NULL, 'system', $2::jsonb)`,
      [approvalId, JSON.stringify({ kind: 'change', generation, sourceId: c.sourceId })]);
  }
  const stalled = (await queryable.query(
    `UPDATE approvals SET applied_effect = COALESCE(applied_effect, '{}'::jsonb) || '{"export":"stalled"}'::jsonb,
            updated_at = NOW()
      WHERE kind = 'change' AND status = 'approved' AND applied_at IS NOT NULL
        AND target_type IN ('knowledge.compartment', 'knowledge.shared_writer')
        AND applied_effect->>'sourceId' = $1
        AND applied_at < NOW() - make_interval(secs => $2::int * 15)
        AND NOT (COALESCE(applied_effect, '{}'::jsonb) ? 'generation')
        AND NOT (COALESCE(applied_effect, '{}'::jsonb) ? 'export')
      RETURNING id`, [c.sourceId, LIFECYCLE_STALL_GENERATIONS])).rows.map((row) => String(row.id));
  for (const approvalId of stalled) {
    await queryable.query(
      `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata)
       VALUES ($1, 'approval.export_stalled', NULL, 'system', $2::jsonb)`,
      [approvalId, JSON.stringify({
        kind: 'change', sourceId: c.sourceId, generation,
        reason: "not exported: the subject or a Project left the exporter's selection",
      })]);
  }
  recordLifecycleSelection(c);
  return { applied, stalled };
}

export async function exportKnowledgeLifecycle(configPath:string):Promise<{generation:number;accounts:number;projects:number;groups:number}> {
  // Configuration authority must be root-owned, outside agent-writable workspaces.
  if(fs.lstatSync(configPath).uid!==0)return fail();
  const configText=privateText(configPath,true),c=validateLifecycleConfig(parseLifecycleJson(configText));
  if(!c.enabled)return fail();
  if(fs.lstatSync(c.keyRef.slice(5)).uid!==0)return fail();
  // Validate state ancestry before creating the lock; output shares the protected state directory.
  privateText(c.generationPath);
  if(path.dirname(c.outputPath)!==path.dirname(c.generationPath))return fail();
  const client=await pool.connect();
  let locked=false;
  let releaseWithError=false;
  try {
    // Database session ownership is released even after SIGKILL/socket loss.
    // Keep it until generation and snapshot fsync complete, not just the read transaction.
    const acquired=await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',['knowledge-lifecycle:'+c.sourceId]);
    if(acquired.rows[0]?.acquired!==true)return fail();
    locked=true;
    const state=parseLifecycleJson(privateText(c.generationPath)) as {generation:number;lastIat:number};
    const now=Math.floor(Date.now()/1000);
    const generation=nextLifecycleGeneration(state,now);
    // Card 502fb19e (E308): the rows come from the core tables; the first
    // generation carries the configuration's rows over and reads them back.
    const prepared=await prepareLifecycleGeneration(client,c,generation,now);
    if(privateText(configPath,true)!==configText)return fail();
    const payload=prepared.payload;
    const key=crypto.createPrivateKey(privateText(c.keyRef.slice(5),true));
    if(key.asymmetricKeyType==='ed25519')recordLifecyclePublicKey(c.sourceId,c.kid,key);
    // Reserve generation durably BEFORE signing; a crash may skip, never reuse.
    atomicLifecycleWrite(c.generationPath,JSON.stringify({generation,lastIat:now}));
    const token=signLifecyclePayload(payload,key,c.kid);
    atomicLifecycleWrite(c.outputPath,token);
    await commitLifecycleGeneration(client,c,generation,prepared);
    return {generation,accounts:payload.accounts.length,projects:payload.projects.length,groups:payload.groups.length};
  } finally {
    try {
      if(locked) {
        const released=await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released',['knowledge-lifecycle:'+c.sourceId]);
        if(released.rows[0]?.released!==true)releaseWithError=true;
      }
    } catch {releaseWithError=true;}
    client.release(releaseWithError);
  }
}

export function startKnowledgeLifecycleExporter(): (()=>void) | undefined {
  const configPath=process.env.RELAYHALL_KNOWLEDGE_LIFECYCLE_CONFIG;
  if(!configPath)return undefined;
  let busy=false;
  const run=()=>{if(busy)return;busy=true;void exportKnowledgeLifecycle(configPath).catch(e=>logCaughtFailure('renew knowledge lifecycle snapshot',e)).finally(()=>{busy=false;});};
  run();const timer=setInterval(run,15000);timer.unref();return()=>clearInterval(timer);
}
