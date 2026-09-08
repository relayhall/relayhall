import { blueprintReferenceRegistry } from '../services/BlueprintReferenceRegistry';
jest.mock('../services/AuthorizationRepository',()=>({authorizationRepository:{listScope:jest.fn(()=>({from:'services se',id:'se.id',render:()=>({sql:'visible',params:[]})}))}}));
jest.mock('../services/AuthorizationService',()=>({authorizationService:{authorizeRoute:()=>({allowed:false})}}));
const caller:any={actor:{principalId:'caller',scopes:[]}};
const installed:any={name:'example',version:'1.2.3',blueprintReferences:[{kind:'analysis',name:'inspect',service:'worker',tool:'inspect-work'}]};
afterEach(()=>blueprintReferenceRegistry.usePlugins(()=>[]));
test('installed plugin functions are enumerated and derived from the registry and visible Connector',async()=>{
 blueprintReferenceRegistry.usePlugins(()=>[installed]);
 expect(blueprintReferenceRegistry.kinds()).toContain('plugin:example:analysis');
 const descriptor={tools:[{name:'inspect-work'}],options:[]};
 const client:any={query:jest.fn().mockResolvedValueOnce({rows:[{id:'service-id'}]}).mockResolvedValueOnce({rows:[{name:'worker',minVersion:3,descriptor}]})};
 expect(await blueprintReferenceRegistry.capture('plugin:example:analysis','inspect',caller,client)).toEqual({
  kind:'plugin:example:analysis',name:'inspect',service:'worker',tool:'inspect-work',pluginVersion:'1.2.3',minVersion:3,descriptor});
 expect(client.query.mock.calls.every(([sql]:[string])=>sql.includes('visible'))).toBe(true);
});
test('an absent or unreadable plugin function refuses without trusting a Task label',async()=>{
 blueprintReferenceRegistry.usePlugins(()=>[installed]);
 const client:any={query:jest.fn(async()=>({rows:[]}))};
 await expect(blueprintReferenceRegistry.capture('plugin:example:analysis','not-registered',caller,client)).rejects.toMatchObject({code:'BLUEPRINT_CAPTURE_REFERENCE_UNAVAILABLE'});
 expect(client.query).not.toHaveBeenCalled();
 await expect(blueprintReferenceRegistry.capture('plugin:example:analysis','inspect',caller,client)).rejects.toMatchObject({code:'BLUEPRINT_CAPTURE_REFERENCE_UNAVAILABLE'});
 blueprintReferenceRegistry.usePlugins(()=>[]);
 expect(blueprintReferenceRegistry.kinds()).not.toContain('plugin:example:analysis');
});
