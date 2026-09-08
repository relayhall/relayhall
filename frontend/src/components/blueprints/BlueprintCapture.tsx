import '../../pages/BlueprintsPage.css';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../Button';
import { blueprintRequest, blueprintJson, blueprintError } from './api';

export function BlueprintCapture({ phaseId, projectId, phaseName, onClose }: { phaseId: string; projectId: string; phaseName: string; onClose: () => void }) {
  const [name,setName]=useState(phaseName);const [pending,setPending]=useState(false);const [error,setError]=useState('');
  const navigate=useNavigate();
  const save=async()=>{if(pending)return;setPending(true);setError('');
    try { const result=await blueprintRequest<{blueprint:{id:string;version:number}}>('/blueprints/capture',blueprintJson({phaseId,projectId,name}));
      navigate('/blueprints?blueprint='+encodeURIComponent(result.blueprint.id)+'&version='+result.blueprint.version);
    } catch(cause){setError(blueprintError(cause).message);} finally{setPending(false);}
  };
  return <section className="blueprints-page blueprint-lifecycle" aria-label="Save Phase as Blueprint">
    <h2>Save as Blueprint</h2><p>Capture this Phase and its Tasks as a draft. Review the fields before submitting it for independent publication review.</p>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={event=>{event.preventDefault();void save();}}>
      <label>Blueprint name<input autoFocus required value={name} disabled={pending} onChange={event=>setName(event.target.value)} /></label>
      <div className="blueprint-actions"><Button variant="secondary" disabled={pending} onClick={onClose}>Cancel capture</Button><Button type="submit" disabled={pending || !name.trim()}>{pending?'Capturing…':'Save draft Blueprint'}</Button></div>
    </form>
  </section>;
}
