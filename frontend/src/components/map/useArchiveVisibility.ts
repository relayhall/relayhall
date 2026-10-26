import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PlacedTile, PlacedReportPill } from './mapGraphModel';

// ArchiveMotionPlane caps CSS travel at 12 seconds. A short scheduling allowance
// avoids culling before the final paint. Only committed visible owners qualify.
export const ARCHIVE_VISIBILITY_MS = 12200;
type Lease = { destination: string; expires: number };
type Commit = { scope: string; visible: Set<string>; destinations: Map<string,string>; leases: Map<string,Lease> };
const mediaQuery = '(prefers-reduced-motion: reduce)';
const reducedNow = () => typeof window.matchMedia === 'function' && window.matchMedia(mediaQuery).matches;

export function useArchiveVisibility(tiles: readonly PlacedTile[], inViewport: ReadonlySet<string>,
  pills: readonly PlacedReportPill[], scales: Readonly<Record<string,number>> | undefined,
  scope: string, enabled: boolean): PlacedTile[] {
  const [reduced,setReduced]=useState(reducedNow);
  const [,refresh]=useState(0);
  const committed=useRef<Commit|null>(null);
  useEffect(()=>{
    if(typeof window.matchMedia!=='function')return;
    const media=window.matchMedia(mediaQuery),changed=()=>setReduced(media.matches);
    changed();media.addEventListener('change',changed);
    return()=>media.removeEventListener('change',changed);
  },[]);
  const previous=enabled&&!reduced&&committed.current?.scope===scope?committed.current:null;
  const now=performance.now(), leases=new Map<string,Lease>(),destinations=new Map<string,string>();
  const reports=new Map<string,Array<[string,number,number,number,number,number]>>();
  for(const pill of pills){const group=reports.get(pill.taskId)??[];
    group.push([pill.id,pill.x,pill.y,pill.w,pill.h,scales?.[pill.id]??1]);reports.set(pill.taskId,group);}
  for(const group of reports.values())group.sort((a,b)=>a[0].localeCompare(b[0]));
  const visible:PlacedTile[]=[];
  for(const tile of tiles){
    const destination=JSON.stringify([tile.x,tile.y,tile.w,tile.h,scales?.[tile.id]??1,reports.get(tile.id)??[]]);
    destinations.set(tile.id,destination);
    if(previous&&tile.node.status==='archived'){
      const old=previous.leases.get(tile.id);
      if(previous.visible.has(tile.id)&&previous.destinations.get(tile.id)!==destination){
        leases.set(tile.id,{destination,expires:Infinity});
      }else if(old?.destination===destination&&old.expires>now){leases.set(tile.id,old);}
    }
    if(inViewport.has(tile.id)||leases.has(tile.id))visible.push(tile);
  }
  // Commit ownership only after React actually renders this membership. Aborted
  // renders cannot admit IDs or renew a lease. No old task/report data is held.
  useLayoutEffect(()=>{
    const commitTime=performance.now();
    const committedLeases=new Map(Array.from(leases,([id,lease])=>[id,
      lease.expires===Infinity?{...lease,expires:commitTime+ARCHIVE_VISIBILITY_MS}:lease]));
    const commit:Commit={scope,visible:new Set(visible.map(t=>t.id)),destinations,leases:committedLeases};
    committed.current=enabled&&!reduced?commit:null;
    if(!committedLeases.size)return()=>{if(committed.current===commit)committed.current=null;};
    const expiry=Math.min(...Array.from(committedLeases.values(),l=>l.expires));
    const timer=window.setTimeout(()=>{
      if(committed.current===commit)refresh(n=>n+1);
    },Math.max(1,expiry-performance.now()+1));
    return()=>{window.clearTimeout(timer);if(committed.current===commit)committed.current=null;};
  });
  return visible;
}
