import type { BlueprintPlanData, BlueprintReference } from '../../types/blueprint';

/** Data is always rendered as text. Connector descriptors are never a GUI projection. */
export function BlueprintData({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>None</span>;
  if (typeof value !== 'object') return <span className="blueprint-literal">{String(value)}</span>;
  if (Array.isArray(value)) return value.length ? <ul>{value.map((row, i) => <li key={i}><BlueprintData value={row} /></li>)}</ul> : <span>None</span>;
  return <dl className="blueprint-data">{Object.entries(value).filter(([key]) => key !== 'descriptor').map(([key, item]) =>
    <div key={key}><dt>{key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/\bid\b/gi, 'ID')}</dt><dd><BlueprintData value={item} /></dd></div>)}</dl>;
}
export function BlueprintReferences({ references }: { references: BlueprintReference[] }) {
  return <ul>{references.map((reference, i) => <li key={`${reference.kind}:${reference.name}:${i}`}>
    <strong>{reference.name}</strong> ({reference.kind}): {reference.outcome === 'missing-optional' ? 'Optional reference unavailable; Create requires access.' : reference.outcome === 'missing-required' ? 'Required reference unavailable.' : 'Resolved'}
    {reference.requiredAccess && <p>Access needed: {reference.requiredAccess}. {reference.reason}</p>}
    {reference.resolved && <BlueprintData value={reference.resolved} />}
  </li>)}</ul>;
}
export function BlueprintPlan({ plan, targetArchived }: { plan: BlueprintPlanData; targetArchived: boolean }) {
  return <div className="blueprint-plan">
    <p>Preview creates nothing. All created tasks begin parked. Choosing a gate arm grants no authority; a caller with task write authority may arm chosen tasks separately. Unchosen tasks remain parked.</p>
    {targetArchived && <p className="blueprint-error" role="alert">This Project is archived. The plan can be read, but it cannot be instantiated here.</p>}
    {!!plan.refusals?.length && <section aria-label="Plan refusals"><h3>Plan refusals</h3><ul>{plan.refusals.map((refusal, i) => <li key={i} className="blueprint-error"><strong>{refusal.code}</strong>: {refusal.error} ({refusal.field})</li>)}</ul></section>}
    <h3>Counts</h3><BlueprintData value={plan.counts} />
    <h3>Authority</h3><ul>{plan.authority.map((row, i) => <li key={i}>
      <strong>{row.allowed ? 'Available' : 'Missing authority'}</strong>: {row.scope} for {row.operation}{row.localKey ? ` (${row.localKey})` : ''}
      <details><summary>Authority details</summary><BlueprintData value={row} /></details>
    </li>)}</ul>
    <h3>Project</h3><BlueprintData value={plan.project || plan.target} />
    <h3>Phases</h3>{plan.phases.length ? plan.phases.map((phase, i) => <details key={i}><summary>{String(phase.name ?? phase.key)}</summary><BlueprintData value={phase} /></details>) : <p>No new Phases.</p>}
    <h3>Tasks and Subtasks</h3>{plan.tasks.map(task => <details key={task.key} data-task-key={task.key}>
      <summary>{task.title} — {task.key} — parked</summary><BlueprintData value={task} />
    </details>)}
    <h3>Dependencies</h3><ul>{plan.dependencies.map((edge, i) => <li key={i}>{edge.task} depends on {edge.dependsOn}</li>)}</ul>
    <h3>Reports and links</h3>{plan.reports.map((report, i) => <details key={i}><summary>{String(report.title ?? report.key)}</summary><BlueprintData value={report} /></details>)}
    <h3>Human gates</h3>{plan.humanGates.length ? plan.humanGates.map(gate => <details key={gate.key} open>
      <summary>{gate.key}</summary><p>{gate.disposition}</p><BlueprintData value={gate} />
    </details>) : <p>No human gates in this plan.</p>}
    <p>A task listed in more than one arm is created once. Arm membership does not duplicate the Task.</p>
    <h3>References and warnings</h3><BlueprintReferences references={plan.references} />
    <details><summary>Your materialized answers</summary><BlueprintData value={plan.parameterValues} /></details>
  </div>;
}
