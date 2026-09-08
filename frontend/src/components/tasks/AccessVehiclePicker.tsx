/**
 * AccessVehiclePicker — RH-P3.AZ-S7 (owner ruling 7440b579 R2/R5).
 *
 * Assignment to a Connector REQUIRES an access vehicle, and Warrants are
 * the DEFAULT one. This is the R5 "suggested at task creation" affordance:
 * when a task inside an anchored Phase is being assigned, the warrants that
 * already cover that Phase are offered.
 *
 * SUGGESTION, never selection. Leaving it on "no warrant" is a real choice
 * and takes the R2(b) auto-grant fallback — read-class access to the task
 * and the objects its record references, reaped when the task goes terminal
 * or is unassigned. There is no third option: an assignment carrying no
 * access at all is what the ruling makes unrepresentable.
 *
 * "Vehicle" stays in the identifiers and out of the labels (review bedc25f3
 * B1): it is descriptive prose in ruling 7440b579, not a declared noun, so
 * no heading or option text puts it in front of a reader.
 */
import { useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { Select } from '../ui/Select';
import { authenticatedFetch } from '../../utils/auth';
import './AccessVehicle.css';
import { formatDate } from '../../utils/dateFormat';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

export interface WarrantSuggestion {
  id: string;
  name: string;
  status: string;
  expiresAt: string | null;
  holderHandle: string | null;
}

interface Props {
  /** The Phase the task is being created in, if any. */
  phaseId: string | null;
  /** Whether an execution assignment is actually being made. */
  assigned: boolean;
  value: string | null;
  onChange: (warrantId: string | null) => void;
}

export default function AccessVehiclePicker({ phaseId, assigned, value, onChange }: Props) {
  const [suggestions, setSuggestions] = useState<WarrantSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!assigned || !phaseId) {
      setSuggestions([]);
      setUnavailable(false);
      return;
    }
    let live = true;
    setLoading(true);
    setUnavailable(false);
    authenticatedFetch(`${API_BASE}/warrants/suggestions?phaseId=${encodeURIComponent(phaseId)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('unavailable'))))
      .then((data) => {
        if (!live) return;
        setSuggestions(Array.isArray(data?.suggestions) ? data.suggestions : []);
      })
      .catch(() => {
        if (!live) return;
        // The suggestion is an affordance, not a gate: a session that cannot
        // read the warrant plane still creates the task and rides the
        // auto-grant fallback.
        setSuggestions([]);
        setUnavailable(true);
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [assigned, phaseId]);

  // Never leave a stale choice pointing at a warrant that is no longer on
  // offer — the server would refuse it, and silently is the wrong way to
  // find that out.
  useEffect(() => {
    if (value && !suggestions.some((suggestion) => suggestion.id === value)) onChange(null);
  }, [suggestions, value, onChange]);

  if (!assigned) return null;

  return (
    <div className="access-vehicle">
      <h3 className="access-vehicle-title"><ScrollText size={16} aria-hidden="true" /> Assignment access</h3>
      <p className="access-vehicle-hint">
        Assigning a Connector always carries the access it needs to see the Task. Choose a Warrant to
        carry it — its ceiling profile is assigned along the assignee&rsquo;s ownership chain and follows
        the published version — or leave it unset and the server grants read access to this Task and the
        objects it references, reaped when the Task finishes or is unassigned.
      </p>
      {!phaseId ? (
        <p className="access-vehicle-hint">
          Warrants are suggested per Phase. This Task has no Phase, so it takes the automatic grant.
        </p>
      ) : loading ? (
        <p className="access-vehicle-hint">Looking for warrants covering this Phase&hellip;</p>
      ) : unavailable ? (
        <p className="access-vehicle-hint">
          Warrants could not be read from here. The Task will take the automatic grant.
        </p>
      ) : suggestions.length === 0 ? (
        <p className="access-vehicle-hint">
          No live Warrant covers this Phase. The Task will take the automatic grant.
        </p>
      ) : (
        <label className="access-vehicle-field" htmlFor="access-vehicle-warrant">
          Warrant
          <Select
            id="access-vehicle-warrant"
            value={value ?? ''}
            onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">No warrant — automatic grant</option>
            {suggestions.map((suggestion) => (
              <option key={suggestion.id} value={suggestion.id}>
                {suggestion.name}
                {suggestion.holderHandle ? ` — held by ${suggestion.holderHandle}` : ''}
                {suggestion.expiresAt ? ` (expires ${formatDate(suggestion.expiresAt)})` : ''}
              </option>
            ))}
          </Select>
        </label>
      )}
    </div>
  );
}
