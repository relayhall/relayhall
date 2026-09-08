import { useEffect, useId, useRef, useState } from 'react';
import type { BlueprintParameter, BlueprintValue } from '../../types/blueprint';
import { blueprintRequest } from './api';
import { parameterError } from './parameterValidation';

type VisibleOption = { id: string; name?: string; handle?: string; slug?: string; title?: string };
export function BlueprintReferenceInput({ parameter, value, onChange, projectId, id, describedBy, invalid }:
  { parameter: BlueprintParameter; value: string; onChange: (value: string) => void; projectId?: string; id: string; describedBy?: string; invalid?: boolean }) {
  const listId = useId(); const [options, setOptions] = useState<VisibleOption[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle'); const generation = useRef(0);
  const kind = parameter.type.replace('-ref', '');
  const surface = ({ principal: 'principals', project: 'projects', phase: 'phases', skill: 'skills', personality: 'personalities', service: 'services' } as Record<string, string>)[kind];
  useEffect(() => { generation.current++; setOptions([]); setState('idle'); }, [surface, projectId]);
  useEffect(() => () => { generation.current++; }, []);
  const load = async () => {
    if (state === 'ready' || state === 'loading' || kind === 'phase' && !projectId) return;
    const current = ++generation.current; setState('loading');
    try {
      const data = await blueprintRequest<Record<string, unknown>>(`/${surface}${kind === 'phase' ? `?projectId=${encodeURIComponent(projectId!)}` : ''}`);
      if (current !== generation.current) return;
      setOptions(Array.isArray(data[surface]) ? data[surface] as VisibleOption[] : []); setState('ready');
    } catch { if (current === generation.current) { setOptions([]); setState('error'); } }
  };
  return <><input id={id} list={listId} value={value} onChange={event => onChange(event.target.value)} onFocus={load}
    autoComplete="off" aria-describedby={describedBy} aria-invalid={invalid || undefined} />
    <datalist id={listId}>{options.map(option => <option key={option.id} value={kind === 'phase' || kind === 'project' ? option.id : option.handle || option.slug || option.name || option.id}>{option.name || option.handle || option.title || option.id}</option>)}</datalist>
    {kind === 'phase' && !projectId && <small>Select an existing Project before looking up its Phases.</small>}
    {state === 'loading' && <small role="status">Loading visible matches…</small>}
    {state === 'error' && <small role="status">Visible matches could not be loaded. Focus this field again to retry, or enter a known identifier. The server will validate it.</small>}
  </>;
}
export function BlueprintParameters({ parameters, values, onChange, projectId, showErrors, serverField }:
  { parameters: BlueprintParameter[]; values: Record<string, BlueprintValue>; onChange: (key: string, value: BlueprintValue) => void; projectId?: string; showErrors: boolean; serverField?: string }) {
  return <div className="blueprint-fields">{[...parameters].sort((a, b) => Number(!!b.required) - Number(!!a.required) || (a.order || 0) - (b.order || 0)).map(parameter => {
    const id = `blueprint-parameter-${parameter.key}`; const help = `${id}-help`; const errorId = `${id}-error`;
    const error = showErrors ? parameterError(parameter, values[parameter.key]) : null;
    const refused = serverField === parameter.key || serverField?.endsWith(`.${parameter.key}`);
    const describedBy = [parameter.help ? help : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;
    const common = { id, 'aria-describedby': describedBy, 'aria-invalid': error || refused ? true : undefined };
    const value = values[parameter.key];
    return <div className="blueprint-field" key={parameter.key}>
      <label htmlFor={id}>{parameter.promptText || parameter.label}{parameter.required ? ' (required)' : ''}</label>
      {parameter.help && <small id={help}>{parameter.help}</small>}
      {parameter.type.endsWith('-ref') ? <BlueprintReferenceInput parameter={parameter} value={String(value ?? '')} onChange={answer => onChange(parameter.key, answer)} projectId={projectId} id={id} describedBy={describedBy} invalid={!!error || refused} />
        : parameter.type === 'enum' || parameter.type === 'boolean' ? <select {...common} id={id} value={String(value ?? '')} onChange={event => onChange(parameter.key, parameter.type === 'boolean' && event.target.value !== '' ? event.target.value === 'true' : event.target.value)}>
          <option value="">Choose an answer</option>{parameter.type === 'boolean' ? <><option value="true">Yes</option><option value="false">No</option></> : parameter.constraints?.enum?.map(option => <option key={option}>{option}</option>)}
        </select>
        : parameter.type === 'text' ? <textarea {...common} value={String(value ?? '')} onChange={event => onChange(parameter.key, event.target.value)} rows={4} />
        : <input {...common} type={parameter.type === 'integer' ? 'number' : parameter.type === 'date' ? 'date' : 'text'} value={String(value ?? '')}
          step={parameter.type === 'integer' ? 1 : undefined} onChange={event => onChange(parameter.key, parameter.type === 'integer' && event.target.value !== '' ? Number(event.target.value) : event.target.value)} />}
      {error && <small className="blueprint-error" id={errorId}>{error}</small>}
    </div>;
  })}</div>;
}
