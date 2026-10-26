import React from 'react';
import { ConfirmationModal } from '../ConfirmationModal';
import { RoleSelectionExplanation } from './RoleExplanation';
import { principalLabel } from './accessShared';
import type { RoleCatalogueState } from '../../hooks/useRoleCatalogue';
import type { Principal } from '../../types/task';
import { authenticatedFetch } from '../../utils/auth';
import { readStepUpChallenge, type StepUpChallenge } from '../../utils/stepUpChallenge';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

/**
 * THE ROLE ACT, SHARED BY ITS TWO DOORS (card caea70ef).
 *
 * The Access manager's Roles panel is the bulk view: pick any Account, give it
 * a role. The identity detail page offers the same act on the one identity it
 * shows. Both are the GUI seam onto `POST /principals/:id/role`, and both now
 * call the three pieces below, so they cannot come to offer different targets,
 * send different bodies or confirm in different words.
 *
 * The server is the authority. It decides who may change a role (an
 * administrator login session, `administratorSessionOf`), what they may assign
 * (`canAssignRole`) and which targets it refuses by name, and it audits every
 * attempt. Nothing here widens or narrows that rule.
 */

/**
 * Whether the act can be offered on this identity: never the caller's own row
 * (no self-promotion, and no self-demotion either), and never the two
 * identities the route refuses by name — `system`, the request-less internal
 * actor, and the break-glass local administrator, whose role is fixed so the
 * deployment always has a way back in.
 */
export function isRoleChangeTarget(principal: Principal, ownPrincipalId: string | null | undefined): boolean {
  return principal.id !== ownPrincipalId
    && principal.handle !== 'system'
    && principal.handle !== 'dashboard_user';
}

/** Why the act is not offered on an identity `isRoleChangeTarget` refuses. */
export function roleChangeRefusalReason(principal: Principal, ownPrincipalId: string | null | undefined): string | null {
  if (principal.id === ownPrincipalId) return 'Your own role is not changed from your own session: the route refuses it.';
  if (principal.handle === 'system') return 'The internal system actor carries a fixed role: the route refuses it by name.';
  if (principal.handle === 'dashboard_user') {
    return 'The break-glass identity carries a fixed role, so the deployment always has a way back in: the route refuses it by name.';
  }
  return null;
}

/** What the step-up dialog says when the board asks for one on this act. */
export const ROLE_CHANGE_STEP_UP_DESCRIPTION =
  'The board asks you to confirm it is you before it changes this role.';

/**
 * Send the role act. The first request carries ONLY the role: the server rule
 * today asks for an administrator login session and no step-up, so nothing is
 * minted and nothing is burnt. If the board answers with the step-up challenge
 * (`403 STEP_UP_REQUIRED`, SU-14) for THIS identity, the existing step-up
 * dialog collects one token for exactly the challenged binding and the act is
 * repeated once with it; a challenge for any other target is not answered.
 * Resolves with the server's answer; a refusal rejects with the server's own
 * sentence.
 */
export async function sendRoleChange(
  principalId: string,
  role: string,
  askForToken: (challenge: StepUpChallenge) => Promise<string | null>,
): Promise<{ note?: string; principal?: Principal } & Record<string, unknown>> {
  const send = async (stepUpToken?: string) => {
    const response = await authenticatedFetch(`${API_BASE}/principals/${encodeURIComponent(principalId)}/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stepUpToken ? { role, stepUpToken } : { role }),
    });
    const body = await response.json().catch(() => ({}));
    return { response, body: (body ?? {}) as Record<string, any> };
  };

  let answer = await send();
  const challenge = readStepUpChallenge(answer.response.status, answer.body);
  if (challenge && challenge.targetId.toLowerCase() === principalId.toLowerCase()) {
    const token = await askForToken(challenge);
    if (token) answer = await send(token);
  }
  if (!answer.response.ok || answer.body.success === false) {
    throw new Error(answer.body.message || answer.body.error || `Request failed (${answer.response.status})`);
  }
  return answer.body;
}

/** The sentence a successful act reports: the server's own, when it gave one. */
export function roleChangeNotice(answer: { note?: string; principal?: Principal }): string {
  return answer.note || `${answer.principal?.handle} now carries the role ${answer.principal?.role}.`;
}

/**
 * The confirmation the act asks for (card a2d1e317): it names the Account,
 * the role it carries now and the role it will carry, and shows the new
 * role's catalogue entry, so the person reads what they are giving before the
 * request is sent.
 */
export const RoleChangeConfirmation: React.FC<{
  principal: Principal;
  role: string;
  catalogue: RoleCatalogueState;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}> = ({ principal, role, catalogue, onConfirm, onCancel }) => (
  <ConfirmationModal
    title="Change role?"
    confirmLabel="Change role"
    message={(
      <>
        <p>
          {principalLabel(principal)} carries the role {principal.role || 'none'} now. From their next
          request they will carry <strong>{role}</strong>:
        </p>
        <RoleSelectionExplanation
          catalogue={catalogue}
          role={role}
          emptyText="This role is not in the role catalogue."
        />
      </>
    )}
    onConfirm={onConfirm}
    onCancel={onCancel}
  />
);
