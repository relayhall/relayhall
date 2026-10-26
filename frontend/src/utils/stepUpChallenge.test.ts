/**
 * The step-up challenge helper — card 7a99d63e (design SU-14, SU-33).
 *
 * Pinned: only a `403 STEP_UP_REQUIRED` carrying a well-formed `stepUp`
 * object is a challenge; the helper asks for a token for exactly the binding
 * the caller expected and repeats the act ONCE; a cancelled dialog, a plain
 * 403, a 401, another binding and a second challenge each end it with the
 * answer in hand, never another request.
 */
import { describe, expect, test, vi } from 'vitest';
import { readStepUpChallenge, sendWithStepUpRetry } from './stepUpChallenge';

const BINDING = { action: 'approval.decide', targetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
const CHALLENGE_BODY = {
  error: 'Refused',
  code: 'STEP_UP_REQUIRED',
  message: 'This act requires a live single-use step-up token',
  stepUp: { error: 'insufficient_user_authentication', ...BINDING, max_age: 0 },
};

function answer(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

describe('readStepUpChallenge', () => {
  test('reads the challenge a refused act answers with', () => {
    expect(readStepUpChallenge(403, CHALLENGE_BODY)).toEqual(BINDING);
  });

  test.each([
    ['a 401 (a dead session, never a step-up)', 401, CHALLENGE_BODY],
    ['a 400', 400, CHALLENGE_BODY],
    ['a plain 403 with no stepUp object', 403, { code: 'STEP_UP_REQUIRED', message: 'x' }],
    ['another code', 403, { ...CHALLENGE_BODY, code: 'SESSION_ONLY' }],
    ['another error word', 403, { ...CHALLENGE_BODY, stepUp: { ...CHALLENGE_BODY.stepUp, error: 'invalid_token' } }],
    ['an empty action', 403, { ...CHALLENGE_BODY, stepUp: { ...CHALLENGE_BODY.stepUp, action: '' } }],
    ['a non-string target', 403, { ...CHALLENGE_BODY, stepUp: { ...CHALLENGE_BODY.stepUp, targetId: 42 } }],
    ['an over-long action', 403, { ...CHALLENGE_BODY, stepUp: { ...CHALLENGE_BODY.stepUp, action: 'a'.repeat(129) } }],
    ['no body', 403, null],
  ])('is not a challenge: %s', (_label, status, body) => {
    expect(readStepUpChallenge(status as number, body)).toBeNull();
  });

  // Card f5a70765: the challenge's `methods` member (SU-14, card 72b8fb97)
  // travels with it, so the dialog it opens knows what THIS challenge named.
  test('carries the methods the challenge advertised, known values only', () => {
    expect(readStepUpChallenge(403, { ...CHALLENGE_BODY, stepUp: { ...CHALLENGE_BODY.stepUp, methods: ['sso'] } }))
      .toEqual({ ...BINDING, methods: ['sso'] });
    expect(readStepUpChallenge(403, { ...CHALLENGE_BODY, stepUp: { ...CHALLENGE_BODY.stepUp, methods: ['password', 'sso', 'magic', 7] } }))
      .toEqual({ ...BINDING, methods: ['password', 'sso'] });
    expect(readStepUpChallenge(403, { ...CHALLENGE_BODY, stepUp: { ...CHALLENGE_BODY.stepUp, methods: 'sso' } }))
      .toEqual(BINDING);
  });
});

describe('sendWithStepUpRetry', () => {
  test('a challenge for the expected binding asks once and repeats the act once, with the new token', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(answer(403, CHALLENGE_BODY))
      .mockResolvedValueOnce(answer(200, { success: true }));
    const ask = vi.fn().mockResolvedValue('rhsu_second');
    const result = await sendWithStepUpRetry(send, 'rhsu_first', BINDING, ask);
    expect(send.mock.calls.map((call) => call[0])).toEqual(['rhsu_first', 'rhsu_second']);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(BINDING);
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ success: true });
  });

  test('a second challenge is returned, never retried again', async () => {
    const send = vi.fn().mockResolvedValue(answer(403, CHALLENGE_BODY));
    const ask = vi.fn().mockResolvedValue('rhsu_again');
    const result = await sendWithStepUpRetry(send, 'rhsu_first', BINDING, ask);
    expect(send).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(403);
  });

  test('a cancelled dialog ends it with the first answer', async () => {
    const send = vi.fn().mockResolvedValue(answer(403, CHALLENGE_BODY));
    const ask = vi.fn().mockResolvedValue(null);
    const result = await sendWithStepUpRetry(send, 'rhsu_first', BINDING, ask);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.body).toEqual(CHALLENGE_BODY);
  });

  test.each([
    ['success', 200, { success: true }],
    ['a plain 403', 403, { code: 'SESSION_ONLY' }],
    ['a 401', 401, CHALLENGE_BODY],
    ['a challenge for ANOTHER binding', 403, { ...CHALLENGE_BODY, stepUp: { ...CHALLENGE_BODY.stepUp, targetId: 'another' } }],
  ])('%s asks nothing and sends nothing more', async (_label, status, body) => {
    const send = vi.fn().mockResolvedValue(answer(status as number, body));
    const ask = vi.fn();
    const result = await sendWithStepUpRetry(send, 'rhsu_first', BINDING, ask);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
    expect(result.response.status).toBe(status);
  });

  test('a body that is not JSON is carried as null', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
    const result = await sendWithStepUpRetry(send, 'rhsu_first', BINDING, vi.fn());
    expect(result.body).toBeNull();
  });
});
