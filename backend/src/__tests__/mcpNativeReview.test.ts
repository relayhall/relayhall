jest.mock('../mcp/inProcess',()=>({dispatchInProcess:jest.fn()}));
import {toolByName} from '../mcp/registry';
import {dispatchInProcess} from '../mcp/inProcess';
const dispatch=jest.mocked(dispatchInProcess);
const task='11111111-1111-4111-8111-111111111111',review='22222222-2222-4222-8222-222222222222';
const context={authorization:'Bearer fixture',toolName:'relayhall_task_native_review'};
beforeEach(()=>{dispatch.mockReset();dispatch.mockResolvedValue({status:200,headers:{},body:{success:true,result:{id:review}}});});
test.each(['inputs','list','request','lease','attest','verdict','uncertain','reconcile','cancel'])('native %s uses fixed canonical route and unchanged caller',async action=>{
  const payload={bounded:'fixture'};
  const result=await toolByName('relayhall_task_native_review')!.handler({task,reviewId:review,action,payload},context);
  const path=`/tasks/${task}/native-reviews`+(action==='inputs'?'/inputs':['list','request'].includes(action)?'':`/${review}/${action}`);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({path,authorization:context.authorization,method:['inputs','list'].includes(action)?'GET':'POST'}));
  expect(JSON.parse(result)).toEqual({success:true,result:{id:review}});
});
test('unknown act never becomes a model-selected route',async()=>{
  await expect(toolByName('relayhall_task_native_review')!.handler({task,action:'claim'},context)).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
});
test('registered durable pull retains caller and exact Service identity',async()=>{
  await toolByName('relayhall_service_review_requests')!.handler({serviceId:review},context);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({method:'GET',path:`/services/${review}/review-requests`,authorization:context.authorization}));
});
