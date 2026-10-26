/**
 * The first thing the backend's entry point loads (`server.ts`, line one).
 *
 * It refuses to start on the `.env.example` placeholder secrets with a plain
 * message on stderr and exit status 1. It must run before anything else: the
 * modules `server.ts` loads afterwards read `JWT_SECRET` at import time, and
 * once `server.ts` has installed its process-wide exception handler, a throw
 * from an import is logged only by class (the secret-safe logger never prints
 * a message) and the process exits 0 with nothing listening, which a restart
 * policy then repeats forever. A first-loaded module that exits explicitly is
 * the one place the reason reaches the operator.
 *
 * `getJwtSecret()` and the database module refuse the same placeholders on
 * their own, for every other entry point (migrations, scripts).
 */
import dotenv from 'dotenv';
import { placeholderSecretRefusals } from './placeholderSecrets';

dotenv.config();

const refusals = placeholderSecretRefusals(process.env);
if (refusals.length > 0) {
  for (const refusal of refusals) process.stderr.write(`${refusal}\n`);
  process.exit(1);
}
