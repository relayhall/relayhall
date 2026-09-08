/*
 * DRIFT CONTROL — the form's purpose refusal must be the board's own sentence.
 *
 * Defect `43fcd071` was a form that never asked for a purpose while
 * `POST /principals` required one, so Kind = Service answered a red banner
 * nobody could act on. The repair refuses in the form BEFORE the request, which
 * only helps while the two wordings agree: a client-side refusal that says one
 * thing and a server that says another is the same defect wearing a hat.
 *
 * `PURPOSE_REQUIRED_MESSAGE` is therefore a declared mirror of the A17.1
 * message in `backend/src/routes/principals.ts`, and this test fails the build
 * when the route stops saying it. It follows the estate's existing cross-package
 * pattern (`connectionReservedSlugDrift.test.ts` reads a backend module;
 * `acceptanceContracts.test.ts` reads `../../docker-compose.yml`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PURPOSE_MAX_LENGTH, PURPOSE_REQUIRED_MESSAGE } from './types/identities';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = join(HERE, '../../backend/src/routes/principals.ts');

describe('the A17.1 purpose rule, mirrored', () => {
  const source = readFileSync(ROUTE, 'utf8');

  it('the route still emits the sentence the form refuses with', () => {
    // A NEGATIVE CONTROL FIRST: the source really was read, so a mistyped path
    // cannot make every assertion below vacuously true.
    expect(source).toContain('PURPOSE_REQUIRED');
    expect(source).toContain(PURPOSE_REQUIRED_MESSAGE);
  });

  it('the route still refuses a purpose longer than the form allows', () => {
    expect(source).toContain(`purpose.length > ${PURPOSE_MAX_LENGTH}`);
  });

  it('the route still refuses kind=agent, which is why the Agent arm is a connection', () => {
    // If `POST /principals` ever accepted an Agent, the wizard's Agent arm would
    // be a choice rather than the only path, and this file should be revisited
    // rather than silently left describing a rule that moved.
    expect(source).toContain('AGENT_MINT_ONLY');
  });
});
