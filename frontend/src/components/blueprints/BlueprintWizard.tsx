import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../Button';
import type { BlueprintDetail, BlueprintPreview, BlueprintRequest, BlueprintResult, BlueprintValue } from '../../types/blueprint';
import { blueprintError, blueprintJson, blueprintRequest, BlueprintRequestError } from './api';
import { BlueprintData, BlueprintPlan, BlueprintReferences } from './BlueprintPlan';
import { BlueprintParameters } from './BlueprintParameters';
import { BlueprintSetup } from './BlueprintSetup';
import { parameterError } from './parameterValidation';

const STEPS = ['Discover', 'Describe', 'Collect', 'Preview', 'Confirm', 'Instantiate', 'Report'];
export function BlueprintSteps({ step }: { step: number }) {
  return <ol className="blueprint-steps" aria-label="Blueprint interview">{STEPS.map((label, index) =>
    <li key={label} aria-current={index + 1 === step ? 'step' : undefined}>{index + 1}. {label}</li>)}</ol>;
}
type Attempt = { key: string; body: string };
const previewAllowsCreation = (preview: BlueprintPreview | null) => !!preview && !preview.targetArchived
  && Array.isArray(preview.plan.refusals) && preview.plan.refusals.length === 0
  && preview.plan.authority.every(row => row.allowed)
  && preview.plan.references.every(reference => reference.outcome !== 'missing-required');
export function BlueprintWizard({ blueprint, projectId, onClose }: { blueprint: BlueprintDetail; projectId?: string; onClose: () => void }) {
  const projectParameter = typeof blueprint.document.target.project === 'string' ? /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(blueprint.document.target.project)?.[1] : undefined;
  const [values, setValues] = useState<Record<string, BlueprintValue>>(() => {
    const initial: Record<string, BlueprintValue> = {};
    for (const parameter of blueprint.parameters) if (parameter.default !== undefined && parameter.default !== null) initial[parameter.key] = parameter.default;
    if (projectId && projectParameter) initial[projectParameter] = projectId;
    return initial;
  });
  const [step, setStep] = useState(3); const [pending, setPending] = useState(false); const [showErrors, setShowErrors] = useState(false);
  const [preview, setPreview] = useState<BlueprintPreview | null>(null); const [previewBody, setPreviewBody] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null); const [result, setResult] = useState<BlueprintResult | null>(null);
  const [error, setError] = useState<BlueprintRequestError | null>(null); const errorRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null); const generation = useRef(0); const inFlight = useRef(false);
  useEffect(() => { headingRef.current?.focus(); }, [step]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => () => { generation.current++; }, []);
  const selectedProject = projectParameter && typeof values[projectParameter] === 'string' ? String(values[projectParameter]) : projectId;
  const edit = () => { generation.current++; setStep(3); setPreview(null); setPreviewBody(null); setAttempt(null); setError(null); setPending(false); };
  const change = (key: string, value: BlueprintValue) => {
    edit(); setValues(current => { const next = { ...current }; if (value === '') delete next[key]; else next[key] = value; return next; });
  };
  const getPreview = async () => {
    setShowErrors(true); setError(null);
    const invalid = blueprint.parameters.find(parameter => parameterError(parameter, values[parameter.key]));
    if (invalid) { document.getElementById(`blueprint-parameter-${invalid.key}`)?.focus(); return; }
    if (blueprint.target.mode === 'existing-project' && !selectedProject) {
      setError(new BlueprintRequestError('Choose an existing Project.', 'PROJECT_REQUIRED')); return;
    }
    const request: BlueprintRequest = { target: { mode: blueprint.target.mode, ...(blueprint.target.mode === 'existing-project' ? { project: selectedProject } : {}) }, parameterValues: { ...values } };
    const body = JSON.stringify(request); const current = ++generation.current; setPending(true); setAttempt(null);
    try {
      const next = await blueprintRequest<BlueprintPreview>(`/blueprints/${encodeURIComponent(blueprint.id)}/instantiations/preview`, { ...blueprintJson(request), body });
      if (current !== generation.current) return;
      setPreview(next); setPreviewBody(body); setStep(4);
    } catch (failure) { if (current === generation.current) setError(blueprintError(failure)); }
    finally { if (current === generation.current) setPending(false); }
  };
  const instantiate = async (confirmed: Attempt) => {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setError(null); setStep(6);
    try {
      const next = await blueprintRequest<BlueprintResult>(`/blueprints/${encodeURIComponent(blueprint.id)}/instantiations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': confirmed.key }, body: confirmed.body,
      });
      setResult(next); setStep(7);
    } catch (failure) { setError(blueprintError(failure)); }
    finally { inFlight.current = false; setPending(false); }
  };
  const confirm = () => {
    if (!previewBody || !preview || inFlight.current || !previewAllowsCreation(preview)) return;
    // This is the sole key creation site: an explicit confirmation, after preview.
    try {
      const key = typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      const confirmed = { key, body: previewBody }; setAttempt(confirmed); void instantiate(confirmed);
    } catch { setError(new BlueprintRequestError('A safe retry identifier could not be created. Please try again in a supported browser.', 'CONFIRMATION_UNAVAILABLE')); }
  };
  const canInstantiate = previewAllowsCreation(preview);
  return <section className="blueprint-wizard" aria-label="Instantiate Blueprint">
    <BlueprintSteps step={step} /><h2 ref={headingRef} tabIndex={-1}>{STEPS[step - 1]} — {blueprint.name}</h2>
    {error && <div ref={errorRef} role="alert" tabIndex={-1} className="blueprint-error"><strong>{error.code}</strong>: {error.message}{error.field && <p>Field: {error.field}</p>}</div>}
    {step === 3 && <form onSubmit={event => { event.preventDefault(); void getPreview(); }} noValidate>
      <p>{blueprint.target.mode === 'existing-project' ? 'Add ordinary work to the selected existing Project.' : 'Create a Project and its ordinary work from this Blueprint.'}</p>
      <BlueprintParameters parameters={blueprint.parameters} values={values} onChange={change} projectId={selectedProject} showErrors={showErrors} serverField={error?.field} />
      <div className="blueprint-actions"><Button variant="secondary" onClick={onClose} disabled={pending}>Back to description</Button><Button type="submit" disabled={pending}>{pending ? 'Preparing preview…' : 'Preview plan'}</Button></div>
    </form>}
    {step === 4 && preview && <><p>Published version {preview.blueprint.version}</p><BlueprintPlan plan={preview.plan} targetArchived={preview.targetArchived} />
      {!canInstantiate && <p className="blueprint-error">This preview cannot be instantiated with the current authority, references or plan state. The diagnostics above explain what is needed.</p>}
      <div className="blueprint-actions"><Button variant="secondary" onClick={edit}>Edit answers</Button><Button onClick={() => setStep(5)} disabled={!canInstantiate}>Continue to confirmation</Button></div>
    </>}
    {step === 5 && preview && <><p>Confirm this exact plan for {blueprint.name}, version {preview.blueprint.version}.</p><BlueprintData value={preview.plan.counts} />
      <p>All tasks start parked. Human gate decisions and later arming are separate acts under the caller’s ordinary authority.</p>
      <div className="blueprint-actions"><Button variant="secondary" onClick={() => setStep(4)}>Review plan again</Button><Button onClick={confirm} disabled={pending || !canInstantiate}>Confirm and instantiate</Button></div>
    </>}
    {step === 6 && <><p role="status">{pending ? 'Creating the confirmed work…' : 'The creation request has not produced a successful receipt.'}</p>
      {error?.uncertain && <p>The request may already have committed. Retry with the same confirmation before changing the plan; a retry returns the original result.</p>}
      <div className="blueprint-actions"><Button onClick={() => attempt && void instantiate(attempt)} disabled={pending || !attempt}>Retry same request</Button>
        {!error?.uncertain && <Button variant="secondary" onClick={edit} disabled={pending}>Edit answers and preview again</Button>}</div>
    </>}
    {step === 7 && result && <><p role="status">The work was created. All tasks remain parked.</p>
      <p>Project: <Link to={`/projects?open=${encodeURIComponent(result.projectId)}`}>{result.projectId}</Link></p>
      <p>Instantiation: <Link to={`/blueprints?blueprint=${encodeURIComponent(result.blueprint.key)}&instantiation=${encodeURIComponent(result.instantiationId)}`}>{result.instantiationId}</Link></p>
      <h3>Created objects</h3><BlueprintData value={{ phases: result.phases, tasks: result.tasks, reports: result.reports }} />
      <h3>Warnings</h3>{result.warnings.length ? <BlueprintReferences references={result.warnings} /> : <p>No reference warnings.</p>}
      <p>Human gate arms remain parked until an authorized caller acts. Unchosen arms remain parked; no work was armed automatically.</p>
      {result.executionSetup?.required && <BlueprintSetup key={result.instantiationId} instantiationId={result.instantiationId} />}
      <Button variant="secondary" onClick={onClose}>Back to Blueprint</Button>
    </>}
  </section>;
}
