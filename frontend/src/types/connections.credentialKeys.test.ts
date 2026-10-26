import { describe, expect, test } from 'vitest';
import { connectionRefusalMessage } from './connections';

/**
 * A board with no credential key set refuses the first credential with
 * `503 CREDENTIAL_KEYS_NOT_CONFIGURED` (backend `utils/credentialKeysRefusal`).
 * The wizard and the Create identity flow say what that means and who can fix
 * it, in their own words: the server's operator runs `./setup.sh`, answers
 * "no", and restarts the backend. Nothing was created, so nobody should go
 * looking for a half-made connection.
 */
describe('CREDENTIAL_KEYS_NOT_CONFIGURED', () => {
  const said = connectionRefusalMessage(503, {
    code: 'CREDENTIAL_KEYS_NOT_CONFIGURED',
    message: 'an invented server sentence',
  });

  test('is a named sentence, not the server text', () => {
    expect(said).not.toBe('an invented server sentence');
    expect(said).not.toBe('The board refused the request. Nothing was created.');
  });

  test('names the fix and who makes it', () => {
    expect(said).toMatch(/\.\/setup\.sh/);
    expect(said).toMatch(/"no"/);
    expect(said).toMatch(/restart/i);
    expect(said).toMatch(/runs this server|server's operator|runs the server/);
  });

  test('says nothing was created', () => {
    expect(said).toMatch(/[Nn]othing was created/);
  });
});
