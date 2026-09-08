/**
 * TaskAccessVehicle — RH-P3.AZ-S7 (owner ruling 7440b579 R5): the
 * "task → its vehicle" half of the two-way linkage.
 *
 * Shows WHAT carries this assignment's access: the Warrant if one does, and
 * the grant / profile-assignment rows it depends on. Each row says whether
 * this machinery CREATED it — because a row it did not create is a row it
 * will never delete (owner default D4), and that distinction is the whole
 * reason the owner plane can trust it near its own configuration.
 *
 * "Vehicle" stays in the identifiers and out of the labels (review bedc25f3
 * B1): it is descriptive prose in ruling 7440b579, not a declared noun.
 */
import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import './AccessVehicle.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

interface VehicleLink {
  id: string;
  carriedBy: 'warrant' | 'grant';
  warrantName: string | null;
  targetKind: 'grant' | 'profile_assignment';
  createdByAssignment: boolean;
  landedOnHandle: string | null;
  resourceType: string | null;
  resourceId: string | null;
  verb: string | null;
  profileName: string | null;
}

interface VehicleAssignment {
  executionServiceId: string | null;
  executionServiceName: string | null;
  carriedBy: 'warrant' | 'grant' | null;
  warrantName: string | null;
  warrantStatus: string | null;
}

export default function TaskAccessVehicle({ taskId }: { taskId: string }) {
  const [assignment, setAssignment] = useState<VehicleAssignment | null>(null);
  const [links, setLinks] = useState<VehicleLink[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    setReady(false);
    authenticatedFetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/assignment-access`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('unavailable'))))
      .then((data) => {
        if (!live) return;
        setAssignment(data?.assignment ?? null);
        setLinks(Array.isArray(data?.links) ? data.links : []);
        setReady(true);
      })
      .catch(() => { if (live) { setAssignment(null); setLinks([]); setReady(true); } });
    return () => { live = false; };
  }, [taskId]);

  // An unassigned Task has no vehicle to show, and neither does a reader who
  // cannot see this surface. Render nothing rather than an empty box.
  if (!ready || !assignment?.executionServiceId) return null;

  return (
    <div className="access-vehicle">
      <h3 className="access-vehicle-title"><KeyRound size={16} aria-hidden="true" /> Assignment access</h3>
      <p className="access-vehicle-hint">
        {assignment.carriedBy === 'warrant' ? (
          <>
            Assigned to <strong>{assignment.executionServiceName}</strong>, carried by the Warrant{' '}
            <strong>{assignment.warrantName}</strong>
            {assignment.warrantStatus && assignment.warrantStatus !== 'active'
              ? ` (${assignment.warrantStatus})`
              : ''}
            . Revoking that Warrant unassigns this Task.
          </>
        ) : (
          <>
            Assigned to <strong>{assignment.executionServiceName}</strong> with automatic read access to
            this Task and the objects it references. It is released when the Task finishes or is
            unassigned.
          </>
        )}
      </p>
      {links.length === 0 ? (
        <p className="access-vehicle-hint">
          The assignee already reaches this Task without any grant of its own.
        </p>
      ) : (
        <ul className="access-vehicle-list">
          {links.map((link) => (
            <li key={link.id} className="access-vehicle-row">
              <span className="access-vehicle-badge">
                {link.targetKind === 'grant' ? 'grant' : 'profile'}
              </span>
              {link.targetKind === 'grant' ? (
                <span>
                  <code>{link.verb}</code> on {link.resourceType}{' '}
                  <code>{link.resourceId ? link.resourceId.slice(0, 8) : 'all'}</code>
                </span>
              ) : (
                <span>profile &ldquo;{link.profileName}&rdquo;</span>
              )}
              {link.landedOnHandle && <span>held by <code>{link.landedOnHandle}</code></span>}
              {!link.createdByAssignment && (
                <span className="access-vehicle-owned">
                  pre-existing — this assignment only depends on it, and will not remove it
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
