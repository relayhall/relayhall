import fs from 'fs';
import path from 'path';
import { validateBlueprintDocument } from '../utils/blueprintDocument';
import { buildBlueprintPlan, enforceBlueprintPlan, BlueprintPlanContext } from '../services/BlueprintPlanService';
const names=['project-design','governed-deployment','incident-investigation'];
const folder=path.resolve(__dirname,'../../../docs/blueprints/examples');
const project='11111111-2222-4333-8444-555555555555';
function fixture(name:string,availableService=false){
 const doc=validateBlueprintDocument(JSON.parse(fs.readFileSync(path.join(folder,name+'.json'),'utf8')),{limit:102400});
 const values=Object.fromEntries(doc.parameters.map(p=>[p.key,
  p.type==='principal-ref'?p.key:p.type==='project-ref'?'example-project':p.type==='integer'?p.default ?? 4:p.type==='enum'?p.constraints.enum[0]:p.type==='date'?'2026-09-06':p.key==='incident_number'?'INC-42':p.key==='affected_hostname'?'example-host':p.type==='text'?'Reviewed governing record':'Example']));
 const context:BlueprintPlanContext={target:{mode:doc.target.mode,projectId:project},authorize:async()=>true,
  resolve:async(kind,name)=>kind==='service'&&!availableService?null:{kind,name,id:kind==='project'?project:kind==='service'?'77777777-2222-4333-8444-555555555555':`${kind}-${name}`,version:1,handle:kind==='principal'?name:undefined,
   ...(kind==='service'?{serviceKind:'connector',descriptor:{options:[]}}:{})}};
 return {doc,values,context};
}
describe('ratified portable Blueprint examples',()=>{
 test.each(names)('%s is valid and compiles with ordinary references and absent optional Service',async name=>{
  const {doc,values,context}=fixture(name);const plan=await buildBlueprintPlan(doc,values,{limit:102400},context);
  if(plan.references.some(reference=>reference.outcome!=='resolved')) expect(()=>enforceBlueprintPlan(plan)).toThrow('Access is required');
  else expect(()=>enforceBlueprintPlan(plan)).not.toThrow();expect(plan.counts.tasks).toBe(doc.tasks.length+doc.humanGates.length);
  expect(plan.tasks.every(task=>task.autoStart===false)).toBe(true);expect(plan.humanGates.length).toBeGreaterThan(0);
  const keys=new Set(plan.tasks.map(task=>task.key));for(const edge of plan.dependencies){expect(keys.has(edge.task)).toBe(true);expect(keys.has(edge.dependsOn)).toBe(true)}
 });
 test('incident interview has exact seven declared parameters and a single shared Announce Task',async()=>{
  const {doc,values,context}=fixture('incident-investigation');const plan=await buildBlueprintPlan(doc,values,{limit:102400},context);
  expect(doc.parameters.map(p=>p.key)).toEqual(['incident_number','incident_title','severity','affected_hostname','incident_commander','scribe','detected_at']);
  expect(plan.tasks.filter(task=>task.key==='announce')).toHaveLength(1);
  expect(plan.dependencies.filter(edge=>edge.task==='announce'&&edge.dependsOn==='fix-decision')).toHaveLength(1);
  expect(plan.tasks.find(task=>task.key==='announce')?.roles.shepherdHandle).toBe('incident_commander');
  expect(plan.tasks.find(task=>task.key==='fix-decision')?.roles.verifierHandle).toBe('incident_commander');
 });
 test.each(['governed-deployment','incident-investigation'])('%s preserves available-Service execution defaults for separately confirmed setup',async name=>{
  const {doc,values,context}=fixture(name,true);const plan=await buildBlueprintPlan(doc,values,{limit:102400},context);
  const assigned=plan.tasks.filter(task=>task.service?.name==='hermes');expect(assigned).toHaveLength(1);
  expect(assigned[0].executionProfile).toEqual({serviceId:'77777777-2222-4333-8444-555555555555',descriptorVersion:1,options:{}});
  expect(plan.refusals).toEqual([]);
  expect(assigned[0].autoStart).toBe(false);
  expect(()=>enforceBlueprintPlan(plan)).not.toThrow();
 });
});
