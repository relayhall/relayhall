#!/usr/bin/env python3
"""MAP-A7c controls: prove each remaining clause-6 control red separately,
then prove every repaired painted family rejects missing and constant chain dim,
and (card cae8dfe1) that each A7a behaviour - edge identity, the Map and list
split, hover linking, the project layer - has a control that reddens its test.
Run serially; no other writer may use this checkout during the drill.
Original bytes (including pre-existing edits) are always restored.
"""
from pathlib import Path
import subprocess,re,json,hashlib
import os
# Every control below matches vitest's plain summary ('Tests  1 failed'). The
# workflows set CI, and with CI set vitest colours its output, so the summary
# carries escape codes, the match never succeeds and a control that went red
# is reported as not red. The vitest runs here are therefore uncoloured.
os.environ['NO_COLOR']='1'
os.environ.pop('FORCE_COLOR',None)
root=Path(__file__).resolve().parents[1]
s=root/'tmp/map-plane-mutation-drill';s.mkdir(parents=True,exist_ok=True)
model=root/'frontend/src/components/map/mapPlaneModel.ts'
view=root/'frontend/src/components/map/MapView.tsx'
# Card cae8dfe1 (A7a deferred features): the split, the hover linking, the
# edge identity and the project layer live in these as well.
data=root/'frontend/src/components/map/useMapData.ts'
split=root/'frontend/src/components/map/useMapSplit.ts'
graph=root/'frontend/src/components/map/mapGraphModel.ts'
sheet=root/'frontend/src/components/map/MapView.css'
originals={p:p.read_bytes() for p in [model,view,data,split,graph,sheet]}
fingerprints={str(p.relative_to(root)):hashlib.sha256(b).hexdigest() for p,b in originals.items()}
cases=[]
# The six clause-6 controls share ONE mutation, named here: the lattice cell
# reads the MEASURED size map again (a measured tile widens its column and
# deepens its row), which every invariance test (a)-(f) must reject. It is
# stated as the cell's two reservations; both must be found exactly once, or
# the drill stops by name before any control runs. Re-anchored on 19 Oct 2026
# (machinery queue 9b761f09): the cell became `cellOf(pill count)` (5068cf16,
# after the Vertical transposition 3afdc2fe), so the old `cellWidth(pills)`
# anchor matched nothing and the column half of the mutation never applied.
SIZE_MAP_CELL=[
 ('wantCol.set(slot.col, Math.max(wantCol.get(slot.col) ?? 0, cell.w));',
  'wantCol.set(slot.col, Math.max(wantCol.get(slot.col) ?? 0, cell.w + Math.max(0, (sizes[node.id]?.w ?? 170) - 170)));'),
 ('wantRow.set(slot.row, Math.max(wantRow.get(slot.row) ?? 0, cell.h));',
  'wantRow.set(slot.row, Math.max(wantRow.get(slot.row) ?? 0, cell.h + Math.max(0, (sizes[node.id]?.h ?? 128) - 128)));'),
]
# dim-override overrode BOTH container sinks when both multiplied the zoom fade
# by the chain dim. The captioned container now paints at full ink (its fade
# is 1), where a constant override equals dim times its fade and so cannot
# redden; the override is therefore applied at the one sink that still fades
# (the region shape), which is the one the control's two tests can see.
# Retired controls, each with the reason it can no longer be red by construction.
RETIRED=[
 ('band-fade-override','the phase ground that paints a band on the continuous plane (0183cc1b) carries no fade of its own, so a constant dim override equals the correct value'),
 ('fit-compaction','the lattice is replayed from what is shown (replaySlots, E386 round 2): a departed task is never placed, so there is no hole for a compaction pass to close and the pass is gone; fit-replay reddens the same test by reading coordinates back'),
]
# E386 round 2 (review B1): the replay starts from an EMPTY lattice. Reading
# the record's coordinates back instead is the round-1 engine, which kept a
# hole a departure left and kept the column an archived predecessor forced.
REPLAY_SEED=('  let placed = new Map<string, { col: number; row: number }>();\n',
 '  let placed = new Map(nodes.flatMap(node => { const held = anchors.slots[node.id]; return held && held.seg === segment ? [[node.id, { col: held.col, row: held.row }] as [string, { col: number; row: number }]] : []; }));\n')
FADED_CONTAINER_SINK='entry.alpha * chainScale(\n                  planeChain, planeChain?.has(entry.id) ?? false, CHAIN_DIM.node)'
for anchor,_ in SIZE_MAP_CELL:
 assert originals[model].decode().count(anchor)==1,('size-map cell anchor drifted',anchor)
assert originals[view].decode().count(FADED_CONTAINER_SINK)==1,('faded container sink anchor drifted',FADED_CONTAINER_SINK)
try:
 with (s/'baseline.log').open('w') as out:
  subprocess.run(['node_modules/.bin/vitest','run','src/components/map/mapPlaneModel.test.ts','src/components/map/MapView.render.test.tsx','src/components/map/MapView.a7a.test.tsx','--no-file-parallelism'],cwd=root/'frontend',stdout=out,stderr=subprocess.STDOUT,check=True)
 for control,pattern in [('first-measure','\\(a\\) a tile measured'),('filter','\\(b\\) FILTER'),('reload','\\(c\\) RELOAD'),('session','\\(d\\) NEW SESSION'),('creation','\\(e\\) LIVE CREATION'),('size-map','\\(f\\) THE CLASS')]:
  text=originals[model].decode()
  for anchor,replacement in SIZE_MAP_CELL:
   assert text.count(anchor)==1,(control,anchor)
   text=text.replace(anchor,replacement)
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
   # Reproduce a constant-opacity override at the faded container sink.
   assert text.count(FADED_CONTAINER_SINK)==1,(name,FADED_CONTAINER_SINK)
   text=text.replace(FADED_CONTAINER_SINK,'(planeChain && !planeChain.has(entry.id) ? CHAIN_DIM.node : entry.alpha)')
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
  # Re-anchored 19 Oct 2026 (9b761f09): on the continuous plane a band paints
  # as its phase ground (0183cc1b); the `.map-band` div it used to name renders
  # only off the plane, where no 'band' test measures it.
  ('band-attention',view,'style={{opacity:furnitureScale(phaseKeyOfBand(phase))}}','style={{opacity:1}}','MapView.render.test.tsx',"'band' composes membership and its actual fade at 1$"),
  # Declared test moved to scale 1 on 19 Oct 2026 (9b761f09): the chip's own
  # ink is now 1 or 0 by caption ownership, and at 0.28 the aggregate owns the
  # caption, so the chip is 0 there with or without its attention factor.
  ('chip-attention',view,"chipAlpha * furnitureScale(own ? phaseKeyOfBand(own) : '')",'chipAlpha','MapView.render.test.tsx',"'chip' composes membership and its actual fade at 1$"),
  ('header-attention',view,'headerAlpha * furnitureScale(`project:${laneKey}`)','headerAlpha','MapView.render.test.tsx',"'header' composes membership and its actual fade at 0.2$"),
  ('chip-fade-override',view,"chipAlpha * furnitureScale(own ? phaseKeyOfBand(own) : '')","(furnitureScale(own ? phaseKeyOfBand(own) : '') < 1 ? CHAIN_DIM.node : chipAlpha)",'MapView.render.test.tsx',"'chip' composes membership and its actual fade at 0.28$"),
  ('header-fade-override',view,'headerAlpha * furnitureScale(`project:${laneKey}`)','(furnitureScale(`project:${laneKey}`) < 1 ? CHAIN_DIM.node : headerAlpha)','MapView.render.test.tsx',"'header' composes membership and its actual fade at 0.2$"),
  ('sibling-phase-membership',view,'`phase:${band.laneId}\\u0000${band.id.slice(`band:${band.laneId}:`.length)}`','`project:${band.laneId}`','MapView.render.test.tsx',"'band' composes membership and its actual fade at 1$"),
  # Owner ruling E386 (20 Oct 2026): every area fits what is shown, and no
  # layout geometry survives a reload. Each control removes one half of that.
  ('fit-replay',model,REPLAY_SEED[0],REPLAY_SEED[1],'mapFitToShown.test.ts','a column the departures empty closes'),
  # E386 round 2 (review B1, B2): each removes one half of "geometry is a
  # function of what is shown and the session's order".
  ('fit-replay-b1',model,REPLAY_SEED[0],REPLAY_SEED[1],'mapFitToShown.test.ts','horizontal: B1 a live task depending on an archived task'),
  ('fit-organic-fit',model,'fitted record they find nothing held and place from scratch.\n  const anchors = fitPlaneAnchors(given, graph);\n','fitted record they find nothing held and place from scratch.\n  const anchors = given;\n','mapFitToShown.test.ts','organic: B2 regions and the archive core shrink back'),
  ('fit-sequence',model,'    || (heldOrd.get(a.id) ?? Infinity) - (heldOrd.get(b.id) ?? Infinity)\n','','mapFitToShown.test.ts','an update that does not change what is shown moves nothing'),
  ('fit-declared-order',model,'      for (let ahead = index + 1; ahead < canonical.length && at < 0; ahead += 1) {\n        const seen = order.indexOf(canonical[ahead].key);\n        if (seen >= 0) at = seen;\n      }\n','','mapFitToShown.test.ts','horizontal: a finished phase declared first'),
  ('fit-empty-phase',model,'if (phase && (byBand.get(phase.id)?.length ?? 0) > 0) {','if (phase) {','mapFitToShown.test.ts','a declared phase with no task is not displayed'),
  ('fit-absent-lane',model,'    if (laneNodes.length === 0) continue;\n','    if (laneNodes.length === 0) { cursorY += plane.laneHeaderH + metrics.laneGapY; continue; }\n','mapFitToShown.test.ts','an archived-only project takes no ground'),
  ('fit-stored-record',view,'useEffect(() => { clearStoredPlaneAnchors(); }, []);','useEffect(() => {}, []);','MapView.fitToShown.test.tsx','is removed on load'),
  ('fit-repack',view,'    cancelSwitch();\n    anchorsRef.current[view.organization] = EMPTY_PLANE_ANCHORS;\n','    cancelSwitch();\n','MapView.fitToShown.test.tsx','Re-pack layout lays the plane out afresh'),
  # Card cae8dfe1 (A7a deferred features, 20 Oct 2026). Edge identity
  # (absorbed 01282f30): a relationship listed twice draws once, and the
  # identity is a tuple a dash-joined id cannot forge.
  ('edge-dedupe',data,'edges: uniqueMapEdges(data?.edges ?? []),','edges: data?.edges ?? [],','MapView.a7a.test.tsx','lists twice draws ONCE'),
  ('edge-identity',graph,'const identity = JSON.stringify([edge.kind, edge.from, edge.to]);','const identity = `${edge.kind}-${edge.from}-${edge.to}`;','MapView.a7a.test.tsx','uniqueMapEdges keeps the first'),
  # (d) the Map and list split: keys, floors, the tab's memory, and the
  # list that still REPLACES the canvas when chosen alone.
  ('split-keyboard',split,"const step = event.key === 'ArrowUp' ? SPLIT_KEY_STEP\n","const step = event.key === 'ArrowUp' ? -SPLIT_KEY_STEP\n",'MapView.a7a.test.tsx','behind a keyboard-operable separator'),
  ('split-floor',split,'const max = Math.max(min, Math.round(available - canvasMin));','const max = Math.max(min, Math.round(available));','MapView.a7a.test.tsx','neither pane can be dragged to nothing'),
  ('split-storage',split,'    sessionStorage.setItem(MAP_SPLIT_STORAGE_KEY, JSON.stringify(split));\n','    void split;\n','MapView.a7a.test.tsx','remembered for the tab'),
  ('split-replaces',view,'const splitActive = split.open && !treeMode;','const splitActive = split.open;','MapView.a7a.test.tsx','still REPLACES the canvas'),
  # (e) hover linking, both ways, by focus too, in the DOM (no plane render)
  # and without touching the chain selection.
  ('link-ring',view,"    ring.setAttribute('data-active', '');\n",'','MapView.a7a.test.tsx','through ONE ring'),
  ('link-no-render',view,'    listLinkRef.current = id;\n    placeLinkRing();\n','    listLinkRef.current = id;\n    placeLinkRing();\n    setHoveredId(id);\n','MapView.a7a.test.tsx','through ONE ring'),
  ('link-focus',view,'onFocus={splitActive ? () => linkFromList(node.id) : undefined}','onFocus={undefined}','MapView.a7a.test.tsx','focus drives the list-to-map link'),
  ('link-row',view,"    row.setAttribute('data-map-linked', '');\n",'','MapView.a7a.test.tsx','lights its list row'),
  ('link-scroll',view,'list.scrollTop += box.bottom - frame.bottom;','list.scrollTop += 0;','MapView.a7a.test.tsx','lights its list row'),
  ('link-chain',view,'    listLinkRef.current = id;\n    placeLinkRing();\n','    listLinkRef.current = id;\n    placeLinkRing();\n    setSelectedId(id);\n','MapView.a7a.test.tsx','never changes the chain selection'),
  # (b) the project layer A7c landed, pinned: it contains its phases, and it
  # is the quieter ground with the heavier rule.
  ('project-layer-contain',view,'x={project.x} y={project.y} width={project.w} height={project.h}','x={project.x} y={project.y} width={project.w / 2} height={project.h}','MapView.a7a.test.tsx','horizontal: each project ground'),
  ('project-layer-depth',sheet,'.map-project-ground {\n  fill: var(--bg-surface);\n  stroke: var(--border-strong);\n  stroke-width: 2px;','.map-project-ground {\n  fill: var(--bg-surface);\n  stroke: var(--border-strong);\n  stroke-width: 1px;','MapView.a7a.test.tsx','legible depth'),
 ]
 for name,_ in RETIRED: assert name not in [e[0] for e in extra],name
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
 subprocess.run(['node_modules/.bin/vitest','run','src/components/map/mapPlaneModel.test.ts','src/components/map/MapView.render.test.tsx','src/components/map/MapView.a7a.test.tsx','--no-file-parallelism'],cwd=root/'frontend',stdout=out,stderr=subprocess.STDOUT,check=True)
assert len(cases)==6+2+len(extra),('a control did not run',len(cases))
(s/'result.json').write_text(json.dumps({'controls':cases,'retired':[{'control':n,'reason':r} for n,r in RETIRED]},indent=2))
(s/'source-fingerprints.json').write_text(json.dumps({'before':fingerprints,'restored':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in originals}},indent=2))
print('DRILL PASS',len(cases),'mutations;',len(RETIRED),'retired (',', '.join(n for n,_ in RETIRED),'); original bytes restored')
