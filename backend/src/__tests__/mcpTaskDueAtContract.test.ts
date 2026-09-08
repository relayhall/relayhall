/** FEAT-A closure: the actual Task tools carry the server's complete decision.
 * This suite isolates the transport boundary with a canonical board envelope;
 * taskWriteFieldContract separately exercises the real router/PostgreSQL path.
 */
import { Validator } from '@cfworker/json-schema';
import { toolByName } from '../mcp/registry';
import * as rest from '../mcp/rest';
import { buildOpenApiSpec } from '../openapi/spec';

const TASK = '33333333-3333-4333-8333-333333333333';
const fixtures = [
  { zone:'Europe/Warsaw', local:'2026-09-07T19:00:00.123456', instant:'2026-09-07T17:00:00.123456Z', offset:'+02:00', offsetSeconds:7200, chosen:'postgresql' },
  { zone:'Europe/Warsaw', local:'2026-10-25T02:30:00.123456', instant:'2026-10-25T01:30:00.123456Z', offset:'+01:00', offsetSeconds:3600, chosen:'postgresql' },
  { zone:'Asia/Kolkata', local:'1900-01-01T12:00:00.123456', instant:'1900-01-01T06:38:50.123456Z', offset:'+05:21:10', offsetSeconds:19270, chosen:'postgresql' },
];
const properties = (name:string) => toolByName(name)!.inputSchema.properties as Record<string,any>;
afterEach(()=>jest.restoreAllMocks());

describe.each(['create','update'])('MCP Task %s deadline receipt',verb=>{
  const name='relayhall_task_'+verb;
  const args=verb==='create'?{title:'Deadline',idempotencyKey:'deadline-retry-token'}:{task:TASK};
  test.each(fixtures)('carries every canonical receipt value: $zone $local',async receipt=>{
    const envelope={task:{id:TASK,title:'Deadline',status:'todo',dueAt:receipt.instant},dueAtResolution:receipt,warning:'Existing warning'};
    const board=jest.spyOn(rest,'board').mockResolvedValue(envelope);
    const dueAt={local:receipt.local,zone:receipt.zone};
    const text=await toolByName(name)!.handler({...args,dueAt},{authorization:'Bearer fixture',toolName:name});
    expect(text).toContain(verb==='create'?'Created Task':'Updated Task');
    expect(text).toContain('\n\n'+JSON.stringify({dueAtResolution:receipt},null,2));
    expect(JSON.parse(text.slice(text.indexOf('\n\n')+2))).toEqual({dueAtResolution:receipt});
    expect(board).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({method:verb==='create'?'POST':'PATCH',body:expect.objectContaining({dueAt})}));
    if(verb==='update')expect(text).toContain('warning: Existing warning');
  });
  test.each(['2026-10-25T01:30:00.123456Z',null,undefined])('does not invent a resolution for ISO/null/omitted writes: %s',async dueAt=>{
    jest.spyOn(rest,'board').mockResolvedValue({task:{id:TASK,title:'Deadline',status:'todo',dueAt:dueAt??null}});
    const text=await toolByName(name)!.handler({...args,notes:'Existing notes',...(dueAt===undefined?{}:{dueAt})},{authorization:'Bearer fixture',toolName:name});
    expect(text).not.toContain('dueAtResolution');expect(text).not.toContain('postgresql');
  });
});

describe('one exact advertised Task deadline shape',()=>{
  const schema=properties('relayhall_task_create').dueAt;
  test('both tools use the same schema object',()=>expect(properties('relayhall_task_update').dueAt).toBe(schema));
  const validator=new Validator(schema);
  test.each(['2026-09-07T17:00:00Z',null,{local:'2026-09-07T19:00:00',zone:'Europe/Warsaw'}])('admits the supported structural alternatives: %j',value=>expect(validator.validate(value).valid).toBe(true));
  test.each([{},[],true,1,{local:'2026-09-07T19:00:00'},{zone:'Europe/Warsaw'},{local:1,zone:'Europe/Warsaw'},{local:'2026-09-07T19:00:00',zone:null},{local:'2026-09-07T19:00:00',zone:'Europe/Warsaw',instant:'invented'}])('refuses malformed structural input: %j',value=>expect(validator.validate(value).valid).toBe(false));
  test('OpenAPI describes the measured PostgreSQL policy without an earlier-fold promise',()=>{
    const spec=buildOpenApiSpec() as any;
    const wall=spec.components.schemas.TaskSharedWriteFields.properties.dueAt.oneOf.find((branch:any)=>branch.type==='object');
    expect(wall.description).toContain('PostgreSQL AT TIME ZONE using the post-transition offset');
    expect(wall.description).not.toMatch(/earlier|earliest/i);
    expect(spec.components.schemas.DueAtResolution.properties.chosen.enum).toEqual(['postgresql']);
  });
});
