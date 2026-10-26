import React, { useCallback, useState } from 'react';
import { StepUpDialog } from './StepUpDialog';
import type { StepUpChallenge } from '../../utils/stepUpChallenge';

/**
 * The second ask of the SU-33 retry (card 72b8fb97, design SU-33).
 *
 * `sendWithStepUpRetry` needs a way to ask the person for ONE more token when
 * the act answers `403 STEP_UP_REQUIRED` with the SU-14 challenge. A surface
 * that owns its own dialog state uses this hook: `askForToken` opens the
 * dialog for exactly the challenge's action and target and resolves with the
 * collected token, or with null when the person cancels; `retryDialog` is the
 * element to render. It never asks twice for one call: the helper calls it at
 * most once. Card f5a70765: the dialog is handed the methods the challenge
 * advertised, its fallback when the board's methods read fails.
 */
export const STEP_UP_RETRY_DESCRIPTION =
  'Your confirmation was no longer valid when the request arrived. Confirm it is you once more to finish it.';

interface PendingAsk {
  challenge: StepUpChallenge;
  resolve: (token: string | null) => void;
}

export function useStepUpRetry(description: string = STEP_UP_RETRY_DESCRIPTION): {
  askForToken: (challenge: StepUpChallenge) => Promise<string | null>;
  retryDialog: React.ReactElement | null;
} {
  const [pending, setPending] = useState<PendingAsk | null>(null);
  const askForToken = useCallback(
    (challenge: StepUpChallenge) => new Promise<string | null>((resolve) => setPending({ challenge, resolve })),
    [],
  );
  const retryDialog = pending ? (
    <StepUpDialog
      action={pending.challenge.action}
      targetId={pending.challenge.targetId}
      advertisedMethods={pending.challenge.methods}
      description={description}
      onToken={(token) => { setPending(null); pending.resolve(token); }}
      onCancel={() => { setPending(null); pending.resolve(null); }}
    />
  ) : null;
  return { askForToken, retryDialog };
}
