jest.mock('../mcp/inProcess',()=>({dispatchInProcess:jest.fn()}));
import {toolByName} from '../mcp/registry';
import {dispatchInProcess} from '../mcp/inProcess';
const dispatch=jest.mocked(dispatchInProcess);
const task='11111111-1111-4111-8111-111111111111',review='22222222-2222-4222-8222-222222222222';
const context={authorization:'Bearer fixture',toolName:'relayhall_task_native_execution'};
beforeEach(()=>{dispatch.mockReset();dispatch.mockResolvedValue({status:200,headers:{},body:{success:true,result:{id:review}}});});
test.each(['list','open','authorize-launch','heartbeat','attest','close','cancel','reconcile'])('native %s uses fixed canonical route and unchanged caller',async action=>{
  const payload={bounded:'fixture'};
  const result=await toolByName('relayhall_task_native_execution')!.handler({task,executionId:review,action,payload},context);
  const path=`/tasks/${task}/native-executions`+(['list','open'].includes(action)?'':`/${review}/${action}`);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({path,authorization:context.authorization,method:action==='list'?'GET':'POST'}));
  expect(JSON.parse(result)).toEqual({success:true,result:{id:review}});
});
test('unknown act never becomes a model-selected route',async()=>{
  await expect(toolByName('relayhall_task_native_execution')!.handler({task,action:'claim'},context)).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
});
test.each(['reserve','read','consume','publication-intent','quarantine-dry-run','quarantine','quarantine-read'])('generation %s uses exact supported route',async action=>{
 const result=await toolByName('relayhall_task_native_generation')!.handler({task,generationId:review,quarantineId:review,action,payload:{schemaVersion:2}},context);
 const base=`/tasks/${task}/native-executions`;
 const suffix:any={reserve:'/generations',read:`/generations/${review}`,consume:`/generations/${review}/consume`,'publication-intent':`/generations/${review}/publication-intent`,'quarantine-dry-run':'/quarantine/dry-run',quarantine:'/quarantine','quarantine-read':`/quarantine/${review}`};
 expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({path:base+suffix[action],method:['read','quarantine-read'].includes(action)?'GET':'POST',authorization:context.authorization}));expect(JSON.parse(result).success).toBe(true);
});
test('generation tool refuses arbitrary action before transport',async()=>{await expect(toolByName('relayhall_task_native_generation')!.handler({task,action:'launch'},context)).rejects.toThrow();expect(dispatch).not.toHaveBeenCalled();});

test.each([{reportId:review},{report:{title:'Inline retained Report',content:'No committed result'}}])('MCP generic finish has no quarantine bypass or retry',async report=>{
 dispatch.mockResolvedValue({status:409,headers:{},body:{success:false,code:'NATIVE_GENERATION_IMPORT_HOLD',error:'Imported legacy uncertainty requires explicit cutover'}});
 await expect(toolByName('relayhall_task_finish')!.handler({task,handover:'Held handover',...report},context)).rejects.toThrow();
 expect(dispatch).toHaveBeenCalledTimes(1);expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({path:`/tasks/${task}/finish`,method:'POST',authorization:context.authorization,body:{handover:'Held handover',...report}}));
});
