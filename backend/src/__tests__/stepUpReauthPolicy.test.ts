/**
 * Card 7a99d63e — step-up re-authentication on the open standards (owner
 * rulings E255-E257; design STEPUP-REAUTH clauses SU-4, SU-10, SU-14, SU-17),
 * the parts that need no database:
 *
 *   * `validateStepUpPolicy`, the ONE server-side validator of the Identity
 *     provider's `step_up_policy`, refuses each bad shape by name;
 *   * `stepUpRequestKnobs` turns a policy into the parameters a step-up
 *     request sends, and no policy is today's pair (`prompt=login`,
 *     `max_age=0`);
 *   * the step-up arm of the callback names a stale `auth_time`
 *     (`SSO_STEP_UP_NOT_FRESH`) while the login arm keeps the one collapsed
 *     `SSO_ID_TOKEN_REFUSED`;
 *   * a refused `stepUpService.consume` carries the RFC 9470-vocabulary
 *     challenge, and only a typed `StepUpError` ever produces one.
 *
 * The request URL, the audit rows and the routes are measured against a real
 * PostgreSQL in `stepUpSsoLive.test.ts` (`npm run test:step-up-sso`).
 */
import {
  IdentityProviderError,
  STEP_UP_MAX_AGE_MAX_SECONDS,
  STEP_UP_MAX_AGE_MIN_SECONDS,
  stepUpEnabledFor,
  stepUpRequestKnobs,
  validateStepUpPolicy,
} from '../services/identity/IdentityProviderService';
import { IdTokenError } from '../services/identity/idTokenValidation';
import { SsoAuthenticationError, STEP_UP_DECLINE_ERRORS } from '../services/identity/SsoAuthenticationService';
import { sendSsoRefusal, stepUpRefusalCode } from '../routes/sso';
import { StepUpError, stepUpChallengeBody, stepUpService } from '../services/StepUpService';

function refusalOf(value: unknown): string | null {
  try {
    validateStepUpPolicy(value);
    return null;
  } catch (error) {
    if (error instanceof IdentityProviderError) return error.code;
    throw error;
  }
}

describe('validateStepUpPolicy (SU-17): one validator, each refusal by name', () => {
  it('undefined leaves the policy alone and null clears it', () => {
    expect(validateStepUpPolicy(undefined)).toBeUndefined();
    expect(validateStepUpPolicy(null)).toBeNull();
  });

  it.each([
    [{}],
    [{ prompt_login: false, max_age: 30 }],
    [{ prompt_login: true, max_age: null }],
    [{ max_age: 0 }],
    [{ max_age: STEP_UP_MAX_AGE_MIN_SECONDS }],
    [{ max_age: STEP_UP_MAX_AGE_MAX_SECONDS }],
    [{ sso_step_up: 'disabled' }],
    [{ sso_step_up: 'disabled', prompt_login: false, max_age: null }],
    [{ sso_step_up: 'enabled', prompt_login: true, max_age: 0 }],
  ])('accepts %j and stores exactly the keys sent', (policy) => {
    expect(validateStepUpPolicy(policy)).toEqual(policy);
  });

  it('pins the max_age bounds the design states: null, 0, or 10..300', () => {
    expect(STEP_UP_MAX_AGE_MIN_SECONDS).toBe(10);
    expect(STEP_UP_MAX_AGE_MAX_SECONDS).toBe(300);
  });

  it.each([
    [{ max_age: 1 }, 'PROVIDER_STEP_UP_MAX_AGE_INVALID'],
    [{ max_age: 9 }, 'PROVIDER_STEP_UP_MAX_AGE_INVALID'],
    [{ max_age: 301 }, 'PROVIDER_STEP_UP_MAX_AGE_INVALID'],
    [{ max_age: -1 }, 'PROVIDER_STEP_UP_MAX_AGE_INVALID'],
    [{ max_age: 30.5 }, 'PROVIDER_STEP_UP_MAX_AGE_INVALID'],
    [{ max_age: '30' }, 'PROVIDER_STEP_UP_MAX_AGE_INVALID'],
    [{ prompt_login: false, max_age: null }, 'PROVIDER_STEP_UP_ASKS_NOTHING'],
    [{ prompt_login: 'false' }, 'PROVIDER_STEP_UP_POLICY_INVALID'],
    [{ sso_step_up: 'off' }, 'PROVIDER_STEP_UP_POLICY_INVALID'],
    [{ prompt: 'none' }, 'PROVIDER_STEP_UP_POLICY_INVALID'],
    [{ acr_values: ['phr'] }, 'PROVIDER_STEP_UP_POLICY_INVALID'],
    [{ amr_rungs: [['mfa']] }, 'PROVIDER_STEP_UP_POLICY_INVALID'],
    [{ when_unproven: 'accept_fresh' }, 'PROVIDER_STEP_UP_POLICY_INVALID'],
    [{ claims_request: true }, 'PROVIDER_STEP_UP_POLICY_INVALID'],
    [{ max_age: 30, padding: 'x'.repeat(5000) }, 'PROVIDER_STEP_UP_POLICY_INVALID'],
    [[], 'PROVIDER_STEP_UP_POLICY_INVALID'],
    ['max_age=30', 'PROVIDER_STEP_UP_POLICY_INVALID'],
    [30, 'PROVIDER_STEP_UP_POLICY_INVALID'],
  ])('refuses %j as %s', (policy, code) => {
    expect(refusalOf(policy)).toBe(code);
  });
});

describe('stepUpRequestKnobs (SU-4): what a step-up request sends', () => {
  it('no policy, or an empty one, is the default pair byte for byte', () => {
    expect(stepUpRequestKnobs(null)).toEqual({ prompt_login: true, max_age: 0 });
    expect(stepUpRequestKnobs({})).toEqual({ prompt_login: true, max_age: 0 });
  });

  it('carries each knob the policy sets, null meaning "not sent"', () => {
    expect(stepUpRequestKnobs({ prompt_login: false, max_age: 30 })).toEqual({ prompt_login: false, max_age: 30 });
    expect(stepUpRequestKnobs({ max_age: null })).toEqual({ prompt_login: true, max_age: null });
    expect(stepUpRequestKnobs({ prompt_login: false })).toEqual({ prompt_login: false, max_age: 0 });
  });

  it('only sso_step_up: disabled takes a provider out of step-up', () => {
    expect(stepUpEnabledFor({ stepUpPolicy: null })).toBe(true);
    expect(stepUpEnabledFor({ stepUpPolicy: { sso_step_up: 'enabled' } })).toBe(true);
    expect(stepUpEnabledFor({ stepUpPolicy: { sso_step_up: 'disabled' } })).toBe(false);
  });
});

describe('the step-up arm names its causes; the login arm does not (SU-10)', () => {
  function sent(error: unknown, codeOf?: (error: unknown) => string | null): { status: number; body: any } | null {
    const captured: { status: number; body: any } = { status: 0, body: null };
    const res = {
      status(code: number) { captured.status = code; return this; },
      json(body: unknown) { captured.body = body; return this; },
    };
    return sendSsoRefusal(res as never, error, codeOf) ? captured : null;
  }

  it('a stale auth_time is SSO_STEP_UP_NOT_FRESH on the step-up arm only', () => {
    const stale = new IdTokenError('AUTH_TIME_STALE', 'the ID token auth_time predates the step-up request');
    expect(stepUpRefusalCode(stale)).toBe('SSO_STEP_UP_NOT_FRESH');
    expect(sent(stale, stepUpRefusalCode)).toEqual({
      status: 400,
      body: { error: 'SSO refused', code: 'SSO_STEP_UP_NOT_FRESH', message: expect.stringContaining('reused an earlier sign-in') },
    });
    // The login arm (the default code function) keeps the one collapsed code.
    expect(sent(stale)?.body.code).toBe('SSO_ID_TOKEN_REFUSED');
  });

  it('every other ID-token refusal stays SSO_ID_TOKEN_REFUSED on both arms', () => {
    for (const code of ['SIGNATURE_INVALID', 'NONCE_MISMATCH', 'AUDIENCE_MISMATCH', 'REQUIRED_CLAIM_MISSING'] as const) {
      const refusal = new IdTokenError(code, 'refused');
      expect(stepUpRefusalCode(refusal)).toBe('SSO_ID_TOKEN_REFUSED');
      expect(sent(refusal)?.body.code).toBe('SSO_ID_TOKEN_REFUSED');
    }
  });

  it('the provider declining a step-up passes through by its own typed code', () => {
    const declined = new SsoAuthenticationError('SSO_STEP_UP_PROVIDER_DECLINED', 'declined');
    expect(stepUpRefusalCode(declined)).toBe('SSO_STEP_UP_PROVIDER_DECLINED');
    expect(sent(declined, stepUpRefusalCode)?.body.message).toBe(
      'the Identity provider declined to re-authenticate the person as the step-up asked',
    );
    expect(STEP_UP_DECLINE_ERRORS).toEqual(['login_required', 'interaction_required', 'unmet_authentication_requirements', 'access_denied']);
  });

  it('an untyped error is nobody\'s code', () => {
    expect(stepUpRefusalCode(new Error('AUTH_TIME_STALE'))).toBeNull();
    expect(sent(new Error('x'), stepUpRefusalCode)).toBeNull();
  });
});

describe('the STEP_UP_REQUIRED challenge (SU-14)', () => {
  it('a refused consume carries the binding it tried, freshness 0, and nothing else', async () => {
    const queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const refused = await stepUpService.consume(queryable, {
      token: 'rhsu_not-live', principalId: 'p-1', action: 'approval.decide', targetId: 'approval-1',
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StepUpError);
    expect(refused).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    // Card 72b8fb97 (review r1 change 2), repaired BY NAME: the challenge's
    // methods are now read on the client handed to consume, and this test's
    // client answers no password credential and no enabled provider.
    expect(stepUpChallengeBody(refused)).toEqual({
      stepUp: { error: 'insufficient_user_authentication', action: 'approval.decide', targetId: 'approval-1', max_age: 0, methods: [] },
    });
    expect(JSON.stringify(stepUpChallengeBody(refused))).not.toContain('rhsu_');
  });

  it('a StepUpError raised without a challenge, or any other error, adds nothing', () => {
    expect(stepUpChallengeBody(new StepUpError(403, 'STEP_UP_REQUIRED', 'x'))).toEqual({});
    expect(stepUpChallengeBody(new Error('STEP_UP_REQUIRED'))).toEqual({});
    expect(stepUpChallengeBody({ challenge: { error: 'insufficient_user_authentication' } })).toEqual({});
  });
});
