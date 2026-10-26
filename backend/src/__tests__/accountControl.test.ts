jest.mock('../db/connection', () => ({ pool: { query: jest.fn() } }));
jest.mock('../services/DelegationService', () => ({ delegationService: { resolveChain: jest.fn() } }));
jest.mock('../services/TaskAuthoritySnapshot', () => ({ taskAuthoritySnapshot: jest.fn() }));
jest.mock('../services/AuthorizationRepository', () => ({ authorizationRepository: { authorizedIds: jest.fn() } }));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn() } }));
import { controllerAccount, taskAccountControl } from '../services/AccountControlService';
import { delegationService } from '../services/DelegationService';
import { taskAuthoritySnapshot } from '../services/TaskAuthoritySnapshot';
import { authorizationRepository } from '../services/AuthorizationRepository';
import type { ChainLink } from '../services/DelegationService';

const human: ChainLink = { principalId:'human',kind:'human',role:'user',status:'active',
 parentPrincipalId:null,boundTaskId:null,legacyIdentity:false,ownExpression:null,liveCredentialCount:0 };
const main: ChainLink = { ...human,principalId:'main',kind:'service',parentPrincipalId:'human',
 ownerControlAccountId:'human',ownExpression:{scopes:'parent',objects:'parent'},liveCredentialCount:1 };
const actor:any={principalId:'main',handle:'anything',authMethod:'bearer',credentialId:'credential',
 authorization:{principalId:'main',authenticated:true,role:'agent',scopes:['tasks:write']}};
let chain:ChainLink[], alive:boolean, owned:boolean, credentialScopes:string[], writable:boolean;
const query=jest.fn(async(sql:string)=>({rows:
 sql.includes('principal_credentials') ? [{scopes:credentialScopes}] :
 sql.includes('FROM tasks t') ? owned ? [{id:'task'}] : [] :
 sql.includes('auth_sessions') ? [{id:'session'}] : [] }));
beforeEach(()=>{
 jest.clearAllMocks();chain=[{...main},{...human}];alive=true;owned=true;writable=true;credentialScopes=['tasks:write'];
 (delegationService.resolveChain as jest.Mock).mockImplementation(async()=>({links:chain,alive}));
 (taskAuthoritySnapshot as jest.Mock).mockResolvedValue([actor.authorization,actor.authorization]);
 (authorizationRepository.authorizedIds as jest.Mock).mockImplementation(async()=>new Set(writable?['task']:[]));
});
test('explicit direct Main appointment and canonical owner write permit management',async()=>{
 expect(await taskAccountControl({query} as any,'task',actor)).toBe('human');
 expect(authorizationRepository.authorizedIds).toHaveBeenCalledTimes(2);
});
test.each(['absent','agent','nested','reparented','disabled','legacy','bound'])('%s Main designation never grants management',async scenario=>{
 if(scenario==='absent')delete chain[0].ownerControlAccountId;
 if(scenario==='agent')chain[0].kind='agent';
 if(scenario==='nested')chain.splice(1,0,{...main,principalId:'middle'});
 if(scenario==='reparented')chain[0].parentPrincipalId='another';
 if(scenario==='disabled')chain[1].status='disabled';
 if(scenario==='legacy')chain[0].legacyIdentity=true;
 if(scenario==='bound')chain[0].boundTaskId='task';
 expect(await taskAccountControl({query} as any,'task',actor)).toBeNull();
});
test.each(['dead','foreign','revoked-scope','selector-cap'])('%s refuses account management',async scenario=>{
 if(scenario==='dead')alive=false;
 if(scenario==='foreign')owned=false;
 if(scenario==='revoked-scope')credentialScopes=['tasks:read'];
 if(scenario==='selector-cap')writable=false;
 expect(await taskAccountControl({query} as any,'task',actor)).toBeNull();
});
test('a human needs a live authenticated session, not a role or display name',async()=>{
 chain=[human];
 const owner={...actor,principalId:'human',credentialId:null,authorization:{...actor.authorization,principalId:'human'}};
 expect(await taskAccountControl({query} as any,'task',owner)).toBeNull();
 expect(await taskAccountControl({query} as any,'task',{...owner,authMethod:'session',sessionId:'session'})).toBe('human');
 query.mockImplementationOnce(async()=>({rows:[]}));
 expect(await taskAccountControl({query} as any,'task',{...owner,authMethod:'session',sessionId:'revoked'})).toBeNull();
});
test('a main-looking name and full-parent expression do not appoint a connector',()=>{
 expect(controllerAccount([{...main,ownerControlAccountId:null},human])).toBeNull();
});
