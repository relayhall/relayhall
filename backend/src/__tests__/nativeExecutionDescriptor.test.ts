import {validateDescriptor} from '../utils/serviceDescriptor';
const capability={protocolVersion:1,sourceProduct:'claude-code'};
const descriptor={options:[],telemetry:{tier:'presence',products:['claude-code']},nativeExecution:capability};
test('implementation capability is distinct and requires declared telemetry product',()=>{
  expect(validateDescriptor(descriptor).nativeExecution).toEqual(capability);
  expect(validateDescriptor(descriptor).nativeReview).toBeUndefined();
  expect(validateDescriptor({...descriptor,nativeReview:capability}).nativeReview).toEqual(capability);
});
test.each([
  {...descriptor,nativeExecution:{...capability,protocolVersion:2}},
  {...descriptor,nativeExecution:{...capability,sourceProduct:'other'}},
  {...descriptor,nativeExecution:{...capability,canClaimAnything:true}},
  {...descriptor,telemetry:{tier:'none',products:['claude-code']}},
])('unsupported implementation advertisement is refused',value=>{
  expect(()=>validateDescriptor(value)).toThrow();
});
