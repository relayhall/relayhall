jest.mock('../db/connection',()=>({pool:{query:jest.fn()}}));
jest.mock('../services/AuthorizationService',()=>({authorizationService:{authorizeRoute:jest.fn(),authorizeResource:jest.fn()}}));
jest.mock('../services/AuthorizationRepository',()=>({authorizationRepository:{listScope:jest.fn(),authorizedIds:jest.fn()}}));
import { pool } from '../db/connection';
import { authorizationService } from '../services/AuthorizationService';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { BlueprintResolutionService } from '../services/BlueprintResolutionService';
import type { BlueprintCreationCaller } from '../services/BlueprintInstantiationService';
const identity={principalId:'caller',handle:'caller',role:'user',authenticated:true,scopes:['tasks:write','principals:read']};
const caller:BlueprintCreationCaller={actor:identity,audit:{principalId:'caller',handle:'caller',authMethod:'session'},rootSession:false,taskActor:{principalId:'caller',handle:'caller',authMethod:'session',authorization:identity}};
describe('Blueprint canonical role admission',()=>{
 beforeEach(()=>{jest.clearAllMocks();(authorizationService.authorizeRoute as jest.Mock).mockImplementation((_actor,scope)=>({allowed:identity.scopes.includes(scope)}));(authorizationService.authorizeResource as jest.Mock).mockReturnValue({allowed:true});(pool.query as jest.Mock).mockResolvedValue({rows:[{id:'service-principal',kind:'service',handle:'reviewer',bound_task_id:null,legacy_identity:false}]})});
 test('Service Verifier requires ordinary Task role authority, without an extra execution scope',async()=>{
  const context=new BlueprintResolutionService(()=>[]).context(caller,{mode:'new-project'});await context.resolve('principal','reviewer');
  expect(await context.authorize({operation:'task.roles',scope:'tasks:write',localKey:'gate',principalIds:['service-principal']})).toBe(true);
 });
 test('Service Shepherd retains the canonical services:invoke ceiling',async()=>{
  const context=new BlueprintResolutionService(()=>[]).context(caller,{mode:'new-project'});await context.resolve('principal','reviewer');
  expect(await context.authorize({operation:'task.roles',scope:'tasks:write',localKey:'arm',principalIds:['service-principal'],shepherdPrincipalId:'service-principal'})).toBe(false);
 });
 test('the ordinary Shepherd object decision remains necessary regardless of target Principal kind',async()=>{
  (authorizationService.authorizeResource as jest.Mock).mockReturnValue({allowed:false});const context=new BlueprintResolutionService(()=>[]).context(caller,{mode:'new-project'});await context.resolve('principal','reviewer');
  expect(await context.authorize({operation:'task.roles',scope:'tasks:write',localKey:'gate',principalIds:['service-principal']})).toBe(false);
 });
});

describe('Blueprint Personality immutable current-version floor',()=>{
 beforeEach(()=>{jest.clearAllMocks();(authorizationRepository.listScope as jest.Mock).mockReturnValue({from:'personalities pe',id:'pe.id',render:()=>({sql:'caller_visible($2)',params:['caller']})});});
 test('uses the current immutable version and canonical caller visibility in the same supplied transaction',async()=>{
  const client={query:jest.fn(async(_sql:string,_params:unknown[])=>({rows:[{id:'personality',name:'analysis',version:3}]}))};
  const context=new BlueprintResolutionService(()=>[]).context(caller,{mode:'new-project'},client as any);
  expect(await context.resolve('personality','analysis',2)).toMatchObject({id:'personality',version:3});
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining('JOIN personality_versions pv ON pv.personality_id=pe.id AND pv.version=pe.current_version'),['analysis','caller']);
  expect(client.query.mock.calls[0][0]).toContain("pe.retired_at IS NULL AND caller_visible($2)");expect(pool.query).not.toHaveBeenCalled();
 });
 test('a current immutable version below the declared floor is absent',async()=>{
  (pool.query as jest.Mock).mockResolvedValue({rows:[{id:'personality',version:2}]});
  expect(await new BlueprintResolutionService(()=>[]).context(caller,{mode:'new-project'}).resolve('personality','analysis',3)).toBeNull();
 });
 test('missing or concealed current immutable row does not fabricate a version',async()=>{
  (pool.query as jest.Mock).mockResolvedValue({rows:[]});
  expect(await new BlueprintResolutionService(()=>[]).context(caller,{mode:'new-project'}).resolve('personality','analysis',1)).toBeNull();
 });
});
