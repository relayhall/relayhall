/**
 * The step-up challenge (card 7a99d63e, design SU-14 and SU-33).
 *
 * A step-up-gated act that finds no live token answers `403
 * STEP_UP_REQUIRED` with a `stepUp` object in the vocabulary of RFC 9470:
 * `{ error: "insufficient_user_authentication", action, targetId, max_age: 0 }`.
 * It carries no capability: it names the binding the act just tried. This
 * helper reads it, asks the person to step up for exactly that binding, and
 * repeats the act ONCE with the token the dialog collected. It never retries
 * twice, never on any status but 403, and never for a binding other than the
 * one the caller expected, so a provider that keeps refusing cannot loop it.
 */

export interface StepUpChallenge {
  action: string;
  targetId: string;
  /**
   * Card f5a70765: the proofs the challenge said the caller's Account can
   * give (SU-14 `methods`, card 72b8fb97), known values only; absent when the
   * challenge carried none. The dialog asks the board afresh and falls back
   * to these only when that read fails.
   */
  methods?: Array<'password' | 'sso'>;
}

const MAX_ACTION_LENGTH = 128;
const MAX_TARGET_LENGTH = 256;

/** The challenge in a refused act's answer, validated field by field, or null. */
export function readStepUpChallenge(status: number, body: unknown): StepUpChallenge | null {
  if (status !== 403 || !body || typeof body !== 'object') return null;
  const answer = body as Record<string, unknown>;
  if (answer.code !== 'STEP_UP_REQUIRED') return null;
  const stepUp = answer.stepUp;
  if (!stepUp || typeof stepUp !== 'object') return null;
  const challenge = stepUp as Record<string, unknown>;
  if (challenge.error !== 'insufficient_user_authentication') return null;
  const { action, targetId } = challenge;
  if (typeof action !== 'string' || action.length === 0 || action.length > MAX_ACTION_LENGTH) return null;
  if (typeof targetId !== 'string' || targetId.length === 0 || targetId.length > MAX_TARGET_LENGTH) return null;
  if (!Array.isArray(challenge.methods)) return { action, targetId };
  const methods = (challenge.methods as unknown[])
    .filter((value): value is 'password' | 'sso' => value === 'password' || value === 'sso');
  return { action, targetId, methods };
}

export interface StepUpAttempt {
  response: Response;
  /** The parsed answer, or null when it was not JSON. */
  body: unknown;
}

async function attempt(send: (stepUpToken: string) => Promise<Response>, token: string): Promise<StepUpAttempt> {
  const response = await send(token);
  const body = await response.json().catch(() => null);
  return { response, body };
}

/**
 * Send the act with `firstToken`; if it answers the step-up challenge for
 * `expected`, ask for a new token for that binding (null = the person
 * cancelled) and send it once more. The second answer is returned whatever
 * it is; so is the first, when there is no challenge or no new token.
 */
export async function sendWithStepUpRetry(
  send: (stepUpToken: string) => Promise<Response>,
  firstToken: string,
  expected: StepUpChallenge,
  askForToken: (challenge: StepUpChallenge) => Promise<string | null>,
): Promise<StepUpAttempt> {
  const first = await attempt(send, firstToken);
  const challenge = readStepUpChallenge(first.response.status, first.body);
  if (!challenge || challenge.action !== expected.action || challenge.targetId !== expected.targetId) return first;
  const token = await askForToken(challenge);
  if (!token) return first;
  return attempt(send, token);
}
