import {AssignmentAccessError} from '../services/AccessVehicleService';
import {RequestFaultError} from '../utils/httpErrors';
jest.mock('../db/connection',()=>({pool:{query:jest.fn(),connect:jest.fn(),on:jest.fn()}}));
test('lifecycle busy is the established typed route fault, not a generic/native SQL fallback',()=>{
 const error=new AssignmentAccessError(409,'ASSIGNMENT_REFERENCE_BUSY','Roll back and retry');
 expect(error).toBeInstanceOf(RequestFaultError);expect({status:error.status,code:error.code,message:error.message}).toEqual({status:409,code:'ASSIGNMENT_REFERENCE_BUSY',message:'Roll back and retry'});
});

// Compile only the actual pure mapper declarations, without constructing routers,
// importing auth/runtime wiring or opening HTTP/listeners. No source replacement.
const ts=require('typescript');const fs=require('fs');const path=require('path');const vm=require('vm');
function mapper(file:string,name:string,extra:any={}) {
 const text=fs.readFileSync(path.join(__dirname,'..',file),'utf8');const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
 const node=ast.statements.find((n:any)=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(!node)throw Error('Missing maintained mapper');
 const source=ts.transpileModule(node.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
 return vm.runInNewContext(source+';'+name,{AssignmentAccessError,RequestFaultError,TaskElementError:class extends Error{},WarrantError:class extends Error{},StepUpError:class extends Error{},logCaughtFailure:jest.fn(()=>{throw Error('Generic fallback reached')}),...extra});
}
function response(){const r:any={};r.status=jest.fn(()=>r);r.json=jest.fn(()=>r);r.setHeader=jest.fn(()=>r);return r;}
test.each(['sendReviewEvidenceBusy','sendTaskElementError'])('Task mapper %s retains busy409 for verifier/dependency/delete/reference',name=>{
 const error=new AssignmentAccessError(409,'ASSIGNMENT_REFERENCE_BUSY','Roll back and retry'),sendApiError=jest.fn();const common=mapper('routes/tasks.ts','sendReviewEvidenceBusy',{sendApiError});const fn=mapper('routes/tasks.ts',name,{sendApiError,sendReviewEvidenceBusy:common});const res=response();fn(res,error);expect(sendApiError).toHaveBeenCalledWith(res,409,error.code,error.message);
});
test('Native typed mapper retains busy409 rather than unavailable',async()=>{const error=new AssignmentAccessError(409,'ASSIGNMENT_REFERENCE_BUSY','Roll back and retry');const fn=mapper('routes/nativeReviews.ts','handle');const res=response();await fn(async()=>{throw error;})({},res);expect(res.status).toHaveBeenCalledWith(409);expect(res.json).toHaveBeenCalledWith({success:false,code:error.code,error:error.message});});
test('Warrant mapper retains busy409',()=>{const error=new AssignmentAccessError(409,'ASSIGNMENT_REFERENCE_BUSY','Roll back and retry');const fn=mapper('routes/warrants.ts','sendWarrantError');const res=response();expect(fn(res,error)).toBe(true);expect(res.status).toHaveBeenCalledWith(409);expect(res.json).toHaveBeenCalledWith({error:'Refused',code:error.code,message:error.message});});
