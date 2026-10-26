import { authenticatedFetch } from './auth';
type Listener = (payload: unknown, error?: string) => void;
interface Feed { listeners:Set<Listener>; controller:AbortController|null; timer:number; busy:boolean; stopped:boolean; poll:()=>Promise<void> }
const feeds = new Map<string,Feed>();
export function trustedPluginMessage(event: MessageEvent, iframe: HTMLIFrameElement): boolean {
  return event.origin === window.location.origin && event.source === iframe.contentWindow;
}
export function attachPluginBridge(iframe: HTMLIFrameElement, name: string, apiBase: string): () => void {
  const key=apiBase+'|'+name;
  let feed=feeds.get(key);
  if(!feed){
    const created:Feed={listeners:new Set(),controller:null,timer:0,busy:false,stopped:false,poll:async()=>{}};
    created.poll=async()=>{
      if(created.stopped||created.busy)return;
      created.busy=true;created.controller=new AbortController();
      try{
        const response=await authenticatedFetch(apiBase+'/plugin-host/'+encodeURIComponent(name)+'/bridge',{signal:created.controller.signal});
        if(!response.ok)throw new Error('unavailable');
        const payload=await response.json();
        if(!created.stopped)created.listeners.forEach(listener=>listener(payload));
      }catch{
        if(!created.stopped)created.listeners.forEach(listener=>listener(null,'unavailable'));
      }finally{created.busy=false;}
    };
    created.timer=window.setInterval(()=>void created.poll(),15000);
    feeds.set(key,created);feed=created;
  }
  const post:Listener=(payload,error)=>iframe.contentWindow?.postMessage({type:'relayhall-plugin-data',version:1,plugin:name,payload,...(error?{error}:{})},window.location.origin);
  feed.listeners.add(post);
  const current=feed;
  const ready=(event:MessageEvent)=>{if(trustedPluginMessage(event,iframe)&&event.data?.type==='relayhall-plugin-ready'&&event.data.version===1)void current.poll();};
  const onLoad=()=>void current.poll();
  window.addEventListener('message',ready);iframe.addEventListener('load',onLoad);
  void current.poll();
  return ()=>{
    window.removeEventListener('message',ready);iframe.removeEventListener('load',onLoad);current.listeners.delete(post);
    if(!current.listeners.size){current.stopped=true;current.controller?.abort();window.clearInterval(current.timer);feeds.delete(key);}
  };
}
