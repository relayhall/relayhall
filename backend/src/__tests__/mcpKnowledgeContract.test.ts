import { toolByName } from '../mcp/registry';
import * as rest from '../mcp/rest';
afterEach(()=>jest.restoreAllMocks());
test('MCP search forwards hard dimensions through canonical REST and renders partial coverage first',async()=>{
 const mock=jest.spyOn(rest,'board').mockResolvedValue({coverage:{consulted:['id'],answered:['id'],timedOut:[],unavailable:[],refusedBySource:[],refusedByPolicy:[],skipped:[],partialSources:[{id:'id',reasons:['deadline']}],truncatedResults:[],invalidResults:[]},groups:[],auditRef:'audit'});
 const tool=toolByName('relayhall_knowledge_source_search')!;
 expect(tool.plane).toBe('work');
 const result=await tool.handler({q:'test',categories:['relaybrain:note'],kinds:['docs']},{authorization:'Bearer fixture',toolName:tool.name});
 expect(mock).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({path:'/knowledge-queries',body:{protocol_version:2,q:'test',categories:['relaybrain:note'],kinds:['docs']}}));
 expect(result.indexOf('partialSources')).toBeLessThan(result.indexOf('# Results'));
});
// Card 40e0e542 (owner ruling E127 (5)): the agent's explicit opt-in is one body key on the
// canonical REST call, nothing else, and every rendered answer says what was searched.
test('MCP search forwards includeArchive as one REST body key and the answer states the scope searched',async()=>{
 const coverage=(included:boolean)=>({consulted:['id'],answered:['id'],timedOut:[],unavailable:[],refusedBySource:[],refusedByPolicy:[],skipped:[],truncatedResults:[],invalidResults:[],searchedCategories:[{id:'id',categories:included?'all':['relaybrain:note']}],archive:{included,declaredBy:['id']}});
 const tool=toolByName('relayhall_knowledge_source_search')!;
 const schema=tool.inputSchema as {properties:Record<string,{type?:string}>;additionalProperties:boolean};
 expect(schema.properties.includeArchive.type).toBe('boolean');expect(schema.additionalProperties).toBe(false);
 let mock=jest.spyOn(rest,'board').mockResolvedValue({coverage:coverage(true),groups:[],auditRef:'audit'});
 const included=await tool.handler({q:'test',includeArchive:true},{authorization:'Bearer fixture',toolName:tool.name});
 expect(mock).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({path:'/knowledge-queries',body:{protocol_version:2,q:'test',includeArchive:true}}));
 expect(included).toContain('Searched: current knowledge and the archive (includeArchive: true).');
 mock.mockRestore();
 mock=jest.spyOn(rest,'board').mockResolvedValue({coverage:coverage(false),groups:[],auditRef:'audit'});
 const byDefault=await tool.handler({q:'test'},{authorization:'Bearer fixture',toolName:tool.name});
 expect(mock).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({body:{protocol_version:2,q:'test'}}));
 expect(byDefault).toContain('Searched: current knowledge; archive excluded (pass includeArchive: true).');
 expect(byDefault.indexOf('Searched:')).toBeLessThan(byDefault.indexOf('# Results'));
});
test('MCP GET forwards sealed continuation without changing or disclosing raw references',async()=>{
 const mock=jest.spyOn(rest,'board').mockResolvedValue({content_base64:'AA==',status:'content'});
 const tool=toolByName('relayhall_knowledge_source_get')!;
 await tool.handler({handle:'sealed.key',continuation:'page.key'},{authorization:'Bearer fixture',toolName:tool.name});
 expect(mock).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({path:'/knowledge-contents',query:{handle:'sealed.key',continuation:'page.key'}}));
});

test('MCP refusal retains a valid audit reference without rendering arbitrary reference text',async()=>{
 const {errorFromRest}=await import('../mcp/shape');
 const auditRef='ka_'+'a'.repeat(32);
 expect(errorFromRest('relayhall_knowledge_source_search',422,{code:'SOURCE_SELECTION_TOO_BROAD',message:'Narrow the selection.',auditRef}).message).toContain('Audit reference: '+auditRef);
 expect(errorFromRest('relayhall_knowledge_source_search',422,{message:'Narrow the selection.',auditRef:'arbitrary-private-text'}).message).not.toContain('arbitrary-private-text');
});
