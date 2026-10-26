import type { Box } from './mapGraphModel';

export interface ArchiveBlock extends Box { id: string; scale?: number }
export interface ArchiveCorePlacement {
  circle: Box;
  blocks: ArchiveBlock[];
  /** Only already-archived ink moves in this case; never live project homes. */
  drift: boolean;
  recovered: boolean;
}

const contains = (circle: Box, box: Box): boolean => {
  const r=circle.w/2,cx=circle.x+r,cy=circle.y+r;
  return [box.x,box.x+box.w].every(x=>[box.y,box.y+box.h].every(y=>(x-cx)**2+(y-cy)**2<=r*r+1e-6));
};
const clear = (circle: Box, obstacles: readonly Box[]): boolean => {
  const r=circle.w/2,cx=circle.x+r,cy=circle.y+r;
  return obstacles.every(b=>{
    const x=Math.max(b.x,Math.min(b.x+b.w,cx)),y=Math.max(b.y,Math.min(b.y+b.h,cy));
    return (cx-x)**2+(cy-y)**2>=(r+24)**2;
  });
};
function pack(blocks: readonly ArchiveBlock[]): {blocks:ArchiveBlock[];radius:number} {
  if(!blocks.length)return {blocks:[],radius:0};
  const w=Math.max(...blocks.map(b=>b.w))+24,h=Math.max(...blocks.map(b=>b.h))+24;
  const columns=Math.max(1,Math.ceil(Math.sqrt(blocks.length*h/w))),rows=Math.ceil(blocks.length/columns);
  const width=columns*w,height=rows*h;
  return {radius:Math.hypot(width,height)/2+24,blocks:blocks.map((b,i)=>
    ({...b,x:(i%columns)*w-width/2+12,y:Math.floor(i/columns)*h-height/2+12}))};
}

/** Finite circle construction, not an unbounded search or a viewport rule.
 * A tangent expansion contains the old circle and a disjoint new block grid.
 * If all eight directions are obstructed, archived groups compact within
 * their existing circle. The ratified small archived tiles evolve locally;
 * surviving live work and the camera are never relocated.
 */
export function placeArchiveCore(input: Box, retained: readonly ArchiveBlock[],
  pending: readonly ArchiveBlock[], obstacles: readonly Box[]): ArchiveCorePlacement {
  if(![input.x,input.y,input.w,input.h].every(Number.isFinite)||input.w<1024||input.h!==input.w)
    throw new RangeError('Invalid archive core geometry');
  let previous={...input};
  let recovered=false;
  if(!clear(previous,obstacles)) {
    const radius=previous.w/2,cx=previous.x+radius,cy=previous.y+radius;
    // Finite obstacle-edge candidates, not a global-nearest claim. The four
    // occupied-world frontiers guarantee a safe candidate for finite boxes.
    const pad=radius+24;
    const centres=obstacles.flatMap(b=>[[b.x-pad,cy],[b.x+b.w+pad,cy],[cx,b.y-pad],[cx,b.y+b.h+pad]]);
    centres.push([Math.min(...obstacles.map(b=>b.x))-pad,cy],
      [Math.max(...obstacles.map(b=>b.x+b.w))+pad,cy],
      [cx,Math.min(...obstacles.map(b=>b.y))-pad],
      [cx,Math.max(...obstacles.map(b=>b.y+b.h))+pad]);
    previous=centres.map(([x,y])=>({x:x-radius,y:y-radius,w:input.w,h:input.h}))
      .filter(c=>clear(c,obstacles)).sort((a,b)=>
        ((a.x-input.x)**2+(a.y-input.y)**2)-((b.x-input.x)**2+(b.y-input.y)**2))[0];
    recovered=true;
  }
  if(!recovered&&!pending.length&&retained.every(b=>contains(previous,b))&&clear(previous,obstacles))
    return {circle:{...previous},blocks:retained.map(b=>({...b})),drift:false,recovered:false};
  const group=pack(pending),oldR=previous.w/2,oldX=previous.x+oldR,oldY=previous.y+oldR;
  if(!recovered&&retained.every(b=>contains(previous,b))) {
    const radius=oldR+group.radius+32,shift=radius-oldR;
    const directions=[[-1,0],[0,-1],[1,0],[0,1],[-Math.SQRT1_2,-Math.SQRT1_2],[-Math.SQRT1_2,Math.SQRT1_2],[Math.SQRT1_2,-Math.SQRT1_2],[Math.SQRT1_2,Math.SQRT1_2]];
    for(const [dx,dy] of directions) {
      const circle={x:oldX+shift*dx-radius,y:oldY+shift*dy-radius,w:radius*2,h:radius*2};
      if(!clear(circle,obstacles))continue;
      const distance=oldR+group.radius+64;
      const blocks=group.blocks.map(b=>({...b,x:b.x+oldX+distance*dx,y:b.y+oldY+distance*dy}));
      if(blocks.every(b=>contains(circle,b)))return {circle,blocks:[...retained.map(b=>({...b})),...blocks],drift:false,recovered:false};
    }
  }
  // An enclosed but clear core cannot expand without moving live homes.
  // Compact only archived ink inside that same disk; model and renderer carry
  // the same explicit scale, while natural measurements remain unscaled.
  const natural=[...retained,...pending].map(b=>({...b,w:b.w/(b.scale??1),h:b.h/(b.scale??1)}));
  const all=pack(natural);
  // Persistence uses six decimal world precision. Quantize before deriving
  // painted dimensions, so the next load cannot introduce a second scale.
  const scale=Math.floor(Math.min(1,(oldR-24)/Math.max(1,all.radius))*1e6)/1e6;
  return {circle:{...previous},blocks:all.blocks.map(b=>({...b,
    x:oldX+b.x*scale,y:oldY+b.y*scale,w:b.w*scale,h:b.h*scale,scale})),drift:retained.length>0,recovered};
}
