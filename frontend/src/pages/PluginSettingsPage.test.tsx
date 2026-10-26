// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PluginSettingsPage } from './PluginSettingsPage';
const state=vi.hoisted(()=>({plugins:[] as any[],loading:false,error:null as Error|null,refresh:vi.fn()}));
vi.mock('../contexts/PluginContext',()=>({usePlugins:()=>state}));
// Card bedf50cc: the two host panels fetch on their own; their suites measure them.
vi.mock('../components/plugins/MyPluginsPanel',()=>({MyPluginsPanel:()=><section aria-label="My plugins" />}));
vi.mock('../components/plugins/PluginAdministrationPanel',()=>({PluginAdministrationPanel:()=><section aria-label="Plugin administration" />}));
vi.mock('../components/PluginFrame',()=>({PluginFrame:({pluginName,proxyPath}:any)=><div data-testid="settings-frame">{pluginName}:{proxyPath}</div>}));
beforeEach(()=>{state.plugins=[];state.loading=false;state.error=null;});afterEach(cleanup);
const show=(url='/settings/plugins')=>render(<MemoryRouter initialEntries={[url]}><PluginSettingsPage /></MemoryRouter>);
const plugin=(settings:any[],hostProxyAccess?:{writeCapable:boolean})=>({name:'sample',schema_version:'rh.plugin/1',healthy:true,settings,...(hostProxyAccess?{hostProxyAccess}:{})});
const readonly='You can view this plugin; changes through its RelayHall connection are not permitted.';
const writable='Your account has permission to make changes through this plugin’s RelayHall connection.';
test('states honestly that unregistered settings are unavailable',()=>{show();expect(screen.getByText(/No plugin settings are available/)).toBeInTheDocument();});
test('groups personal and shared pages and selects only a registered destination',()=>{
 state.plugins=[plugin([{id:'mine',label:'Reading',scope:'personal',path:'/reading',capability:'view'},{id:'shared',label:'Source configuration',scope:'deployment',path:'/admin',capability:'manage'}],{writeCapable:true})];show();
 expect(screen.getByRole('region',{name:'Personal plugin settings'})).toBeInTheDocument();
 expect(screen.getByRole('region',{name:'Deployment plugin settings'})).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:/Source configuration/}));
 expect(screen.getByTestId('settings-frame')).toHaveTextContent('sample:/admin');
 expect(screen.getByRole('region',{name:'Source configuration'})).toHaveTextContent('Registered as a deployment setting.');
 expect(screen.getByText(writable)).toBeInTheDocument();
});
test('a write-capable personal plugin states host-proxy permission separately from scope',()=>{
 state.plugins=[plugin([{id:'prefs',label:'Reading preferences',scope:'personal',path:'/prefs',capability:'manage'}],{writeCapable:true})];show('/settings/plugins?plugin=sample&setting=prefs');
 const detail=screen.getByRole('region',{name:'Reading preferences'});
 expect(detail).toHaveTextContent('Registered as a personal setting.');
 expect(detail).toHaveTextContent(writable);
});
test('a view entry can have separate write access elsewhere in the plugin',()=>{
 state.plugins=[plugin([{id:'reading-status',label:'Reading status',scope:'personal',path:'/ui/settings',capability:'view'}],{writeCapable:true})];show('/settings/plugins?plugin=sample&setting=reading-status');
 expect(screen.getByRole('region',{name:'Reading status'})).toHaveTextContent(writable);
});
test('a non-view capability can still be read-only',()=>{
 state.plugins=[plugin([{id:'history',label:'Reading history',scope:'personal',path:'/history',capability:'view-audit'}],{writeCapable:false})];show('/settings/plugins?plugin=sample&setting=history');
 const detail=screen.getByRole('region',{name:'Reading history'});
 expect(detail).toHaveTextContent(readonly);
 expect(detail).not.toHaveTextContent(writable);
});
test('a deployment entry can be read-only through the RelayHall connection',()=>{
 state.plugins=[plugin([{id:'shared',label:'Source configuration',scope:'deployment',path:'/admin',capability:'manage'}],{writeCapable:false})];show('/settings/plugins?plugin=sample&setting=shared');
 const detail=screen.getByRole('region',{name:'Source configuration'});
 expect(detail).toHaveTextContent('Registered as a deployment setting.');
 expect(detail).toHaveTextContent(readonly);
});
test('an older registry response without access metadata stays neutral',()=>{
 state.plugins=[plugin([{id:'mine',label:'Reading',scope:'personal',path:'/reading',capability:'manage'}])];show('/settings/plugins?plugin=sample&setting=mine');
 const detail=screen.getByRole('region',{name:'Reading'});
 expect(detail).toHaveTextContent('Access through this plugin’s RelayHall connection is checked on each request.');
 expect(detail).not.toHaveTextContent(readonly);
 expect(detail).not.toHaveTextContent(writable);
});
// Card bedf50cc slice 2: the server states per entry whether this Account can change it.
const cannotChange='Read-only for your account: you can view this page, but your account cannot change these settings.';
const canChange='Your account can change these settings.';
test('states a read-only entry plainly, even when the plugin is write-capable elsewhere',()=>{
 state.plugins=[plugin([{id:'history',label:'Reading history',scope:'personal',path:'/history',capability:'audit',readOnly:true}],{writeCapable:true})];show('/settings/plugins?plugin=sample&setting=history');
 const detail=screen.getByRole('region',{name:'Reading history'});
 expect(detail).toHaveTextContent(cannotChange);
 expect(detail).not.toHaveTextContent(writable);
 expect(detail).not.toHaveTextContent(canChange);
 expect(screen.getByRole('button',{name:/Reading history/})).toHaveTextContent('Read-only for you');
});
test('states a writable entry plainly',()=>{
 state.plugins=[plugin([{id:'prefs',label:'Reading preferences',scope:'personal',path:'/prefs',capability:'view',readOnly:false}],{writeCapable:true})];show('/settings/plugins?plugin=sample&setting=prefs');
 const detail=screen.getByRole('region',{name:'Reading preferences'});
 expect(detail).toHaveTextContent(canChange);
 expect(detail).not.toHaveTextContent(cannotChange);
 expect(screen.getByRole('button',{name:/Reading preferences/})).toHaveTextContent('You can change this');
});
test('states each entry of one plugin separately in the list',()=>{
 state.plugins=[plugin([{id:'prefs',label:'Reading preferences',scope:'personal',path:'/prefs',capability:'view',readOnly:false},
  {id:'shared',label:'Source configuration',scope:'deployment',path:'/admin',capability:'manage',readOnly:true}],{writeCapable:true})];show();
 expect(screen.getByRole('button',{name:/Reading preferences/})).toHaveTextContent('You can change this');
 expect(screen.getByRole('button',{name:/Reading preferences/})).not.toHaveTextContent('Read-only for you');
 expect(screen.getByRole('button',{name:/Source configuration/})).toHaveTextContent('Read-only for you');
 expect(screen.getByRole('button',{name:/Source configuration/})).not.toHaveTextContent('You can change this');
 fireEvent.click(screen.getByRole('button',{name:/Source configuration/}));
 expect(screen.getByRole('region',{name:'Source configuration'})).toHaveTextContent(cannotChange);
});
test('an entry without the flag keeps the neutral plugin-level statement and no per-entry claim',()=>{
 state.plugins=[plugin([{id:'mine',label:'Reading',scope:'personal',path:'/reading',capability:'view'}],{writeCapable:true})];show('/settings/plugins?plugin=sample&setting=mine');
 const detail=screen.getByRole('region',{name:'Reading'});
 expect(detail).toHaveTextContent(writable);
 expect(detail).not.toHaveTextContent(cannotChange);
 expect(detail).not.toHaveTextContent(canChange);
 expect(screen.getByRole('button',{name:/Reading/})).not.toHaveTextContent(/Read-only for you|You can change this/);
});
test('a forged or revoked settings deep link never mounts an iframe',()=>{state.plugins=[plugin([])];show('/settings/plugins?plugin=sample&setting=shared');expect(screen.queryByTestId('settings-frame')).not.toBeInTheDocument();expect(screen.getByRole('status')).toHaveTextContent('not available');});
test('failed registry does not expose stale settings',()=>{state.plugins=[plugin([{id:'mine',label:'Reading',scope:'personal',path:'/reading'}])];state.error=new Error('offline');show();expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');expect(screen.queryByRole('button',{name:/Reading/})).not.toBeInTheDocument();});
// Card bedf50cc (E380): the page carries the host panels beside the plugins' own pages.
test('renders My plugins and the plugin administration panel beside the registered pages',()=>{
 show();
 expect(screen.getByRole('region',{name:'My plugins'})).toBeInTheDocument();
 expect(screen.getByRole('region',{name:'Plugin administration'})).toBeInTheDocument();
});
