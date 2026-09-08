import React from 'react';
import { ArrowRight, Link2, CheckCircle2, CirclePlay, CircleAlert, Clock, Radio } from 'lucide-react';

import { MapCardTitle } from './MapCardTitle';
import type { AggregateFacts, InternalRollup } from './mapGraphModel';

/**
 * The aggregate CARD — one component, two callers.
 *
 * Amendment §2/§5-A3 clause 5 (R5) is explicit: "Tiles, connectors, chips,
 * pills, headers and all other elements render identically in every
 * organization; an organization changes only placement." The A2 altitude
 * grid draws these nodes at grid coordinates; the continuous plane draws the
 * same ink inside the region the work already occupies. Two copies of this
 * markup would be two things that could drift, and A3 leaves §3 standing —
 * "the aggregate CARD design becomes the containers' close-zoom ink". So it
 * is extracted rather than duplicated, and it carries no coordinates: its
 * caller owns placement, exactly as R5 says.
 */
export interface MapAggregateCardFacts extends AggregateFacts {
  kind: 'phase' | 'project';
  label: string;
  /** The Project this node belongs to; its own name at the project tier. */
  laneLabel: string;
}

export interface MapAggregateCardProps {
  facts: MapAggregateCardFacts;
  /** Relationships that fold INSIDE this node, counted per kind (A2). */
  internal: InternalRollup;
  selected: boolean;
  onSelect: () => void;
  passive?: boolean;
  nameClass?: string;
  goal?: string | null;
  showGoal?: boolean;
}

export const MapAggregateCard: React.FC<MapAggregateCardProps> = ({
  facts, internal, selected, onSelect, passive = false, nameClass = '', goal, showGoal = false,
}) => (
  <>
                {/* A Phase node names its Project first: the phase name alone
                    repeats across the estate and identifies nothing. A Project
                    node would only repeat itself, so it does not. */}
                {facts.kind === 'phase' ? (
                  <span className="map-aggregate-lane">{facts.laneLabel}</span>
                ) : null}
                {/* A REAL control, so the §4 reveal is reachable by keyboard
                    and not only by pointer. Round 5 found the collapse
                    unreachable: aggregate nodes carried no hover, focus or
                    click state at all, so a collapsed relationship could never
                    come back for anyone. */}
                {passive ? (
                  <span className={`map-aggregate-select map-aggregate-name ${nameClass}`}>{facts.label}</span>
                ) : <MapCardTitle label={facts.label}
                  accessibleName={facts.kind === 'project' ? `Select project ${facts.label}` : `Select phase ${facts.label} of project ${facts.laneLabel}`}
                  selected={selected} onSelect={onSelect} />}
                {goal ? <span className={`map-band-goal${showGoal ? '' : ' map-contracted'}`}>{goal}</span> : null}
                <span
                  className="map-aggregate-ring"
                  style={{ ['--map-lane-progress' as string]: `${Math.round(facts.progress * 100)}%` }}
                  aria-hidden="true"
                />
                <span className="map-aggregate-counters">
                  {/* Round 13 B1: A2 gives an aggregate the same FOUR §1
                      answers PLUS progress — done is its own answer, not the
                      ring's percentage. The model always carried
                      facts.completed; this surface just never consumed it.
                      Rendered in §1's order: done, now, stuck, next. */}
                  <span className="map-lane-counter" data-count="done" title={`${facts.completed} done`}>
                    <CheckCircle2 className="map-counter-symbol" size={16} aria-hidden="true" />{facts.completed}<span className="map-counter-word"> done</span>
                  </span>
                  {facts.agentsLive > 0 ? <span className="map-lane-counter map-lane-counter--live"
                    title={`${facts.agentsLive} working now`}><Radio className="map-counter-symbol" size={16} aria-hidden="true" />{facts.agentsLive}<span className="map-counter-word"> working now</span></span> : null}
                  <span className="map-lane-counter map-lane-counter--live" data-count="active"
                    title={`${facts.inFlight} active`}>
                    <CirclePlay className="map-counter-symbol" size={16} aria-hidden="true" />{facts.inFlight}<span className="map-counter-word"> active</span>
                  </span>
                  <span className="map-lane-counter map-lane-counter--stuck" data-count="blocked"
                    title={`${facts.stuck} stuck`}>
                    <CircleAlert className="map-counter-symbol" size={16} aria-hidden="true" />{facts.stuck}<span className="map-counter-word"> blocked</span>
                  </span>
                  <span className="map-lane-counter" data-count="next" title={`${facts.upNext} up next`}>
                    <Clock className="map-counter-symbol" size={16} aria-hidden="true" />{facts.upNext}<span className="map-counter-word"> next</span>
                  </span>
                  {/* Round 14 B1: the relationships that fold INSIDE this node
                      when their two Tasks share an aggregate. A2 forbids
                      dropping them silently and §4 keeps the two kinds
                      distinct at every zoom — so they are VISIBLE, per kind,
                      not an untyped whisper in the sr-only text. Link2 is the
                      estate's Report-link icon (task timeline, TaskLinks). */}
                  {internal.dependency > 0 ? (
                    <span className="map-lane-counter"
                      title={`${internal.dependency} ${internal.dependency === 1 ? 'dependency' : 'dependencies'} inside`}>
                      <ArrowRight size={16} aria-hidden="true" />{internal.dependency}
                    </span>
                  ) : null}
                  {internal.knowledge > 0 ? (
                    <span className="map-lane-counter"
                      title={`${internal.knowledge} Report ${internal.knowledge === 1 ? 'link' : 'links'} inside`}>
                      <Link2 size={16} aria-hidden="true" />{internal.knowledge}
                    </span>
                  ) : null}
                </span>
                <span className="map-aggregate-count">{facts.taskCount}</span>
                <span className="sr-only">
                  {facts.kind === 'project'
                    ? `Project ${facts.label}`
                    : `Phase ${facts.label} of project ${facts.laneLabel}`},
                  {' '}{facts.taskCount} tasks, {facts.completed} done,
                  {' '}{Math.round(facts.progress * 100)}% complete,
                  {' '}{facts.agentsLive} working now, {facts.stuck} stuck,
                  {' '}{facts.upNext} up next
                  {internal.dependency > 0
                    ? `, ${internal.dependency} ${internal.dependency === 1 ? 'dependency' : 'dependencies'} inside` : ''}
                  {internal.knowledge > 0
                    ? `, ${internal.knowledge} Report ${internal.knowledge === 1 ? 'link' : 'links'} inside` : ''}
                </span>
  </>
);
