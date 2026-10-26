import React from 'react';

export type ArchiveMotionTarget = {
  id: string;
  owner: string;
  x: number;
  y: number;
  scale: number;
  archived: boolean;
};

/** Product tuning, not a universal speed guarantee: very long moves cap at12s. */
export function archiveDriftDuration(distanceCssPx: number): number {
  if (!Number.isFinite(distanceCssPx) || distanceCssPx <= 0) return 0;
  return Math.min(12000, Math.max(1000, distanceCssPx / 160 * 1000));
}

type Props = React.HTMLAttributes<HTMLDivElement> & {
  motionTargets: readonly ArchiveMotionTarget[];
  motionScale: number;
  motionEnabled: boolean;
};
const VARIABLE = '--map-archive-duration';

/**
 * The same plane DOM element. Snapshot runs before React changes destinations,
 * so interrupted motion starts at current ink, not its previous final target.
 * All geometry reads precede all writes. Duration is installed before mutation
 * and before descendant measurement refs can force a post-update style flush.
 * CSS owns the actual transition and reduced-motion override; no timers/queue.
 */
export class ArchiveMotionPlane extends React.Component<Props> {
  private plane = React.createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(previous: Props): null {
    const plane = this.plane.current;
    if (!plane) return null;
    const mounted = new Map(Array.from(plane.querySelectorAll<HTMLElement>('[data-map-motion-id]'))
      .map(element => [element.dataset.mapMotionId!, element]));
    const old = new Map(previous.motionTargets.map(target => [target.id, target]));
    const next = new Map(this.props.motionTargets.map(target => [target.id, target]));
    const enabled = previous.motionEnabled && this.props.motionEnabled
      && Number.isFinite(previous.motionScale) && previous.motionScale > 0
      && Number.isFinite(this.props.motionScale) && this.props.motionScale > 0;
    const movingOwners = new Set<string>();
    const clear: HTMLElement[] = [];
    for (const [id, element] of mounted) {
      const before = old.get(id), after = next.get(id);
      if (!enabled || !after?.archived) {
        clear.push(element);
      } else if (before && (before.x !== after.x || before.y !== after.y
        || before.scale !== after.scale || !before.archived)) {
        movingOwners.add(after.owner);
      }
    }

    const members: { element: HTMLElement; owner: string; distance: number }[] = [];
    if (movingOwners.size) {
      const origin = plane.getBoundingClientRect();
      for (const [id, element] of mounted) {
        const target = next.get(id);
        if (!target?.archived || !movingOwners.has(target.owner) || !old.has(id)) continue;
        const rect = element.getBoundingClientRect();
        const x = (rect.left - origin.left) / previous.motionScale;
        const y = (rect.top - origin.top) / previous.motionScale;
        const w = rect.width / previous.motionScale;
        const h = rect.height / previous.motionScale;
        const targetW = element.offsetWidth * target.scale;
        const targetH = element.offsetHeight * target.scale;
        // Current rendered and destination corners share one world frame.
        const distance = Math.max(
          Math.hypot(target.x - x, target.y - y),
          Math.hypot(target.x + targetW - x - w, target.y - y),
          Math.hypot(target.x - x, target.y + targetH - y - h),
          Math.hypot(target.x + targetW - x - w, target.y + targetH - y - h),
        ) * this.props.motionScale;
        members.push({ element, owner: target.owner, distance });
      }
    }
    const durations = new Map<string, number>();
    for (const member of members) {
      durations.set(member.owner, Math.max(durations.get(member.owner) ?? 0,
        archiveDriftDuration(member.distance)));
    }
    // No style/layout reads below this line. Reversal clears our override;
    // React removes archive class and the existing live policy takes over.
    for (const element of clear) element.style.removeProperty(VARIABLE);
    for (const member of members) {
      member.element.style.setProperty(VARIABLE, `${durations.get(member.owner)}ms`);
    }
    return null;
  }

  componentDidUpdate(): void { /* Snapshot intentionally completes before mutation. */ }

  render(): React.ReactNode {
    const { motionTargets: _targets, motionScale: _scale, motionEnabled: _enabled, ...props } = this.props;
    return <div {...props} ref={this.plane} />;
  }
}
