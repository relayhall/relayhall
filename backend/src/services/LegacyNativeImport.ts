import { InvalidRequestFault } from '../utils/httpErrors';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const CURSOR=/^(0|[1-9][0-9]{0,18})$/;
function exact(value:any,keys:string[]) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join()!==[...keys].sort().join()) throw new InvalidRequestFault('Exact legacy quarantine shape required');
}
function id(value:any) {if(typeof value!=='string'||!UUID.test(value)) throw new InvalidRequestFault('Canonical legacy identity required');}
function hash(value:any) {if(typeof value!=='string'||!HASH.test(value)) throw new InvalidRequestFault('Exact legacy digest required');}
function stamp(value:any):number {if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||!/(Z|[+-]\d\d:\d\d)$/.test(value)) throw new InvalidRequestFault('Original timezone-bearing timestamp required');return Date.parse(value);}
function rows(value:any):any[] {if(!Array.isArray(value)||value.length>10000) throw new InvalidRequestFault('Bounded original rows required');return value;}
function cursor(value:any):bigint {if(typeof value!=='string'||!CURSOR.test(value)||BigInt(value)>9223372036854775807n) throw new InvalidRequestFault('Exact original cursor required');return BigInt(value);}

/** Evidence-only validation. Never asserts filesystem presence, backend ingestion,
 * execution mapping, cutover, or runnable authority. Original values are retained. */
export function validateLegacyNativeImport(value:any):void {
  exact(value,['schemaVersion','deploymentId','storeId','snapshotSha256','taskId','legacyReservation','bindRows','consumeRows','jobs','outbox','artifacts']);
  if(value.schemaVersion!==1) throw new InvalidRequestFault('Unsupported quarantine schema');
  for(const key of ['deploymentId','storeId','taskId']) id(value[key]);hash(value.snapshotSha256);
  const root=value.legacyReservation;
  exact(root,['taskId','reservationId','cursor','descriptionSha256','reservedAt','expiresAt']);
  id(root.taskId);id(root.reservationId);hash(root.descriptionSha256);
  if(root.taskId!==value.taskId || stamp(root.reservedAt)>=stamp(root.expiresAt)) throw new InvalidRequestFault('Contradictory original reservation');
  let previous=root.reservationId,previousCursor=cursor(root.cursor),previousTime=stamp(root.reservedAt);
  const binds=rows(value.bindRows),consumes=rows(value.consumeRows),ids=new Set([root.reservationId]),rejections=new Set();
  if(binds.length>32) throw new InvalidRequestFault('Legacy lineage limit');
  const byBind=new Map<string,any>();
  for(const consume of consumes) {
    exact(consume,['reservationId','bindId','consumedAt']);id(consume.reservationId);id(consume.bindId);stamp(consume.consumedAt);
    if(byBind.has(consume.bindId)||ids.has(consume.reservationId)) throw new InvalidRequestFault('Duplicate legacy consume');
    ids.add(consume.reservationId);byBind.set(consume.bindId,consume);
  }
  for(let index=0;index<binds.length;index++) {
    const bind=binds[index];
    exact(bind,['bindId','taskId','generationId','cursor','historyEntryId','predecessorReservationId','generationSha256','dispatchSha256','boundAt']);
    for(const key of ['bindId','taskId','generationId','historyEntryId','predecessorReservationId']) id(bind[key]);
    hash(bind.generationSha256);hash(bind.dispatchSha256);
    if(bind.taskId!==value.taskId||bind.predecessorReservationId!==previous||ids.has(bind.bindId)||ids.has(bind.generationId)||rejections.has(bind.historyEntryId)||cursor(bind.cursor)<=previousCursor||stamp(bind.boundAt)<previousTime) throw new InvalidRequestFault('Conflicting original lineage');
    ids.add(bind.bindId);ids.add(bind.generationId);rejections.add(bind.historyEntryId);
    const consume=byBind.get(bind.bindId);byBind.delete(bind.bindId);
    if(!consume && index!==binds.length-1) throw new InvalidRequestFault('Nonterminal unconsumed bind');
    if(consume && stamp(consume.consumedAt)<stamp(bind.boundAt)) throw new InvalidRequestFault('Contradictory consume time');
    previous=consume?.reservationId;previousTime=consume?stamp(consume.consumedAt):stamp(bind.boundAt);previousCursor=cursor(bind.cursor);
  }
  if(byBind.size) throw new InvalidRequestFault('Orphan legacy consume');
  const jobIds=new Set();
  for(const job of rows(value.jobs)) {
    exact(job,['cursor','task','status','pid','reason','updated']);cursor(job.cursor);id(job.task);
    if(jobIds.has(job.cursor)||typeof job.status!=='string'||!job.status||!Number.isSafeInteger(job.pid)||job.pid<0||(job.reason!==null&&typeof job.reason!=='string')||typeof job.updated!=='number'||!Number.isFinite(job.updated)) throw new InvalidRequestFault('Invalid original job');
    jobIds.add(job.cursor);
  }
  const eventIds=new Set();
  for(const event of rows(value.outbox)) {
    exact(event,['id','body','status','tries','next']);id(event.id);
    if(eventIds.has(event.id)||typeof event.body!=='string'||Buffer.byteLength(event.body)>1048576||!['pending','accepted','rejected'].includes(event.status)||!Number.isSafeInteger(event.tries)||event.tries<0||typeof event.next!=='number'||!Number.isFinite(event.next)) throw new InvalidRequestFault('Invalid original outbox');
    try {JSON.parse(event.body);} catch {throw new InvalidRequestFault('Original outbox is not JSON');}eventIds.add(event.id);
  }
  const paths=new Set();
  for(const artifact of rows(value.artifacts)) {
    exact(artifact,['path','sha256','byteLength','encrypted']);hash(artifact.sha256);
    if(typeof artifact.path!=='string'||!artifact.path||artifact.path.startsWith('/')||artifact.path.includes('\\')||artifact.path.split('/').some((x:string)=>!x||x==='.'||x==='..')||paths.has(artifact.path)||!Number.isSafeInteger(artifact.byteLength)||artifact.byteLength<0||typeof artifact.encrypted!=='boolean') throw new InvalidRequestFault('Invalid retained artifact');
    paths.add(artifact.path);
  }
}
