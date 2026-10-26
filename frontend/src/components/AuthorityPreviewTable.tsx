import React from 'react';
export interface AuthorityPreviewData {
  needsCredential?: boolean;
  envelope?: { alive: boolean; transport: string; scopes: string[] };
  resources?: Array<{ id: string; actions: Array<{ action: string; sources: string[] }> }>;
  hasMore?: boolean;
  inventoryTruncated?: boolean;
}
const basisLabels: Record<string, string> = {
  'bound-task-context': 'Assigned task context', claimant: 'Task assignee', shepherd: 'Task shepherd',
  verifier: 'Task verifier', initiator: 'Created or initiated', 'task-evidence-reader': 'Task evidence reader',
  'assigned-connector-claim': 'Assigned connector', 'role-grant': 'Automatic role grant',
  'delegation-chain': 'Authority through parent and connector limits', 'grant-or-profile': 'Grant or access profile',
  visibility: 'Object visibility', owner: 'Object owner', root: 'Root authority', administrator: 'Administrator role',
  grant: 'Grant', profile: 'Access profile', 'inherited-project-grant': 'Inherited project grant',
  'legacy-verifier': 'Legacy verifier role',
  'account-owner': 'Owning account', 'account-administrator': 'Parent account administrator',
};
export const AuthorityPreviewTable: React.FC<{ access: AuthorityPreviewData }> = ({ access }) => (
  <div aria-label="Current authority preview">
    {access.needsCredential ? <p role="status">Choose a credential to preview this connector or agent.</p> : <>
      <p>Current object permissions within the scope ceiling. Transport limits, task state and approvals still apply when an action runs.</p>
      {access.envelope && <p>Authority: {access.envelope.alive ? 'active' : 'inactive'} · Connection: {access.envelope.transport}</p>}
      {!access.resources?.length ? <p>No permitted objects in this page.</p> : <table className="axm-preview-table">
        <caption>Live object permissions and their sources</caption>
        <thead><tr><th scope="col">Object</th><th scope="col">Action</th><th scope="col">Source</th></tr></thead>
        <tbody>{access.resources.flatMap(resource => resource.actions.map(action => (
          <tr key={`${resource.id}:${action.action}`}><td><code>{resource.id}</code></td><td>{action.action}</td>
            <td>{action.sources.map(source => basisLabels[source] ?? source).join(', ')}</td></tr>
        )))}</tbody>
      </table>}
    </>}
    {access.inventoryTruncated && <p role="status">Stored source inventory is limited to 50 grants and 50 profile rules.</p>}
  </div>
);
