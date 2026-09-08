import type { BlueprintSummary } from '../../types/blueprint';
import { MapCardTitle } from '../map/MapCardTitle';

export function BlueprintTile({ blueprint, onSelect }: { blueprint: BlueprintSummary; onSelect: () => void }) {
  return <article className="blueprint-tile">
    <h2><MapCardTitle label={blueprint.name} accessibleName={'Describe ' + blueprint.name} onSelect={onSelect} /></h2>
    <p className="blueprint-status">Version {blueprint.version} · {blueprint.status || 'published'}</p>
    <p>{blueprint.summary}</p>
    <p>{blueprint.target.mode === 'new-project' ? 'New Project' : 'Existing Project'}</p>
    <p>{blueprint.counts.phases || 0} phases · {blueprint.counts.tasks || 0} tasks · {blueprint.counts.humanGates || 0} gates</p>
    <p>Owner: {blueprint.authorPrincipalId || 'Not disclosed'}</p>
    <p>{blueprint.tags.join(' · ') || 'No tags'}</p>
  </article>;
}
