import express from 'express';
import type { AddressInfo } from 'net';
import pluginRoutes, { setPluginLoader } from '../routes/plugins';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PluginLoader } from '../services/PluginLoader';
import { principalService } from '../services/PrincipalService';
jest.mock('../services/PrincipalService',()=>({principalService:{getPrincipalById:jest.fn(async(id:string)=>({id,status:'active',kind:'human',parentPrincipalId:null}))}}));
import { pluginPublicBasePath } from '../services/PluginHostContract';
import { installPluginSettingsDouble } from './support/pluginSettingsDouble';
// Card bedf50cc: availability is ANDed into every plugin site; no row = default_on.
installPluginSettingsDouble();
describe('installation namespace and health destination safety', () => {
  let directory: string, loader: PluginLoader;
  const originalFetch = global.fetch;
  const manifest = (name: string, health = '/health'): any => ({
    schema_version: 'rh.plugin/1', name, version: '1.0.0', description: 'fixture',
    docker: { image: 'fixture:1', ports: {} },
    api: { base_path: pluginPublicBasePath(name), internal_port: 8080, health },
    relayhall: { api_version: 1, trust: 'installed', capabilities: [] },
  });
  function install(entries: any[]) {
    const plugins = entries.map(m => {
      const source = path.join(directory, m.name); fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(m));
      return { name: m.name, source, enabled: true };
    });
    const config = path.join(directory, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ plugins }));
    loader = new PluginLoader(config);
  }
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-install-test-'));
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 })) as any;
  });
  afterEach(() => { loader?.stop(); global.fetch = originalFetch; fs.rmSync(directory, {recursive:true, force:true}); });
  it('rejects distinct names compiling to one prefix before any registration or health request', async () => {
    install([manifest('claw-orb'), manifest('orb')]);
    await expect(loader.initialize()).rejects.toThrow('Duplicate plugin public namespace');
    expect(loader.getRegistry()).toEqual([]); expect(loader.getProxyRoutes()).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each(['@127.0.0.1:65535/health', '//elsewhere/health', '/\\\\evil', '/health?target=other', '/health#fragment', '/health/../private'])(
    'refuses unsafe health path %s without fetching', async health => {
      install([manifest('sample-plugin', health)]); await loader.initialize();
      expect(loader.getRegistry()).toEqual([]); expect(global.fetch).not.toHaveBeenCalled();
    });
  it.each(['exact','prefix'])('refuses trailing-slash allow paths before registration or health (%s)', async match => {
    const m=manifest('sample-plugin');m.api.allow=[{path:'/',methods:['GET'],capability:'view'},
      {path:'/private/',methods:['GET'],match,capability:'manage'}];
    install([m]);await loader.initialize();
    expect(loader.getRegistry()).toEqual([]);expect(loader.getProxyRoutes()).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each(['99.0.0','not-a-version'])('a min_version refusal registers nothing and makes no health request (%s)',async minimum=>{
    const m=manifest('sample-plugin');m.relayhall.min_version=minimum;install([m]);await loader.initialize();
    expect(loader.getRegistry()).toEqual([]);expect(loader.getProxyRoutes()).toEqual([]);expect(global.fetch).not.toHaveBeenCalled();
  });
  // Card bedf50cc slice 2: the refusal reaches the operator log as a fixed reason code.
  it.each([
    ['99.0.0', 'PLUGIN_MIN_VERSION_UNSATISFIED'],
    ['not-a-version', 'PLUGIN_MIN_VERSION_MALFORMED'],
    ['/private/', 'PLUGIN_ALLOW_PATH_NOT_CANONICAL'],
  ])('logs a fixed refusal reason for %s and never the refusal text or manifest value', async (value, reason) => {
    const m = manifest('sample-plugin');
    if (value.startsWith('/')) m.api.allow = [{ path: '/', methods: ['GET'], capability: 'view' }, { path: value, methods: ['GET'], capability: 'manage' }];
    else m.relayhall.min_version = value;
    install([m]);
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await loader.initialize();
      const lines = logged.mock.calls.map(call => call.map(String).join(' '));
      const failure = lines.filter(line => line.startsWith('[PluginLoader] plugin load failed'));
      expect(failure).toHaveLength(1);
      expect(failure[0].startsWith('[PluginLoader] plugin load failed reason=' + reason + ' (Error) [class=PluginContractError code=ERROR_UNCLASSIFIED id=')).toBe(true);
      expect(failure[0]).toMatch(/ id=[0-9a-f-]{36}\]$/);
      for (const line of lines) {
        expect(line).not.toContain(value);
        expect(line).not.toMatch(/newer host version|minimum host version|must be canonical|trailing slash/i);
      }
      expect(loader.getPlugin('sample-plugin')?.error).toMatch(/^Plugin load failed \(errorId [0-9a-f-]{36}\)$/);
    } finally { logged.mockRestore(); }
  });
  it('logs the unclassified reason for a load failure that is not a contract refusal', async () => {
    install([manifest('sample-plugin')]);
    fs.writeFileSync(path.join(directory, 'sample-plugin', 'plugin.json'), '{"name": "sample-plugin", private-unparsed-text');
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await loader.initialize();
      const lines = logged.mock.calls.map(call => call.map(String).join(' '));
      expect(lines.filter(line => line.startsWith('[PluginLoader] plugin load failed reason=PLUGIN_LOAD_UNCLASSIFIED (Error) [class=SyntaxError'))).toHaveLength(1);
      for (const line of lines) expect(line).not.toContain('private-unparsed-text');
    } finally { logged.mockRestore(); }
  });
  it('pins the health origin and never follows a redirect (a 3xx is handed back and named)', async () => {
    install([manifest('sample-plugin')]); await loader.initialize();
    expect(global.fetch).toHaveBeenCalledWith('http://sample-plugin:8080/health', expect.objectContaining({redirect:'manual'}));
    expect(loader.getRegistry()[0].api_base).toBe('/plugins/sample-plugin');
  });
  // Owner ruling E438(1): the registry carries the opt-in to the dashboard with
  // the widget's other UI metadata, and only when the manifest says exactly true.
  it.each([['true', true, {path:'/widget',height:240,grow:true}], ['false', false, {path:'/widget',height:240}],
    ['absent', undefined, {path:'/widget',height:240}]])(
    'exposes the sidebar widget grow opt-in to the dashboard only when it is true (%s)', async (_label, grow, expected) => {
      const m = manifest('sample-plugin');
      m.ui = { enabled: true, sidebar_widget: { path: '/widget', height: 240, ...(grow === undefined ? {} : { grow }) } };
      install([m]); await loader.initialize();
      expect(loader.getRegistry()[0].sidebar_widget).toEqual(expected);
    });
  // Owner ruling E458: the registry carries the `frame` opt-in to the dashboard
  // only when the manifest says exactly `section`.
  it.each([['section', 'section', {path:'/widget',height:240,frame:'section'}], ['absent', undefined, {path:'/widget',height:240}]])(
    'exposes the sidebar widget frame opt-in to the dashboard only when it is section (%s)', async (_label, frame, expected) => {
      const m = manifest('sample-plugin');
      m.ui = { enabled: true, sidebar_widget: { path: '/widget', height: 240, ...(frame === undefined ? {} : { frame }) } };
      install([m]); await loader.initialize();
      expect(loader.getRegistry()[0].sidebar_widget).toEqual(expected);
    });
  it('normalizes only the leading compatibility prefix', () => {
    expect(pluginPublicBasePath('my-claw-orb')).toBe('/plugins/my-claw-orb');
    expect(() => pluginPublicBasePath('claw-')).toThrow('Empty plugin public namespace');
  });
});

describe('settings registry Account capability filtering', () => {
  async function registry(app: express.Express) {
    const server=app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
    try { return await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/plugins`,{headers:{Connection:'close'}})).json() as any; }
    finally { await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
  }

  async function registryWithStatus(app: express.Express) {
    const server=app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
    try {
      const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/plugins`,{headers:{Connection:'close'}});
      return {status:response.status,body:await response.json() as any};
    } finally { await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
  }

  const personal={id:'personal-options',label:'Reading',scope:'personal',path:'/settings',capability:'view'};
  const shared={id:'shared-options',label:'Shared options',scope:'deployment',path:'/admin',capability:'manage'};
  const config:any={access:{accounts:{reader:['view'],operator:['view','manage']}}};
  const entry:any={name:'sample-plugin',api_base:'/plugins/sample-plugin',settings:[personal,shared]};
  const defaultRules:any[]=[
    {path:'/',methods:['GET','HEAD'],match:'prefix',capability:'view'},
    {path:'/admin',methods:['GET'],match:'exact',capability:'manage'},
  ];
  const appFor=(id:string, options:{scopes?:string[];rules?:any[];listed?:any;installation?:any;actor?:string;links?:any[];manifest?:any;routes?:any[]}={})=>{
    const listed=options.listed ?? entry;
    const installation=options.installation ?? config;
    setPluginLoader({
      getRegistry:()=>[listed],
      getPlugin:()=>({manifest:options.manifest ?? {schema_version:'rh.plugin/1'},config:installation}),
      getProxyRoutes:()=>options.routes ?? [{pluginName:'sample-plugin',pathPrefix:'/plugins/sample-plugin',target:'http://sample-plugin:8080',allow:options.rules ?? defaultRules}],
    } as any);
    const app=express();
    app.use((req:any,_res,next)=>{req.principal={id:options.actor ?? id,status:'active'};req.delegationLinks=options.links;req.scopes=options.scopes ?? ['services:read'];next();});
    app.use('/plugins',pluginRoutes);
    return app;
  };
  it('conceals shared settings from view-only Accounts and exposes existing manage grants',async()=>{
    expect((await registry(appFor('reader'))).plugins[0].settings).toEqual([{...personal,readOnly:true}]);
    expect((await registry(appFor('operator'))).plugins[0].settings).toEqual([{...personal,readOnly:true},{...shared,readOnly:true}]);
  });
  it('does not disclose plugin settings to an ungranted Account',async()=>{
    expect((await registry(appFor('other'))).plugins).toEqual([]);
  });
  it('rechecks current grants on the next registry request without mutating stored metadata',async()=>{
    const app=appFor('operator');
    expect((await registry(app)).plugins[0].settings).toHaveLength(2);
    config.access.accounts.operator=['view'];
    expect((await registry(app)).plugins[0].settings).toEqual([{...personal,readOnly:true}]);
    expect(entry.settings).toHaveLength(2);config.access.accounts.operator=['view','manage'];
  });
  it('classifies a view GET and manage POST on the same path from the write rule',async()=>{
    const rules=[...defaultRules,{path:'/settings',methods:['POST'],match:'exact',capability:'manage'}];
    const result=(await registry(appFor('operator',{scopes:['services:read','services:write'],rules}))).plugins[0];
    expect(result.settings[0]).toEqual({...personal,readOnly:false});
    expect(result.hostProxyAccess).toEqual({writeCapable:true});
    expect((await registry(appFor('reader',{scopes:['services:read','services:write'],rules}))).plugins[0].hostProxyAccess).toEqual({writeCapable:false});
  });
  it('classifies a GET-only non-view capability as read-only',async()=>{
    const read={...personal,capability:'read'};
    const listed={...entry,settings:[read]};
    const installation={access:{accounts:{reader:['view','read']}}};
    const rules=[{path:'/',methods:['GET','HEAD'],match:'prefix',capability:'read'}];
    expect((await registry(appFor('reader',{scopes:['services:read','services:write'],rules,listed,installation}))).plugins[0].hostProxyAccess).toEqual({writeCapable:false});
  });
  it('finds a granted write endpoint separate from the settings entry',async()=>{
    const installation={access:{accounts:{reader:['view','generate']}}};
    const rules=[...defaultRules,{path:'/generate',methods:['POST'],match:'exact',capability:'generate'}];
    expect((await registry(appFor('reader',{scopes:['services:read','services:write'],rules,installation}))).plugins[0].hostProxyAccess).toEqual({writeCapable:true});
  });
  it('needs both a write scope and the current Account grant, including for root',async()=>{
    const rules=[...defaultRules,{path:'/admin',methods:['POST'],match:'exact',capability:'manage'}];
    expect((await registry(appFor('operator',{scopes:['services:read'],rules}))).plugins[0].hostProxyAccess).toEqual({writeCapable:false});
    expect((await registry(appFor('reader',{scopes:['root'],rules}))).plugins[0].hostProxyAccess).toEqual({writeCapable:false});
    expect((await registry(appFor('operator',{scopes:['root'],rules}))).plugins[0].hostProxyAccess).toEqual({writeCapable:true});
  });
  it('changes on the next registry request without sharing metadata across Accounts',async()=>{
    const rules=[...defaultRules,{path:'/admin',methods:['POST'],match:'exact',capability:'manage'}];
    const app=appFor('operator',{scopes:['services:read','services:write'],rules});
    expect((await registry(app)).plugins[0].hostProxyAccess).toEqual({writeCapable:true});
    config.access.accounts.operator=['view'];
    try {
      expect((await registry(app)).plugins[0].hostProxyAccess).toEqual({writeCapable:false});
      expect((await registry(appFor('reader',{scopes:['services:read','services:write'],rules}))).plugins[0].hostProxyAccess).toEqual({writeCapable:false});
      expect(entry).not.toHaveProperty('hostProxyAccess');
    } finally { config.access.accounts.operator=['view','manage']; }
  });
  it('ignores a manifest or registry flag that claims write access',async()=>{
    const listed={...entry,hostProxyAccess:{writeCapable:true}};
    const result=(await registry(appFor('reader',{scopes:['services:read'],listed}))).plugins[0];
    expect(result.hostProxyAccess).toEqual({writeCapable:false});
  });
  it('uses the active delegation Account and conceals inactive or delegated owners',async()=>{
    const rules=[...defaultRules,{path:'/admin',methods:['POST'],match:'exact',capability:'manage'}];
    const app=appFor('actor',{actor:'actor',links:[{principalId:'actor'},{principalId:'operator'}],scopes:['root'],rules});
    expect((await registry(app)).plugins[0].hostProxyAccess).toEqual({writeCapable:true});
    (principalService.getPrincipalById as jest.Mock).mockResolvedValueOnce({id:'operator',status:'disabled',kind:'human',parentPrincipalId:null});
    expect((await registry(app)).plugins).toEqual([]);
    (principalService.getPrincipalById as jest.Mock).mockResolvedValueOnce({id:'operator',status:'active',kind:'service',parentPrincipalId:'parent'});
    expect((await registry(app)).plugins).toEqual([]);
    (principalService.getPrincipalById as jest.Mock).mockResolvedValueOnce(null);
    expect((await registry(app)).plugins).toEqual([]);
  });
  it('returns a fixed unavailable envelope if active Account lookup throws',async()=>{
    (principalService.getPrincipalById as jest.Mock).mockRejectedValueOnce(new Error('private storage fault'));
    const app=appFor('operator');
    const result=await registryWithStatus(app);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({code:'PLUGIN_UNAVAILABLE'});
    expect(JSON.stringify(result.body)).not.toContain('private storage fault');
  });
  it('leaves unavailable metadata unknown and preserves legacy registry behavior',async()=>{
    const absent=(await registry(appFor('operator',{routes:[]}))).plugins[0];
    expect(absent).not.toHaveProperty('hostProxyAccess');
    const legacy=(await registry(appFor('other',{manifest:{},listed:{...entry,hostProxyAccess:{writeCapable:true}}}))).plugins[0];
    expect(legacy).not.toHaveProperty('hostProxyAccess');
    expect(legacy.settings).toEqual([]);
  });
  it('conceals a plugin when its view grant is revoked',async()=>{
    const app=appFor('reader');
    expect((await registry(app)).plugins).toHaveLength(1);
    config.access.accounts.reader=[];
    try { expect((await registry(app)).plugins).toEqual([]); }
    finally { config.access.accounts.reader=['view']; }
  });
  // Card bedf50cc slice 2: each settings entry says whether this Account can change it.
  it('states per settings entry whether this Account can change it (view entry, POST under another capability)',async()=>{
    const rules=[...defaultRules,{path:'/settings',methods:['POST'],match:'exact',capability:'manage'}];
    const write=['services:read','services:write'];
    expect((await registry(appFor('operator',{scopes:write,rules}))).plugins[0].settings)
      .toEqual([{...personal,readOnly:false},{...shared,readOnly:true}]);
    expect((await registry(appFor('reader',{scopes:write,rules}))).plugins[0].settings).toEqual([{...personal,readOnly:true}]);
    expect((await registry(appFor('operator',{scopes:['services:read'],rules}))).plugins[0].settings)
      .toEqual([{...personal,readOnly:true},{...shared,readOnly:true}]);
    expect(entry.settings).toEqual([personal,shared]);
  });
  it('states a GET-only entry under a non-view capability read-only while the plugin is write-capable elsewhere',async()=>{
    const history={id:'history',label:'History',scope:'personal',path:'/history',capability:'audit'};
    const listed={...entry,settings:[history]};
    const installation={access:{accounts:{reader:['view','audit','generate']}}};
    const rules=[...defaultRules,{path:'/history',methods:['GET'],match:'exact',capability:'audit'},
      {path:'/generate',methods:['POST'],match:'exact',capability:'generate'}];
    const result=(await registry(appFor('reader',{scopes:['root'],rules,listed,installation}))).plugins[0];
    expect(result.hostProxyAccess).toEqual({writeCapable:true});
    expect(result.settings).toEqual([{...history,readOnly:true}]);
  });
  it('computes the flag itself and ignores a manifest entry that claims to be writable',async()=>{
    const listed={...entry,settings:[{...personal,readOnly:false},{...shared,readOnly:false}]};
    const result=(await registry(appFor('operator',{scopes:['services:read','services:write'],listed}))).plugins[0];
    expect(result.settings).toEqual([{...personal,readOnly:true},{...shared,readOnly:true}]);
  });
  it('states every entry read-only when the plugin has no compiled base proxy route',async()=>{
    const rules=[...defaultRules,{path:'/settings',methods:['POST'],match:'exact',capability:'manage'}];
    const routes=[{pluginName:'sample-plugin',pathPrefix:'/plugins/sample-plugin/ui',target:'http://sample-plugin:8080/ui',allow:rules}];
    const result=(await registry(appFor('operator',{scopes:['root'],routes}))).plugins[0];
    expect(result.settings).toEqual([{...personal,readOnly:true},{...shared,readOnly:true}]);
  });
});
