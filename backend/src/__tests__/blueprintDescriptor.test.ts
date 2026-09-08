import { BLUEPRINT_SCHEMA, BlueprintDocument, validateBlueprintDocument, substituteBlueprint } from '../utils/blueprintDocument';
import { buildBlueprintPlan, enforceBlueprintPlan, BlueprintPlanContext } from '../services/BlueprintPlanService';
import { normalizeConnectorProfileOptions } from '../utils/executionProfile';
import type { DescriptorOption } from '../utils/serviceDescriptor';
const config={limit:102400};
function source():BlueprintDocument { return {
 schemaVersion:BLUEPRINT_SCHEMA,blueprint:{key:'descriptor-proof',name:'Descriptor proof',version:1,summary:'',description:'',tags:[],provenance:'human-authored'},
 parameters:[{key:'answer',label:'Answer',promptText:'Text?',type:'string',required:false,default:'Inspect'}],
 references:[{kind:'service',name:'hermes',requirement:'required',minVersion:2}],
 target:{mode:'new-project',project:{name:'Descriptor proof'}},phases:[],reports:[],humanGates:[],dependencies:[],
 tasks:[{key:'inspect',title:'Inspect',defaults:{executionProfile:{service:'hermes',options:{command:'Run {{answer}}'}}}}]
}; }
function context(options:DescriptorOption[]=[{key:'command',type:'string',required:true}]):BlueprintPlanContext {
 return {target:{mode:'new-project'},resolve:jest.fn(async(kind,name)=>({kind,name,id:'resolved-connector',version:3,serviceKind:'connector',descriptor:{options}})),authorize:jest.fn(async()=>true)};
}
describe('Blueprint pinned descriptor interpolation',()=>{
 test('direct option syntax is portable but remains untouched by ordinary text substitution',()=>{
  const d=validateBlueprintDocument(source(),config);
  expect(substituteBlueprint(d,{answer:'Inspect'}).tasks[0].defaults.executionProfile.options.command).toBe('Run {{answer}}');
 });
 test('shared plan uses the resolved pin and the actual canonical option normalizer exactly once',async()=>{
  const d=source();d.parameters.push({key:'other',label:'Other',promptText:'Other?',type:'string',required:false,default:'Recursive'});const original=JSON.stringify(d);const ctx=context();
  const plan=await buildBlueprintPlan(d,{answer:'{{other}}'},config,ctx);
  expect(plan.tasks[0].executionProfile).toEqual(normalizeConnectorProfileOptions({options:{command:'Run {{other}}'}},'resolved-connector',3,{options:[{key:'command',type:'string',required:true}]}));
  expect(plan.tasks[0].executionProfile.descriptorVersion).toBe(3);
  expect(plan.tasks[0].defaults.executionProfile.options).toEqual(plan.tasks[0].executionProfile.options);
  expect(ctx.resolve).toHaveBeenCalledWith('service','hermes',2,undefined);
  expect(JSON.stringify(plan)).not.toContain('"descriptor":');
  expect(JSON.stringify(d)).toBe(original);
  expect(plan.refusals).toEqual([]);
  expect(()=>enforceBlueprintPlan(plan)).not.toThrow();
 });
 test('parameter defaults materialize before descriptor validation without inventing descriptor defaults',async()=>{
  const ctx=context([{key:'command',type:'string',required:true},{key:'optional',type:'string',default:'Not implicit'}]);
  const plan=await buildBlueprintPlan(source(),{},config,ctx);
  expect(plan.tasks[0].executionProfile.options).toEqual({command:'Run Inspect'});
 });
 test.each(['enum','boolean','number','secretReference','resourceSelector'] as const)('descriptor type %s forbids interpolation even when its runtime value could validate',async type=>{
  const d=source();d.tasks[0].defaults.executionProfile.options={title:'{{answer}}'};
  const ctx=context([{key:'title',type,values:[{value:'Inspect'}],allowedReferences:['Inspect']}]);
  await expect(buildBlueprintPlan(d,{answer:'Inspect'},config,ctx)).rejects.toMatchObject({status:422,field:'tasks.inspect.defaults.executionProfile.options.title'});
  expect(ctx.authorize).toHaveBeenCalledWith(expect.objectContaining({operation:'service.invoke'}));
 });
 test('undeclared option interpolation refuses with the same named Blueprint field',async()=>{
  const ctx=context([]);await expect(buildBlueprintPlan(source(),{},config,ctx)).rejects.toMatchObject({status:422,field:'tasks.inspect.defaults.executionProfile.options.command'});
 });
 test('literal non-string options still use canonical typed validation',async()=>{
  const d=source();d.tasks[0].defaults.executionProfile.options={retries:2,enabled:false};
  const plan=await buildBlueprintPlan(d,{},config,context([{key:'retries',type:'number'},{key:'enabled',type:'boolean'}]));
  expect(plan.tasks[0].executionProfile.options).toEqual({retries:2,enabled:false});
  d.tasks[0].defaults.executionProfile.options.retries='two';
  await expect(buildBlueprintPlan(d,{},config,context([{key:'retries',type:'number'},{key:'enabled',type:'boolean'}]))).rejects.toMatchObject({code:'PROFILE_INVALID_VALUE'});
 });
 test('runtime credential refusal precedes descriptor resolution and every authority callback',async()=>{
  const ctx=context();await expect(buildBlueprintPlan(source(),{answer:'rh_live_abcdefghijklmnopqrstuvwxyz'},config,ctx)).rejects.toMatchObject({code:'PARAMETER_VALUE_REFUSED'});
  expect(ctx.resolve).not.toHaveBeenCalled();expect(ctx.authorize).not.toHaveBeenCalled();
 });
 test('optional absent or hidden Service refuses creation without exposing descriptor data',async()=>{
  const d=source();d.references[0].requirement='optional';const ctx=context();ctx.resolve=jest.fn(async()=>null);
  const plan=await buildBlueprintPlan(d,{},config,ctx);
  expect(plan.tasks[0].executionProfile).toBeNull();expect(plan.references[0]).toMatchObject({outcome:'missing-optional',resolved:null});
  expect(plan.refusals[0].code).toBe('BLUEPRINT_REFERENCE_ACCESS_REQUIRED');
 });
 test('typed reference parameters cannot enter string options',()=>{
  const d=source();d.parameters[0]={key:'answer',type:'service-ref',label:'Service',promptText:'Which?',required:true};
  expect(()=>validateBlueprintDocument(d,config)).toThrow('Substitution is not allowed');
 });
 test('nested option values cannot enter the deferred interpolation territory',()=>{
  const d=source();d.tasks[0].defaults.executionProfile.options={outer:{title:'{{answer}}'}};
  expect(()=>validateBlueprintDocument(d,config)).toThrow('Substitution is not allowed');
 });
 test('a missing immutable descriptor or pin fails closed',async()=>{
  const ctx=context();ctx.resolve=jest.fn(async(kind,name)=>({kind,name,id:'resolved-connector'}));
  await expect(buildBlueprintPlan(source(),{},config,ctx)).rejects.toMatchObject({code:'BLUEPRINT_REFERENCE_MISSING'});
 });
 test('plain Services cannot become execution Connectors merely by publishing a descriptor',async()=>{
  const ctx=context();ctx.resolve=jest.fn(async(kind,name)=>({kind,name,id:'plain-service',version:1,serviceKind:'service',descriptor:{options:[{key:'command',type:'string' as const}]}}));
  await expect(buildBlueprintPlan(source(),{},config,ctx)).rejects.toMatchObject({code:'PROFILE_SERVICE_NOT_CONNECTOR'});
 });
 test('placeholder field names are refused before capability resolution',()=>{
  const d=source();d.tasks[0].defaults.executionProfile.options={'{{answer}}':'Literal'};
  expect(()=>validateBlueprintDocument(d,config)).toThrow('field names');
 });

 test('preview observations of two immutable pins never alias the descriptor cache by Service ID',async()=>{
  const d=source();d.parameters.push({key:'runtime_service',label:'Service',promptText:'Which?',type:'service-ref',required:true});
  d.tasks[0].defaults.executionProfile={service:'{{runtime_service}}',options:{command:'Inspect'}};
  d.tasks.push({key:'later',title:'Later',defaults:{executionProfile:{service:'hermes',options:{command:'Run {{answer}}'}}}});
  const ctx=context();ctx.resolve=jest.fn(async(kind,name)=>({kind,name,id:'same-connector',serviceKind:'connector',version:name==='runtime'?4:3,
   descriptor:{options:[name==='runtime'?{key:'command',type:'enum' as const,values:[{value:'Inspect'}]}:{key:'command',type:'string' as const}]}}));
  const plan=await buildBlueprintPlan(d,{runtime_service:'runtime'},config,ctx);
  expect(plan.tasks.map(task=>task.executionProfile)).toEqual([
   {serviceId:'same-connector',descriptorVersion:4,options:{command:'Inspect'}},
   {serviceId:'same-connector',descriptorVersion:3,options:{command:'Run Inspect'}},
  ]);
 });

});
test('nested Connector parameter strings round-trip through the pinned canonical validator',async()=>{
 const d=source();d.tasks[0].defaults.executionProfile.parameters={command:{context:'For {{answer}}'}};
 const ctx=context([{key:'command',type:'string',required:true,parameters:[{key:'context',type:'string',required:true}]}]);
 const plan=await buildBlueprintPlan(d,{answer:'inspection'},config,ctx);
 expect(plan.tasks[0].executionProfile.parameters).toEqual({command:{context:'For inspection'}});
 expect(JSON.stringify(plan)).not.toContain('"descriptor":');
});
test('descriptor drift and missing invoke/use access are named structured refusals',async()=>{
 const d=source();d.references[0].descriptorSha256='0'.repeat(64);
 const plan=await buildBlueprintPlan(d,{},config,context());
 expect(plan.references[0]).toMatchObject({outcome:'missing-required',requiredAccess:'services:read and services:invoke'});
 expect(plan.references[0].reason).toContain('descriptor changed');
 expect(()=>enforceBlueprintPlan(plan)).toThrow();
 const use=source();use.references.push({kind:'skill',name:'inspect-work',requirement:'optional'});
 const ctx=context();ctx.authorize=jest.fn(async requirement=>requirement.operation!=='skill.use');
 const denied=await buildBlueprintPlan(use,{},config,ctx);
 expect(denied.references.find(r=>r.kind==='skill')).toMatchObject({outcome:'missing-optional',requiredAccess:'skills:read and skills:use'});
 expect(()=>enforceBlueprintPlan(denied)).toThrow('Access is required for inspect-work');
});
