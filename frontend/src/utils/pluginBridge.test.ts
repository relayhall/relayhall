// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('./auth',()=>({authenticatedFetch:vi.fn(async()=>({ok:true,json:async()=>({schemaVersion:'rh.plugin.bridge/1'})}))}));
import {authenticatedFetch} from './auth';
import {attachPluginBridge,trustedPluginMessage} from './pluginBridge';
describe('plugin bridge lifecycle',()=>{
 afterEach(()=>{vi.clearAllMocks();document.body.innerHTML='';vi.useRealTimers();});
 it('validates origin and exact source window',()=>{
  const iframe=document.createElement('iframe');document.body.append(iframe);
  expect(trustedPluginMessage(new MessageEvent('message',{origin:'https://evil.invalid',source:iframe.contentWindow}),iframe)).toBe(false);
  expect(trustedPluginMessage(new MessageEvent('message',{origin:location.origin,source:window}),iframe)).toBe(false);
  expect(trustedPluginMessage(new MessageEvent('message',{origin:location.origin,source:iframe.contentWindow}),iframe)).toBe(true);
 });
 it('shares one poll between sidebar and full view, stops after last unsubscribe',async()=>{
  vi.useFakeTimers();
  const a=document.createElement('iframe'),b=document.createElement('iframe');document.body.append(a,b);
  const stopA=attachPluginBridge(a,'sample','/api'),stopB=attachPluginBridge(b,'sample','/api');
  await vi.advanceTimersByTimeAsync(1);expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  stopA();await vi.advanceTimersByTimeAsync(15000);expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  stopB();await vi.advanceTimersByTimeAsync(30000);expect(authenticatedFetch).toHaveBeenCalledTimes(2);
 });
});
