import { aggregateFactsOf, bandKeyOf, laneKeyOf, type MapGraph, type MapTaskNode, type PlacedElement, type PlacedTile } from './mapGraphModel';
import type { PlaneLayoutResult } from './mapPlaneModel';

export interface PendingPlane {
  graph: MapGraph;
  layout: PlaneLayoutResult;
  /** New, moved or spatially transitioning tasks awaiting the next complete layout. */
  pendingTaskCount: number;
  pendingReportCount: number;
}

/** Same-authority, same-organization presentation only. Never commit this
 * result as a new layout or persist its anchors. Scope changes must discard
 * the snapshot before calling this function. */
export function projectPendingPlane(accepted: PlaneLayoutResult, prior: MapGraph, current: MapGraph): PendingPlane {
  const byId = new Map(current.nodes.map(node => [node.id, node]));
  const phases = new Map(current.phases.map(phase => [phase.id, phase]));
  const tiles = new Map<string, PlacedTile>();
  let transitions = 0;
  for (const element of accepted.elements) {
    if (element.kind !== 'tile') continue;
    const node = byId.get(element.id);
    if (!node || node.project !== element.node.project || node.phaseId !== element.node.phaseId) continue;
    // Archive motion belongs to the next complete spatial result. Keep its
    // previous status while showing current nonspatial metadata, rather than
    // falsely claiming that the archive/home transition has already landed.
    const archiveTransition = (node.status === 'archived') !== (element.node.status === 'archived');
    if (archiveTransition) transitions += 1;
    tiles.set(element.id, { ...element, node: archiveTransition ? { ...node, status: element.node.status } : node });
  }
  const laneNodes = new Map<string, MapTaskNode[]>();
  const bandNodes = new Map<string, MapTaskNode[]>();
  const add = (groups: Map<string, MapTaskNode[]>, key: string | null | undefined, node: MapTaskNode) => {
    if (!key) return;
    const group = groups.get(key);
    if (group) group.push(node); else groups.set(key, [node]);
  };
  for (const tile of tiles.values()) {
    add(laneNodes, tile.laneId, tile.node);
    add(bandNodes, tile.bandId, tile.node);
  }
  const reports = new Map((current.reports ?? []).map(report => [report.id + '\0' + report.taskId, report]));
  const visibleReports = new Map<string, NonNullable<MapGraph['reports']>[number]>();
  const phaseText = (bandId: string, nodes: MapTaskNode[]) => {
    // Archived spatial groups may retain nodes' original project/phase metadata.
    // Refresh a phase caption only when every member identifies this exact band.
    if (!nodes.every(node => bandId === `band:${laneKeyOf(node)}:${bandKeyOf(node)}`)) return {};
    const phase = nodes[0]?.phaseId ? phases.get(nodes[0].phaseId) : undefined;
    return { label: phase?.name ?? 'Unphased', goal: phase?.goal ?? null };
  };
  const elements: PlacedElement[] = [];
  for (const element of accepted.elements) {
    if (element.kind === 'tile') {
      const tile = tiles.get(element.id); if (tile) elements.push(tile);
    } else if (element.kind === 'pill') {
      const report = reports.get(element.reportId + '\0' + element.taskId);
      if (report && tiles.has(element.taskId)) {
        elements.push({ ...element, title: report.title });
        visibleReports.set(report.id + '\0' + report.taskId, report);
      }
    } else if (element.kind === 'band' || element.kind === 'hull') {
      const nodes = bandNodes.get(element.id);
      if (nodes?.length) elements.push({ ...element, ...phaseText(element.id, nodes),
        ...(element.kind === 'band' ? { facts: aggregateFactsOf(nodes) } : {}) });
    } else if (element.kind === 'chip') {
      const nodes = bandNodes.get(element.bandId);
      if (nodes?.length) elements.push({ ...element, ...phaseText(element.bandId, nodes) });
    } else if (element.kind === 'container') {
      const nodes = laneNodes.get(element.laneId);
      if (nodes?.length) elements.push({ ...element, facts: aggregateFactsOf(nodes), taskIds: nodes.map(n => n.id) });
    } else if (element.kind === 'lane') {
      const nodes = laneNodes.get(element.id.slice('lane:'.length));
      if (nodes?.length) elements.push({ ...element, ...aggregateFactsOf(nodes) });
    }
  }
  const nodes = [...tiles.values()].map(tile => tile.node);
  const phaseIds = new Set(nodes.map(node => node.phaseId));
  const graph: MapGraph = { nodes,
    edges: current.edges.filter(edge => tiles.has(edge.from) && tiles.has(edge.to)),
    phases: current.phases.filter(phase => phaseIds.has(phase.id)),
    reports: [...visibleReports.values()] };
  const topology = (graph: MapGraph) => JSON.stringify([
    graph.nodes.map(n => [n.id, n.project, n.phaseId, n.status === 'archived']),
    graph.edges.map(e => [e.from, e.to, e.kind]),
    (graph.reports ?? []).map(r => [r.id, r.taskId]),
  ]);
  const compatibleGround = topology(prior) === topology(current);
  const organicRegions = accepted.organicRegions?.filter(region => region.core || laneNodes.has(region.laneId))
    .map(region => compatibleGround
      // Cluster/extension membership is not encoded in the accepted result.
      // Keep compatible geometry but omit facts we cannot recompute honestly.
      ? { ...region, clusters: region.clusters.map(cluster => ({ ...cluster, facts: undefined })) }
      // Removed membership invalidates derived union and route geometry too.
      // Hide it until the worker recomputes; never rebuild that union here.
      : { ...region, clusters: [], outline: undefined, branches: [], routedBranches: undefined,
        blockedBranches: undefined, blockedRoutes: undefined });
  const displayedReportKeys = new Set(visibleReports.keys());
  return { graph, layout: { ...accepted, elements, organicRegions },
    pendingTaskCount: current.nodes.length - nodes.length + transitions,
    pendingReportCount: (current.reports ?? []).filter(r => !displayedReportKeys.has(r.id + '\0' + r.taskId)).length };
}
