import {explicitTaskWriteCaps,assignedClaimCaps} from '../services/AssignedClaimAuthority';
import {authorizationService,AuthorizationActor} from '../services/AuthorizationService';
const task={type:'task' as const,id:'t',projectId:'p',assignedClaimEligible:true,assignedClaimPrincipalId:'s'};
function actor(objects:any='parent',kind='service'):AuthorizationActor{return {principalId:'s',authenticated:true,handle:'s',role:'service',scopes:['tasks:write'],delegation:{links:[{principalId:'s',kind,role:'service',parentPrincipalId:'a',boundTaskId:kind==='agent'?'t':null,legacyIdentity:false,ownExpression:{scopes:'parent',objects}},{principalId:'a',kind:'human',role:'user',parentPrincipalId:null,boundTaskId:null,legacyIdentity:false,ownExpression:null}]}};}
for(const objects of [[],[{resourceType:'task',selectorForm:'exact',selectorIds:['t'],verbs:['read']}],[{resourceType:'task',selectorForm:'all-except',selectorIds:['t'],verbs:['write']}],[{resourceType:'task',selectorForm:'future-form',selectorIds:[],verbs:['write']}]]) {
 test('explicit excluded own cap '+JSON.stringify(objects),()=>{expect(assignedClaimCaps(actor(objects),task)).toBe(false);expect(authorizationService.authorizeResource(actor(objects),'claim',task,[]).allowed).toBe(false);});
}
test('parent object inheritance skips only missing positive WRITE',()=>{expect(assignedClaimCaps(actor(),task)).toBe(true);expect(authorizationService.authorizeResource(actor(),'claim',task,[]).allowed).toBe(true);expect(authorizationService.authorizeResource(actor(),'write',task,[]).allowed).toBe(false);});
test('Agent final Task cap and exact Connector role stay separate',()=>{const a=actor('parent','agent');expect(explicitTaskWriteCaps(a,task)).toBe(true);expect(explicitTaskWriteCaps(a,{...task,id:'other'})).toBe(false);expect(assignedClaimCaps(a,task)).toBe(false);});

test('a delegated own root scope is not the literal Task WRITE ceiling',()=>{const a=actor();a.delegation!.links[0].ownExpression={scopes:['root'] as any,objects:'parent'};expect(explicitTaskWriteCaps(a,task)).toBe(false);expect(authorizationService.authorizeResource(a,'claim',task,[]).allowed).toBe(false);});
