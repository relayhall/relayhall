jest.mock('../db/connection',()=>({pool:{query:jest.fn(),connect:jest.fn()}}));
import {isShepherdTaskPatch,pointAuthorizationTarget} from '../middleware/sharedAuthorization';

describe('canonical bounded Shepherd PATCH classifier',()=>{
 test.each([{autoStart:false},{executionProfile:{serviceId:'fixture',descriptorVersion:1,options:{}}},{executionProfile:{},executionWarrantId:null}])('admits only a park or non-null assignment shape %j',body=>{
  expect(isShepherdTaskPatch(body)).toBe(true);expect(pointAuthorizationTarget('PATCH','/TASKS/fixture/',body)).toEqual({type:'task',identifier:'fixture',action:'write',alternativeAction:'shepherd'});
 });
 test.each([null,undefined,[],{},Object.create(null),{autoStart:true},{autoStart:'false'},{autoStart:0},{autoStart:false,title:'Changed'},{autoStart:false,status:'archived'},{executionProfile:null},{executionProfile:[]},{executionProfile:{},title:'Changed'},{executionProfile:{},autoStart:true},{executionProfile:{},executionServiceId:'id'},{executionWarrantId:'id'}])('refuses a mixed, retired or unrelated body %j',body=>{
  expect(isShepherdTaskPatch(body)).toBe(false);expect(pointAuthorizationTarget('PATCH','/tasks/fixture',body)?.alternativeAction).toBeUndefined();
 });
 test.each([['POST','/tasks/fixture'],['GET','/tasks/fixture'],['PATCH','/projects/fixture'],['PATCH','/tasks/fixture/subtasks/1/status'],['PATCH','/tasks/batch']])('does not add a Shepherd arm to %s %s',(method,path)=>{
  expect(pointAuthorizationTarget(method,path,{autoStart:false})?.alternativeAction).toBeUndefined();
 });
});
