import { Button } from '../Button';

/** Shared keyboard selection control for Map aggregates and registry tiles. */
export function MapCardTitle({ label, accessibleName, selected, onSelect }: {
  label: string; accessibleName: string; selected?: boolean; onSelect: () => void;
}) {
  return <Button variant="secondary" size="compact" className="map-aggregate-select"
    ariaLabel={accessibleName} ariaPressed={selected} onClick={onSelect}>
    <span className="map-aggregate-name">{label}</span>
  </Button>;
}
