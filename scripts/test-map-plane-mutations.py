#!/usr/bin/env python3
"""MAP-A7c controls: prove each remaining clause-6 control red separately,
then prove every repaired painted family rejects missing and constant chain dim.
Run serially; no other writer may use this checkout during the drill.
Original bytes (including pre-existing edits) are always restored.
"""
from pathlib import Path
import subprocess,re,json,hashlib
root=Path(__file__).resolve().parents[1]
s=root/'tmp/map-plane-mutation-drill';s.mkdir(parents=True,exist_ok=True)
model=root/'frontend/src/components/map/mapPlaneModel.ts'
view=root/'frontend/src/components/map/MapView.tsx'
originals={p:p.read_bytes() for p in [model,view]}
fingerprints={str(p.relative_to(root)):hashlib.sha256(b).hexdigest() for p,b in originals.items()}
cases=[]
try:
 with (s/'baseline.log').open('w') as out:
  subprocess.run(['node_modules/.bin/vitest','run','src/components/map/mapPlaneModel.test.ts','src/components/map/MapView.render.test.tsx','--no-file-parallelism'],cwd=root/'frontend',stdout=out,stderr=subprocess.STDOUT,check=True)
 for control,pattern in [('first-measure','\\(a\\) a tile measured'),('filter','\\(b\\) FILTER'),('reload','\\(c\\) RELOAD'),('session','\\(d\\) NEW SESSION'),('creation','\\(e\\) LIVE CREATION'),('size-map','\\(f\\) THE CLASS')]:
  text=originals[model].decode()
  old='wantCol.get(slot.col) ?? 0, cellWidth(pills)'
  assert text.count(old)==1
  text=text.replace(old,'wantCol.get(slot.col) ?? 0, cellWidth(pills) + Math.max(0, (sizes[node.id]?.w ?? 170) - 170)')
  text=text.replace('wantRow.get(slot.row) ?? 0, cellHeight(pills)', 'wantRow.get(slot.row) ?? 0, cellHeight(pills) + Math.max(0, (sizes[node.id]?.h ?? 128) - 128)')
  model.write_text(text)
  log=s/(control+'.log')
  with log.open('w') as out:
   result=subprocess.run(['node_modules/.bin/vitest','run','src/components/map/mapPlaneModel.test.ts','--no-file-parallelism','-t',pattern],cwd=root/'frontend',stdout=out,stderr=subprocess.STDOUT)
  output=log.read_text()
  assert result.returncode!=0 and 'AssertionError' in output and re.search(r'Tests\s+1 failed',output),control
  cases.append({'control':control,'red':True})
  model.write_bytes(originals[model])
 for name,replacement in [('dim-withdrawn','=> 1;'),('dim-override','=> (chain ? (isLit ? 1 : dim / 0.5) : 1);')]:
  text=originals[view].decode()
  old=') => (chain ? (isLit ? 1 : dim) : 1);'
  assert text.count(old)==1
  if name=='dim-withdrawn': text=text.replace(old,') '+replacement)
  else:
   # Reproduce constant-opacity override at the two container sinks.
   oldexpr='entry.alpha * chainScale(\n                  planeChain, planeChain?.has(entry.id) ?? false, CHAIN_DIM.node)'
   assert text.count(oldexpr)==2
   text=text.replace(oldexpr,'(planeChain && !planeChain.has(entry.id) ? CHAIN_DIM.node : entry.alpha)')
  view.write_text(text)
  with (s/(name+'.log')).open('w') as out:
   result=subprocess.run(['node_modules/.bin/vitest','run','src/components/map/MapView.render.test.tsx','--no-file-parallelism','-t','multiplies every container'],cwd=root/'frontend',stdout=out,stderr=subprocess.STDOUT)
  output=(s/(name+'.log')).read_text()
  assert result.returncode!=0 and 'AssertionError' in output and re.search(r'Tests\s+2 failed',output),name
  cases.append({'control':name,'red':True})
  view.write_bytes(originals[view])
 extra=[
  ('reading-task-opacity',view,') => (chain ? (isLit ? 1 : dim) : 1);',') => 1;','MapView.render.test.tsx','dim COMPOSES with the cross-fade'),
  ('phase-membership',model,'aggregateChain?.has(phase) || aggregateChain?.has(project)','false || aggregateChain?.has(project)','mapPlaneModel.test.ts','a phase selection lights'),
  ('project-membership',model,'aggregateChain?.has(phase) || aggregateChain?.has(project)','aggregateChain?.has(phase) || false','mapPlaneModel.test.ts','a project selection lights'),
  ('selection-priority',model,'new Set(taskChain ? [] : aggregateChain ?? [])','new Set(aggregateChain ?? [])','mapPlaneModel.test.ts','a task selection keeps priority'),
  ('clear-attention',model,'return { tasks: null, containers: null }','return { tasks: new Set<string>(), containers: new Set<string>() }','mapPlaneModel.test.ts','clearing selection clears'),
  ('shape-opacity',view,'opacity: alpha * chainScale(paintedTaskChain, paintedTaskChain?.has(tile.id) ?? false, CHAIN_DIM.node),','opacity: alpha,','MapView.render.test.tsx','selecting a phase dims unrelated task shapes'),
  ('band-attention',view,'* furnitureScale(phaseKeyOfBand(bandEl))','* 1','MapView.render.test.tsx',"'band' composes membership and its actual fade at 1$"),
  ('chip-attention',view,"chipAlpha * furnitureScale(own ? phaseKeyOfBand(own) : '')",'chipAlpha','MapView.render.test.tsx',"'chip' composes membership and its actual fade at 0.28$"),
  ('header-attention',view,'headerAlpha * furnitureScale(`project:${laneKey}`)','headerAlpha','MapView.render.test.tsx',"'header' composes membership and its actual fade at 0.2$"),
  ('band-fade-override',view,'(1 - projectAlpha(bandEl.laneId))\n                    * furnitureScale(phaseKeyOfBand(bandEl))','(furnitureScale(phaseKeyOfBand(bandEl)) < 1 ? CHAIN_DIM.node : 1 - projectAlpha(bandEl.laneId))','MapView.render.test.tsx',"'band' composes membership and its actual fade at 0.2$"),
  ('chip-fade-override',view,"chipAlpha * furnitureScale(own ? phaseKeyOfBand(own) : '')","(furnitureScale(own ? phaseKeyOfBand(own) : '') < 1 ? CHAIN_DIM.node : chipAlpha)",'MapView.render.test.tsx',"'chip' composes membership and its actual fade at 0.28$"),
  ('header-fade-override',view,'headerAlpha * furnitureScale(`project:${laneKey}`)','(furnitureScale(`project:${laneKey}`) < 1 ? CHAIN_DIM.node : headerAlpha)','MapView.render.test.tsx',"'header' composes membership and its actual fade at 0.2$"),
  ('sibling-phase-membership',view,'`phase:${band.laneId}\\u0000${band.id.slice(`band:${band.laneId}:`.length)}`','`project:${band.laneId}`','MapView.render.test.tsx',"'band' composes membership and its actual fade at 1$"),
 ]
 for name,path,old,new,test,pattern in extra:
  text=originals[path].decode();assert text.count(old)==1,(name,text.count(old))
  path.write_text(text.replace(old,new))
  with (s/(name+'.log')).open('w') as out:
   result=subprocess.run(['node_modules/.bin/vitest','run','src/components/map/'+test,'--no-file-parallelism','-t',pattern],cwd=root/'frontend',stdout=out,stderr=subprocess.STDOUT)
  output=(s/(name+'.log')).read_text()
  assert result.returncode!=0 and 'AssertionError' in output and re.search(r'Tests\s+1 failed',output),name
  cases.append({'control':name,'red':True})
  path.write_bytes(originals[path])

finally:
 for p,b in originals.items(): p.write_bytes(b)
assert all(p.read_bytes()==b for p,b in originals.items()),'Source restoration mismatch'
with (s/'restored.log').open('w') as out:
 subprocess.run(['node_modules/.bin/vitest','run','src/components/map/mapPlaneModel.test.ts','src/components/map/MapView.render.test.tsx','--no-file-parallelism'],cwd=root/'frontend',stdout=out,stderr=subprocess.STDOUT,check=True)
(s/'result.json').write_text(json.dumps(cases,indent=2))
(s/'source-fingerprints.json').write_text(json.dumps({'before':fingerprints,'restored':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in originals}},indent=2))
print('DRILL PASS',len(cases),'mutations; original bytes restored')
