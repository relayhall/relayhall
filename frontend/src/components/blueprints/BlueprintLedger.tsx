import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BlueprintLedgerRow } from '../../types/blueprint';
import { formatDateTime } from '../../utils/dateFormat';
import { blueprintError, blueprintRequest } from './api';
import { BlueprintSetup } from './BlueprintSetup';
import { BlueprintData } from './BlueprintPlan';
export function BlueprintLedger({ blueprintId, instantiationId }: { blueprintId: string; instantiationId?: string }) {
  const [rows, setRows] = useState<BlueprintLedgerRow[]>([]); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  useEffect(() => {
    const current = ++seq.current; setLoading(true); setError(null); setRows([]);
    const path = instantiationId ? `/instantiations/${encodeURIComponent(instantiationId)}` : `/blueprints/${encodeURIComponent(blueprintId)}/instantiations`;
    blueprintRequest<{ instantiations?: BlueprintLedgerRow[]; instantiation?: BlueprintLedgerRow }>(path).then(data => {
      if (current === seq.current) setRows(data.instantiation ? [data.instantiation] : data.instantiations || []);
    }).catch(failure => { if (current === seq.current) setError(blueprintError(failure).message); }).finally(() => { if (current === seq.current) setLoading(false); });
    return () => { seq.current++; };
  }, [blueprintId, instantiationId]);
  return <section aria-label="Instantiation ledger"><h3>Instantiation ledger</h3>
    {loading && <p role="status">Loading visible ledger entries…</p>}{error && <p role="alert" className="blueprint-error">{error}</p>}
    {!loading && !error && !rows.length && <p>No visible instantiations.</p>}
    {rows.map(row => <details key={row.id} open={!!instantiationId}><summary>{row.blueprint_key} v{row.blueprint_version} — {formatDateTime(row.created_at)}</summary>
      <p>Project: <Link to={`/projects?open=${encodeURIComponent(row.root_project_id)}`}>{row.root_project_id}</Link></p>
      <p>Instantiation: {row.id}</p><p>Actor: {row.actor_principal_id}</p>
      <h4>Parameter projection</h4><BlueprintData value={row.parameter_projection} />
      {row.parameter_values == null ? <p>Raw answers are restricted to the original instantiator or a root login session. This is an access projection.</p> : <details><summary>Raw answers visible to this session</summary><BlueprintData value={row.parameter_values} /></details>}
      {Array.isArray(row.execution_defaults) && row.execution_defaults.length > 0 && <BlueprintSetup key={row.id} instantiationId={row.id} />}
      <details><summary>Reference outcomes and committed receipt</summary><BlueprintData value={{ references: row.reference_outcomes, receipt: row.response_snapshot }} /></details>
    </details>)}
  </section>;
}
