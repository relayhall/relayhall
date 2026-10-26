/**
 * The refusal a board gives when it is asked for a credential and has no
 * credential key set.
 *
 * Credential secrets are encrypted under `RELAYHALL_CREDENTIAL_KEYS` /
 * `RELAYHALL_CREDENTIAL_ACTIVE_KEY` (`utils/credentialCrypto`). `./setup.sh`
 * generates them into `relayhall.keys.env`, which Compose passes to the
 * backend; an install made before it did, or one that lost that file, has
 * none, and the first credential it is asked for cannot be stored. That is a
 * configuration state of the server, not a fault in the request, so it is a
 * named 503 whose message tells the operator what to run, rather than the
 * anonymous 500 whose only clue was a line in the backend log.
 *
 * ONLY the missing key set is mapped. A malformed key set, an unknown key or a
 * failed decryption is a different fault with a different repair (and a
 * regenerated key would make stored secrets unreadable), so those keep the
 * generic envelope and their log line.
 */
import { CredentialCryptoError } from './credentialCrypto';

export const CREDENTIAL_KEYS_NOT_CONFIGURED = 'CREDENTIAL_KEYS_NOT_CONFIGURED';

export const CREDENTIAL_KEYS_NOT_CONFIGURED_MESSAGE =
  'This server has no credential key set, so it cannot issue a credential and nothing was created. '
  + 'On the server, run ./setup.sh and answer "no" to keep the existing configuration (it adds the '
  + 'missing key sets and changes nothing else), then restart the backend: docker compose up -d --wait.';

export function credentialKeysRefusal(e: unknown): { status: 503; code: string; message: string } | null {
  if (e instanceof CredentialCryptoError && e.code === 'CREDENTIAL_KEYSET_MISSING') {
    return { status: 503, code: CREDENTIAL_KEYS_NOT_CONFIGURED, message: CREDENTIAL_KEYS_NOT_CONFIGURED_MESSAGE };
  }
  return null;
}
