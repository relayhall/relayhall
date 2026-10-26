import { reviewCriteria, reviewDigest, validateNativeVerdict } from '../utils/nativeReview';
import { validateDescriptor } from '../utils/serviceDescriptor';
import { telemetrySessionReference, telemetryPseudonym, TELEMETRY_PSEUDONYM_DOMAINS, resetTelemetryPepperCache } from '../utils/telemetryPepper';

const criteria=reviewCriteria({definition_of_done:['HTTP unavailable is 503','Recover the same session']});
const verdict=()=>({summary:'Observed both requirements',criteria:criteria.map(c=>({id:c.id,decision:'pass',evidence:['report-1'],rationale:'Exact receipt'}))});
test('criteria are derived from stored DoD and description fallback, never model-supplied names',()=>{
  expect(criteria.map(c=>c.id)).toEqual(['criterion-1','criterion-2']);
  expect(reviewCriteria({description:'Stored full requirement'})).toEqual([{id:'criterion-1',text:'Stored full requirement'}]);
  expect(reviewCriteria({definition_of_done:[],description:'Stored full requirement'})).toEqual([{id:'criterion-1',text:'Stored full requirement'}]);
  expect(()=>reviewCriteria({})).toThrow();
});
test('canonical evidence digest ignores object key order but preserves values and sequence',()=>{
  expect(reviewDigest({a:1,b:[2,3]})).toBe(reviewDigest({b:[2,3],a:1}));
  expect(reviewDigest({a:1,b:[2,3]})).not.toBe(reviewDigest({a:1,b:[3,2]}));
});
test('a complete exact verdict passes and an explicit rejection stays rejected',()=>{
  expect(validateNativeVerdict(verdict(),criteria,['report-1']).decision).toBe('pass');
  const value=verdict();value.criteria[0].decision='reject';
  expect(validateNativeVerdict(value,criteria,['report-1']).decision).toBe('reject');
});
test.each(['missing','duplicate','foreign-criterion','foreign-evidence','empty-evidence','command','empty-rationale'])(
  'untrusted model %s cannot become an accepted verdict',kind=>{
    const value:any=verdict();
    if(kind==='missing') value.criteria.pop();
    if(kind==='duplicate') value.criteria[1].id=value.criteria[0].id;
    if(kind==='foreign-criterion') value.criteria[0].id='invented';
    if(kind==='foreign-evidence') value.criteria[0].evidence=['/etc/secret'];
    if(kind==='empty-evidence') value.criteria[0].evidence=[];
    if(kind==='command') value.command='run this';
    if(kind==='empty-rationale') value.criteria[0].rationale='';
    expect(()=>validateNativeVerdict(value,criteria,['report-1'])).toThrow();
  });
test('capability is explicit, versioned and requires the declared telemetry product',()=>{
  const base={options:[],telemetry:{tier:'presence',products:['claude-code']}};
  expect(validateDescriptor(base).nativeReview).toBeUndefined();
  expect(validateDescriptor({...base,nativeReview:{protocolVersion:1,sourceProduct:'claude-code'}}).nativeReview?.protocolVersion).toBe(1);
  expect(()=>validateDescriptor({...base,nativeReview:{protocolVersion:1,sourceProduct:'other'}})).toThrow();
  expect(()=>validateDescriptor({...base,nativeReview:{protocolVersion:2,sourceProduct:'claude-code'}})).toThrow();
});
test('session attestation and event ingest share exact conversation precedence and pepper generation',()=>{
  const oldKeys=process.env.RELAYHALL_TELEMETRY_PEPPERS,oldActive=process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER;
  try {
    process.env.RELAYHALL_TELEMETRY_PEPPERS=JSON.stringify({test:Buffer.alloc(32,1).toString('base64'),next:Buffer.alloc(32,2).toString('base64')});
    process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER='test'; resetTelemetryPepperCache();
    const ref=telemetrySessionReference('claude-code',{session_id:'init-real',conversation_id:'conversation-real'});
    expect(ref).toBe(telemetryPseudonym(TELEMETRY_PSEUDONYM_DOMAINS.sessionRef,'claude-code|conversation-real'));
    expect(ref).not.toContain('conversation-real');
    expect(telemetrySessionReference('claude-code',{session_id:'init-real'})).not.toBe(ref);
    expect(telemetrySessionReference('claude-code',{conversation_id:'conversation-real'},'next')).not.toBe(ref);
    expect(telemetrySessionReference('claude-code',null)).toBeNull();
  } finally {
    if(oldKeys===undefined) delete process.env.RELAYHALL_TELEMETRY_PEPPERS;else process.env.RELAYHALL_TELEMETRY_PEPPERS=oldKeys;
    if(oldActive===undefined) delete process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER;else process.env.RELAYHALL_TELEMETRY_ACTIVE_PEPPER=oldActive;
    resetTelemetryPepperCache();
  }
});
