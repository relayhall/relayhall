import jwt from 'jsonwebtoken';
import { validateUsageQuota } from '../types/UsageQuota';
import { validatePluginContract,pluginAccountCan,matchingPluginRule,pluginCanWriteThroughProxy,pluginSettingReadOnly,
  PluginContractError,PLUGIN_CONTRACT_REFUSALS,pluginLoadRefusalReason } from '../services/PluginHostContract';
import { signPluginAssertion } from '../services/PluginAssertion';
import { validateServiceMetrics } from '../services/PluginMetricsService';
import { pluginAccountId } from '../services/PluginAccountScope';
const at='2026-09-10T19:00:00Z',now=Date.parse(at);
const quota=()=>({schemaVersion:'rh.usage-quota/1',sourceProduct:'openai-codex',provider:'openai',providerAccountId:'one',label:'Personal',observedAt:at,status:'reported',windows:[{id:'weekly',label:'Weekly',unit:'percent',used:20,limit:100}]});
describe('quota observation contract',()=>{
  it('normalizes an observation and separates a failed attempt from observed time',()=>{
    const s=validateUsageQuota({...quota(),checkedAt:'2026-09-10T19:01:00Z',errorCode:'timeout'},now+60000);
    expect(s.observedAt).toBe('2026-09-10T19:00:00.000Z');expect(s.checkedAt).toBe('2026-09-10T19:01:00.000Z');
  });
  it.each([
    {owner:'forged'},{schemaVersion:'rh.usage-quota/2'},{provider:undefined},{providerAccountId:'email@example.com'},
    {observedAt:'bad'},{observedAt:'2026-02-30T12:00:00Z'},{observedAt:'2026-09-10T12:00:00'},{observedAt:'2099-01-01T00:00:00Z'},{checkedAt:'2026-01-01T00:00:00Z'},
    {errorCode:'raw provider secret'},{windows:[]},{status:'unsupported'},
    {label:'bad\nlabel'}
  ])('rejects malformed or owner-controlled fields %j',patch=>expect(()=>validateUsageQuota({...quota(),...patch},now)).toThrow());
  it.each([{used:-1},{used:101},{used:NaN},{limit:0},{unit:'dollars'},{resetsAt:'bad'},{extra:true}])('rejects invalid quota window %j',patch=>{
    const q=quota();q.windows=[{...q.windows[0],...patch} as any];expect(()=>validateUsageQuota(q,now)).toThrow();
  });
  it('rejects duplicate windows and admits explicit unknown without a fake bar',()=>{
    const q=quota();expect(()=>validateUsageQuota({...q,windows:[...q.windows,...q.windows]},now)).toThrow();
    expect(validateUsageQuota({...q,status:'not-reported',windows:[]},now).windows).toEqual([]);
  });
});
const manifest=():any=>({schema_version:'rh.plugin/1',name:'sample-plugin',version:'1.0.0',description:'sample',
 docker:{image:'sample:1',ports:{}},api:{internal_port:8080,health:'/health',base_path:'/plugins/sample-plugin',
 allow:[{path:'/',methods:['GET'],capability:'view'}]},relayhall:{api_version:1,trust:'installed',capabilities:['usage.quotas']}});
describe('installed plugin contract',()=>{
  it('requires explicit account grants and cannot widen root',()=>{
    const config:any={access:{accounts:{a:['view']}}};
    expect(pluginAccountCan(config,'a')).toBe(true);expect(pluginAccountCan(config,'b')).toBe(false);
    expect(pluginAccountCan(config,null)).toBe(false);expect(pluginAccountCan(config,'a','generate')).toBe(false);
  });
  it.each([{schema_version:'future'}, {relayhall:{api_version:2,trust:'installed'}},{name:'../escape'},
    {ui:{sidebar_widget:{path:'//evil',height:999}}}])('refuses unsupported manifest %j',patch=>{
      expect(()=>validatePluginContract({...manifest(),...patch},{name:'sample-plugin'} as any)).toThrow();
  });
  it('rejects write-through-view, unknown match and ambiguous repeated methods',()=>{
    for(const rules of [[{path:'/',methods:['POST']}],[{path:'/',methods:['GET'],match:'glob'}],
      [{path:'/',methods:['GET']},{path:'/',methods:['GET'],capability:'manage'}]]){
      const m=manifest();m.api.allow=rules;expect(()=>validatePluginContract(m,{name:m.name} as any)).toThrow();
    }
  });
  it.each(['exact','prefix'])('rejects a non-root trailing-slash protected rule (%s)',match=>{
    const m=manifest();m.api.allow=[{path:'/',methods:['GET'],capability:'view'},
      {path:'/private/',methods:['GET'],match,capability:'manage'}];
    // The broad view rule wins at /private/child if this spelling is admitted.
    expect(matchingPluginRule(m.api.allow,'GET','/private/child')?.capability).toBe('view');
    expect(()=>validatePluginContract(m,{name:m.name} as any)).toThrow('canonical');
  });
  it('retains canonical root and protected-prefix authorization',()=>{
    const m=manifest();m.api.allow=[{path:'/',methods:['GET'],capability:'view'},
      {path:'/private',methods:['GET'],match:'prefix',capability:'manage'}];
    expect(()=>validatePluginContract(m,{name:m.name} as any)).not.toThrow();
    expect(matchingPluginRule(m.api.allow,'GET','/private/child')?.capability).toBe('manage');
    expect(matchingPluginRule(m.api.allow,'GET','/private-sibling')?.capability).toBe('view');
  });
  it('selects the most specific capability rule',()=>{
    expect(matchingPluginRule([{methods:['GET'],path:'/',match:'prefix',capability:'view'},
      {methods:['GET'],path:'/private',match:'prefix',capability:'manage'}],'GET','/private/job')?.capability).toBe('manage');
  });
  it('binds assertion audience, account, capability and authorized task',()=>{
    process.env.PLUGIN_TEST_KEY='p02-test-key-only-32-bytes-long-secret';
    const token=signPluginAssertion({access:{assertion_key_env:'PLUGIN_TEST_KEY'}} as any,'sample-plugin','owner','actor','generate','task');
    const decoded=jwt.verify(token,process.env.PLUGIN_TEST_KEY,{algorithms:['HS256'],issuer:'relayhall',audience:'sample-plugin'}) as jwt.JwtPayload;
    expect(decoded.sub).toBe('owner');expect(decoded.taskId).toBe('task');expect(decoded.exp!-decoded.iat!).toBe(60);
    expect(()=>jwt.verify(token,process.env.PLUGIN_TEST_KEY!,{audience:'other'})).toThrow();
    delete process.env.PLUGIN_TEST_KEY;
  });
  it('takes Account identity only from authenticated chain head',()=>{
    expect(pluginAccountId({principal:{id:'actor'},delegationLinks:[{principalId:'actor'},{principalId:'owner'}]} as any)).toBe('owner');
    expect(pluginAccountId({body:{accountId:'forged'}} as any)).toBeNull();
  });
});
// Owner ruling E438(1): `ui.sidebar_widget.grow` is an OPT-IN boolean. Absent
// means false; any other value refuses the installation under the sidebar
// widget's own reason code, and the declared height rule (48..240) is the same
// for a widget that grows as for one that does not.
describe('sidebar widget grow opt-in (E438)',()=>{
  const withWidget=(widget:any)=>{const m=manifest();m.ui={enabled:true,sidebar_widget:widget};return m;};
  const refusal=(m:any)=>{try{validatePluginContract(m,{name:m.name} as any);return 'accepted';}
    catch(error){return pluginLoadRefusalReason(error);}};
  it.each([['absent',undefined],['true',true],['false',false]])('accepts a widget whose grow is %s',(_label,grow)=>{
    const widget:any={path:'/widget',height:240};if(grow!==undefined)widget.grow=grow;
    expect(refusal(withWidget(widget))).toBe('accepted');
  });
  it.each([['the string true','true'],['one',1],['zero',0],['null',null],['an object',{}],['a list',[true]]])(
    'refuses a grow that is not a boolean (%s) by the sidebar widget reason code',(_label,grow)=>{
      expect(refusal(withWidget({path:'/widget',height:240,grow}))).toBe('PLUGIN_SIDEBAR_WIDGET_INVALID');
    });
  it.each([241,47,999])('keeps the declared height bound for a widget that grows (height %s)',height=>{
    expect(refusal(withWidget({path:'/widget',height,grow:true}))).toBe('PLUGIN_SIDEBAR_WIDGET_INVALID');
  });
});
// Owner ruling E458: `ui.sidebar_widget.frame` is an OPT-IN with exactly one
// accepted value, `section`. Absent means the boxed block; anything else
// refuses the installation under the sidebar widget's own reason code, and the
// declared height rule is the same for a framed widget as for any other.
describe('sidebar widget frame opt-in (E458)',()=>{
  const withWidget=(widget:any)=>{const m=manifest();m.ui={enabled:true,sidebar_widget:widget};return m;};
  const refusal=(m:any)=>{try{validatePluginContract(m,{name:m.name} as any);return 'accepted';}
    catch(error){return pluginLoadRefusalReason(error);}};
  it.each([['absent',undefined],['section','section']])('accepts a widget whose frame is %s',(_label,frame)=>{
    const widget:any={path:'/widget',height:240};if(frame!==undefined)widget.frame=frame;
    expect(refusal(withWidget(widget))).toBe('accepted');
  });
  it.each([['a different case','Section'],['padded','section '],['another word','box'],['the empty string',''],['true',true],['false',false],
    ['one',1],['zero',0],['null',null],['an object',{}],['a list',['section']]])(
    'refuses a frame that is not exactly the string section (%s) by the sidebar widget reason code',(_label,frame)=>{
      expect(refusal(withWidget({path:'/widget',height:240,frame}))).toBe('PLUGIN_SIDEBAR_WIDGET_INVALID');
    });
  it.each([241,47,999])('keeps the declared height bound for a framed widget (height %s)',height=>{
    expect(refusal(withWidget({path:'/widget',height,frame:'section'}))).toBe('PLUGIN_SIDEBAR_WIDGET_INVALID');
  });
  it('accepts frame together with a grow opt-in',()=>{
    expect(refusal(withWidget({path:'/widget',height:240,grow:true,frame:'section'}))).toBe('accepted');
  });
});
describe('measured service metrics',()=>{
 const metric=()=>({schemaVersion:'rh.plugin.metrics/1',sourceProduct:'gpu-gateway',observedAt:at,queue:{value:2,unit:'jobs'},throughput:{value:1.5,unit:'jobs/minute',windowSeconds:60}});
 it('accepts measured queue and throughput without inventing unknowns',()=>{
   expect(validateServiceMetrics(metric(),now).throughput?.value).toBe(1.5);
   expect(validateServiceMetrics({...metric(),queue:null,throughput:null},now).queue).toBeNull();
 });
 it.each([{queue:{value:-1,unit:'jobs'}},{queue:{value:1.5,unit:'jobs'}},{throughput:{value:Infinity,unit:'jobs/minute',windowSeconds:60}},
 {throughput:{value:1,unit:'jobs/minute',windowSeconds:0}},{accountId:'forged'},{observedAt:'2099-01-01T00:00:00Z'}])('refuses invalid metric %j',patch=>expect(()=>validateServiceMetrics({...metric(),...patch},now)).toThrow());
});

describe('plugin settings registration', () => {
 const settings = () => ({id:'account-options',label:'Account options',scope:'personal',path:'/settings',capability:'view'});
 const check = (entry:any, rules?:any[]) => { const m=manifest();m.ui={enabled:true,settings:[entry]};if(rules)m.api.allow=rules;return validatePluginContract(m,{name:m.name} as any); };
 it('accepts personal settings behind the existing view rule',()=>expect(()=>check(settings())).not.toThrow());
 it.each([{id:undefined},{id:42},{id:{}},{capability:undefined},{capability:42},{capability:{}},{path:'//evil'},{path:'/settings?token=x'},{scope:'global'},{scope:'deployment'},{capability:'ungranted'},{label:'bad\nlabel'}])('rejects unsafe or unprotected settings %j',patch=>expect(()=>check({...settings(),...patch})).toThrow());
 it('binds shared settings to the most specific existing domain capability',()=>{
   const entry={...settings(),scope:'deployment',capability:'manage'};
   const rules=[{path:'/',methods:['GET'],capability:'view'},{path:'/settings',match:'exact',methods:['GET'],capability:'manage'}];
   expect(()=>check(entry,rules)).not.toThrow();
   expect(()=>check({...entry,capability:'view'},rules)).toThrow();
 });
 it.each(['/settings','/settings/nested'])('refuses settings paths rewritten by a UI alias: %s',path=>{
   const m=manifest();m.ui={enabled:true,routes:[{path:'/settings',proxy_to:'/public-settings'}],settings:[{...settings(),scope:'deployment',path,capability:'manage'}]};
   m.api.allow=[{path:'/settings',methods:['GET'],capability:'manage'},{path:'/public-settings',methods:['GET'],capability:'view'}];
   expect(()=>validatePluginContract(m,{name:m.name} as any)).toThrow('UI route alias');
 });
 it('rejects duplicate IDs and unbounded metadata',()=>{
  const m=manifest();m.ui={enabled:true,settings:[settings(),settings()]};expect(()=>validatePluginContract(m,{name:m.name} as any)).toThrow();
  m.ui.settings=Array.from({length:21},(_,i)=>({...settings(),id:'entry-'+i}));expect(()=>validatePluginContract(m,{name:m.name} as any)).toThrow();
 });
});

describe('caller-specific host proxy write description', () => {
 const account:any={access:{accounts:{owner:['view','manage'],reader:['view']}}};
 const write=['services:read','services:write'];
 const can=(rules:any[],scopes:string[]=write,id='owner')=>pluginCanWriteThroughProxy(account,id,scopes,rules);
 it.each(['POST','PUT','PATCH','DELETE'])('recognizes an effective %s rule',method=>{
   expect(can([{path:'/settings',match:'exact',methods:[method],capability:'manage'}])).toBe(true);
 });
 it('does not infer writes from GET and HEAD or from capability labels',()=>{
   expect(can([{path:'/',match:'prefix',methods:['GET','HEAD'],capability:'manage'}])).toBe(false);
   expect(can([{path:'/',match:'prefix',methods:['POST'],capability:'view'}])).toBe(false);
 });
 it('finds a reachable child when a long prefix is shadowed at its own path',()=>{
   const path='/'+'a'.repeat(499);
   const rules:any[]=[{path,match:'prefix',methods:['POST'],capability:'manage'},
     {path,match:'exact',methods:['POST'],capability:'other'}];
   expect(path.length).toBe(500);
   expect(matchingPluginRule(rules,'POST',path)?.capability).toBe('other');
   expect(matchingPluginRule(rules,'POST',path+'/0')?.capability).toBe('manage');
   expect(can(rules)).toBe(true);
 });
 it('requires the write scope and an explicit Account grant even for root',()=>{
   const rules:any[]=[{path:'/',match:'prefix',methods:['POST'],capability:'manage'}];
   expect(can(rules,['services:read'])).toBe(false);
   expect(can(rules,['root'],'reader')).toBe(false);
   expect(can(rules,['root'])).toBe(true);
 });
 it('honors exact and longest-prefix selection while finding a prefix descendant',()=>{
   const rules:any[]=[
     {path:'/',match:'prefix',methods:['POST'],capability:'manage'},
     {path:'/',match:'exact',methods:['POST'],capability:'other'},
     {path:'/0',match:'prefix',methods:['POST'],capability:'other'},
     {path:'/nested',match:'prefix',methods:['POST'],capability:'other'},
   ];
   expect(can(rules)).toBe(true);
   expect(matchingPluginRule(rules,'POST','/1')).toBe(rules[0]);
   expect(can([{path:'/nested',match:'prefix',methods:['POST'],capability:'manage'},
     {path:'/nested',match:'exact',methods:['POST'],capability:'other'},
     {path:'/nested/0',match:'prefix',methods:['POST'],capability:'other'}])).toBe(true);
 });

});

// Card 8fe6d7bb. A deployment default (access.default) gives every Account
// `view` of an installation; every other capability stays an explicit
// per-Account entry, and the default never describes or admits a write.
describe('deployment view default (card 8fe6d7bb)', () => {
 const withDefault=(accounts:Record<string,string[]>={}):any=>({name:'sample-plugin',access:{default:['view'],accounts}});
 const load=(access:any,m:any=manifest())=>validatePluginContract(m,{name:m.name,access} as any);
 it('the default grants view to every Account and never a non-view capability',()=>{
   const config=withDefault();
   expect(pluginAccountCan(config,'newcomer')).toBe(true);
   expect(pluginAccountCan(config,'newcomer','view')).toBe(true);
   for(const capability of ['generate','manage','read','admin']) expect(pluginAccountCan(config,'newcomer',capability)).toBe(false);
 });
 it('the per-Account list still grants non-view capabilities explicitly, and without a default it is exact',()=>{
   const config=withDefault({writer:['generate']});
   expect(pluginAccountCan(config,'writer','generate')).toBe(true);
   expect(pluginAccountCan(config,'writer','view')).toBe(true);
   expect(pluginAccountCan(config,'writer','manage')).toBe(false);
   for(const access of [{accounts:{writer:['generate']}},{default:[],accounts:{writer:['generate']}}]){
     expect(pluginAccountCan({access} as any,'newcomer','view')).toBe(false);
     expect(pluginAccountCan({access} as any,'writer','view')).toBe(false);
   }
 });
 it.each([[['generate']],[['view','generate']],[['view','view']],['view'],[null],[{}],[[{}]],[['*']],[['VIEW']],[42]])(
   'refuses a malformed default at load: %j',value=>{
     expect(()=>load({default:value})).toThrow('Invalid plugin access default');
     const legacy=manifest();delete legacy.schema_version;delete legacy.relayhall;
     expect(()=>load({default:value},legacy)).toThrow('Invalid plugin access default');
   });
 it('accepts a view default and an empty default, for installed and legacy manifests',()=>{
   const legacy=manifest();delete legacy.schema_version;delete legacy.relayhall;
   for(const value of [['view'],[]]){
     expect(()=>load({default:value,accounts:{writer:['generate']}})).not.toThrow();
     expect(()=>load({default:value},legacy)).not.toThrow();
   }
   expect(()=>load({accounts:{writer:['generate']}})).not.toThrow();
 });
 it('the default never makes the host proxy write description true',()=>{
   const config=withDefault({writer:['generate']});
   const rules:any[]=[{path:'/',match:'prefix',methods:['GET','HEAD'],capability:'view'},
     {path:'/generate',match:'exact',methods:['POST'],capability:'generate'},
     {path:'/view-write',match:'exact',methods:['POST'],capability:'view'}];
   for(const scopes of [['services:read','services:write'],['root']]){
     expect(pluginCanWriteThroughProxy(config,'newcomer',scopes,rules)).toBe(false);
     expect(pluginCanWriteThroughProxy(config,'writer',scopes,rules)).toBe(true);
   }
 });
 it('a default that bypassed load validation is ignored at use time',()=>{
   for(const value of [['generate'],['view','generate'],'view',['view','view'],[{}]]){
     const config:any={access:{default:value}};
     expect(pluginAccountCan(config,'newcomer','view')).toBe(false);
     expect(pluginAccountCan(config,'newcomer','generate')).toBe(false);
   }
 });
 it('the default never reaches a request without an active Account',()=>{
   const config=withDefault();
   expect(pluginAccountCan(config,null)).toBe(false);
   expect(pluginAccountCan(config,'')).toBe(false);
   expect(pluginCanWriteThroughProxy(config,null,['root'],[{path:'/',match:'prefix',methods:['POST'],capability:'view'}])).toBe(false);
 });
});

// Card bedf50cc (upgrade compatibility). A declared relayhall.min_version is
// compared with the release identity the backend reports (RELAYHALL_VERSION),
// never with the backend package.json base version.
describe('declared minimum host version (card bedf50cc)', () => {
 type Contract=typeof import('../services/PluginHostContract');
 // The contract module as a host reporting `version` would load it.
 const onHost=(version:unknown):Contract=>{
   let loaded:Contract|undefined;
   jest.isolateModules(()=>{
     jest.doMock('../version',()=>({RELAYHALL_VERSION:version}));
     loaded=require('../services/PluginHostContract');
   });
   jest.dontMock('../version');
   return loaded!;
 };
 const declaring=(minimum:unknown):any=>{const m=manifest();m.relayhall.min_version=minimum;return m;};
 const load=(contract:Contract,m:any)=>contract.validatePluginContract(m,{name:m.name} as any);
 it.each(['not-a-version','v1.0.0',' 1.0.0','1.0','1.0.0-beta.01','',null,42,{},['1.0.0'],'1.0.0-'+'a'.repeat(160)])(
   'refuses a malformed relayhall.min_version: %j',minimum=>{
     expect(()=>load(onHost('1.0.0-beta.56'),declaring(minimum))).toThrow('Invalid plugin minimum host version');
   });
 it('refuses min_version 1.0.0 on host 1.0.0-beta.56 (prerelease sorts below stable)',()=>{
   const host=onHost('1.0.0-beta.56');
   for(const minimum of ['1.0.0','1.0.0-beta.57','1.0.0-rc.1','1.0.1-alpha.1'])
     expect(()=>load(host,declaring(minimum))).toThrow('Plugin requires a newer host version');
 });
 it('accepts min_version equal to or below the host',()=>{
   const host=onHost('1.0.0-beta.56');
   // beta.9 < beta.56: numeric identifiers compare as numbers, not as text.
   for(const minimum of ['1.0.0-beta.56','1.0.0-beta.56+plugin-build','1.0.0-beta.9','1.0.0-alpha.3','0.9.0'])
     expect(()=>load(host,declaring(minimum))).not.toThrow();
   expect(()=>load(host,manifest())).not.toThrow();
 });
 it('takes the host version from RELAYHALL_VERSION, not package.json',()=>{
   const packageBase:string=require('../../package.json').version;
   // Versions derived from the package base, so the case holds whatever version the package carries.
   const base=/^(\d+\.\d+\.\d+-beta\.)(\d+)$/.exec(packageBase);
   expect(base).not.toBeNull();
   const above=(steps:number)=>`${base![1]}${Number(base![2])+steps}`;
   const host=onHost(above(6));
   expect(()=>load(host,declaring(above(1)))).not.toThrow();
   // The package base the unreleased fallback is built from would refuse it.
   expect(()=>host.validatePluginMinimumVersion(above(1),packageBase)).toThrow('Plugin requires a newer host version');
   // Unmocked, the contract compares with the version this backend reports.
   const {RELAYHALL_VERSION}=require('../version');
   expect(()=>validatePluginContract(declaring(RELAYHALL_VERSION),{name:'sample-plugin'} as any)).not.toThrow();
 });
 it('refuses a declared minimum when the host reports no release identity',()=>{
   for(const reported of ['unknown','',null])
     expect(()=>load(onHost(reported),declaring('1.0.0-beta.1'))).toThrow('Plugin host version unavailable');
   expect(()=>load(onHost(null),manifest())).not.toThrow();
 });
 it('leaves a legacy manifest\'s advisory min_version unenforced',()=>{
   const legacy=declaring('99.0.0');delete legacy.schema_version;legacy.relayhall={min_version:'99.0.0'};
   expect(()=>load(onHost('1.0.0-beta.56'),legacy)).not.toThrow();
 });
 it('gives each version refusal its own fixed reason code',()=>{
   const host=onHost('1.0.0-beta.56');
   const reason=(contract:Contract,run:()=>void)=>{try{run();}catch(caught){return caught instanceof contract.PluginContractError?caught.reason:'not a contract refusal';}return 'accepted';};
   expect(reason(host,()=>load(host,declaring('not-a-version')))).toBe('PLUGIN_MIN_VERSION_MALFORMED');
   expect(reason(host,()=>load(host,declaring('99.0.0')))).toBe('PLUGIN_MIN_VERSION_UNSATISFIED');
   const unknown=onHost('unknown');
   expect(reason(unknown,()=>load(unknown,declaring('1.0.0-beta.1')))).toBe('PLUGIN_HOST_VERSION_UNAVAILABLE');
 });
});

// Card bedf50cc slice 2. A load refusal reaches the operator log as a fixed
// reason code from a closed set, never as the refusal text or manifest data.
describe('contract refusal reason codes (card bedf50cc)', () => {
 const refusal=(run:()=>void):unknown=>{try{run();}catch(caught){return caught;}return 'accepted';};
 it('a trailing-slash allow path and a malformed rule refuse with their own reason codes',()=>{
   const slash=manifest();slash.api.allow=[{path:'/',methods:['GET'],capability:'view'},{path:'/private/',methods:['GET'],capability:'manage'}];
   const caught=refusal(()=>validatePluginContract(slash,{name:slash.name} as any));
   expect(caught).toBeInstanceOf(PluginContractError);
   expect((caught as PluginContractError).reason).toBe('PLUGIN_ALLOW_PATH_NOT_CANONICAL');
   expect(pluginLoadRefusalReason(caught)).toBe('PLUGIN_ALLOW_PATH_NOT_CANONICAL');
   const malformed=manifest();malformed.api.allow=[{path:'/',methods:['TRACE'],capability:'view'}];
   expect(pluginLoadRefusalReason(refusal(()=>validatePluginContract(malformed,{name:malformed.name} as any)))).toBe('PLUGIN_ALLOW_RULE_MALFORMED');
   expect(pluginLoadRefusalReason(refusal(()=>validatePluginContract({...manifest(),schema_version:'future'},{name:'sample-plugin'} as any)))).toBe('PLUGIN_SCHEMA_UNSUPPORTED');
 });
 it('every reason code is a fixed upper-case token and the contract raises no untyped refusal',()=>{
   expect(new Set(PLUGIN_CONTRACT_REFUSALS).size).toBe(PLUGIN_CONTRACT_REFUSALS.length);
   for(const code of PLUGIN_CONTRACT_REFUSALS) expect(code).toMatch(/^PLUGIN_[A-Z0-9_]+$/);
   const source:string=require('fs').readFileSync(require('path').resolve(__dirname,'../services/PluginHostContract.ts'),'utf-8');
   expect(source).not.toMatch(/throw new Error\(/);
 });
 it('answers the unclassified code for anything that is not a contract refusal, without running caller code',()=>{
   expect(pluginLoadRefusalReason(new Error('Plugin requires a newer host version'))).toBe('PLUGIN_LOAD_UNCLASSIFIED');
   expect(pluginLoadRefusalReason(Object.assign(new Error('forged'),{reason:'PLUGIN_MIN_VERSION_UNSATISFIED'}))).toBe('PLUGIN_LOAD_UNCLASSIFIED');
   expect(pluginLoadRefusalReason({reason:'PLUGIN_MIN_VERSION_UNSATISFIED'})).toBe('PLUGIN_LOAD_UNCLASSIFIED');
   expect(pluginLoadRefusalReason(null)).toBe('PLUGIN_LOAD_UNCLASSIFIED');
   const tampered=new PluginContractError('PLUGIN_PORT_INVALID','Invalid plugin port');
   (tampered as any).reason='private text from a tampered value';
   expect(pluginLoadRefusalReason(tampered)).toBe('PLUGIN_LOAD_UNCLASSIFIED');
   const getter=new PluginContractError('PLUGIN_PORT_INVALID','Invalid plugin port');
   const read=jest.fn(()=>'PLUGIN_PORT_INVALID');
   Object.defineProperty(getter,'reason',{get:read});
   expect(pluginLoadRefusalReason(getter)).toBe('PLUGIN_LOAD_UNCLASSIFIED');
   expect(read).not.toHaveBeenCalled();
 });
});

// Card bedf50cc slice 2. Each settings entry is described read-only unless a
// write to its own path selects (with the proxy's precedence) a rule whose
// non-view capability this Account holds explicitly, and the caller can write.
describe('settings entry read-only description (card bedf50cc)', () => {
 const config:any={access:{accounts:{owner:['view','manage'],reader:['view'],auditor:['view','audit','generate']}}};
 const write=['services:read','services:write'];
 const readOnly=(rules:any[],path:string,id:string|null='owner',scopes:string[]=write,installation:any=config)=>
   pluginSettingReadOnly(installation,id,scopes,rules,path);
 const viewGet={path:'/',match:'prefix',methods:['GET','HEAD'],capability:'view'};
 it('a view entry with a POST rule under another capability is writable only for an Account holding that capability',()=>{
   const rules=[viewGet,{path:'/settings',match:'exact',methods:['POST'],capability:'manage'}];
   expect(readOnly(rules,'/settings','owner')).toBe(false);
   expect(readOnly(rules,'/settings','reader')).toBe(true);
 });
 it('a GET-only entry under a non-view capability is read-only even when the capability is held',()=>{
   const rules:any[]=[viewGet,{path:'/history',match:'exact',methods:['GET'],capability:'audit'},
     {path:'/generate',match:'exact',methods:['POST'],capability:'generate'}];
   expect(pluginCanWriteThroughProxy(config,'auditor',write,rules)).toBe(true);
   expect(readOnly(rules,'/history','auditor')).toBe(true);
 });
 it.each(['POST','PUT','PATCH','DELETE'])('recognizes a %s rule on the entry path or a prefix of it',method=>{
   expect(readOnly([viewGet,{path:'/settings',match:'exact',methods:[method],capability:'manage'}],'/settings')).toBe(false);
   expect(readOnly([viewGet,{path:'/settings',match:'prefix',methods:[method],capability:'manage'}],'/settings/personal')).toBe(false);
   expect(readOnly([viewGet,{path:'/',match:'prefix',methods:[method],capability:'manage'}],'/settings')).toBe(false);
 });
 it('follows the proxy precedence and ignores writes that reach only a descendant or a sibling',()=>{
   const shadowed=[viewGet,{path:'/settings',match:'prefix',methods:['POST'],capability:'manage'},
     {path:'/settings/personal',match:'exact',methods:['POST'],capability:'other'}];
   expect(readOnly(shadowed,'/settings/personal')).toBe(true);
   expect(readOnly(shadowed,'/settings/shared')).toBe(false);
   expect(readOnly([viewGet,{path:'/settings/save',match:'exact',methods:['POST'],capability:'manage'}],'/settings')).toBe(true);
   expect(readOnly([viewGet,{path:'/settings',match:'exact',methods:['POST'],capability:'manage'}],'/settings/personal')).toBe(true);
   expect(readOnly([viewGet,{path:'/settings-extra',match:'prefix',methods:['POST'],capability:'manage'}],'/settings')).toBe(true);
 });
 it('never describes a write through a rule labelled view or without a capability',()=>{
   const viewOwner:any={access:{accounts:{owner:['view']}}};
   expect(readOnly([viewGet,{path:'/settings',match:'exact',methods:['POST'],capability:'view'}],'/settings','owner',write,viewOwner)).toBe(true);
   expect(readOnly([viewGet,{path:'/settings',match:'exact',methods:['POST']}],'/settings','owner',write,viewOwner)).toBe(true);
 });
 it('requires the write scope and an active Account, even for root',()=>{
   const rules=[viewGet,{path:'/settings',match:'exact',methods:['POST'],capability:'manage'}];
   expect(readOnly(rules,'/settings','owner',['services:read'])).toBe(true);
   expect(readOnly(rules,'/settings','owner',['root'])).toBe(false);
   expect(readOnly(rules,'/settings','reader',['root'])).toBe(true);
   expect(readOnly(rules,'/settings',null,['root'])).toBe(true);
   expect(readOnly(rules,'/settings','')).toBe(true);
 });
 it('the deployment view default never makes a settings entry writable',()=>{
   const installation:any={access:{default:['view'],accounts:{writer:['manage']}}};
   const rules=[viewGet,{path:'/settings',match:'exact',methods:['POST'],capability:'manage'}];
   for(const scopes of [write,['root']]){
     expect(readOnly(rules,'/settings','newcomer',scopes,installation)).toBe(true);
     expect(readOnly(rules,'/settings','writer',scopes,installation)).toBe(false);
   }
 });
});
