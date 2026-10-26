-- Card a3e76724 — step-up re-authentication through the Identity provider.
--
-- An Account that signs in only through the Identity provider holds no
-- password credential, so the password re-entry `POST /auth/step-up` asks for
-- is a proof it cannot give: every step-up-gated act (approval decisions,
-- warrant creation, credential re-reveal, the session Agent mint) was out of
-- its reach.
--
-- The repair binds a step-up to a pending relying-party request. The row the
-- callback already consumes on the attempt (SS-18) now also NAMES the Account,
-- the action and the target the step-up is for, so the proof the Identity
-- provider returns can only ever satisfy the step-up that asked for it:
--
--   * `step_up_principal_id` / `step_up_action` / `step_up_target_id` — the
--     binding, written by the server from the calling login session at start.
--     Never a caller-composed value: the Account is the session's own.
--   * `step_up_proven_at` — set by the callback only when the returned
--     `auth_time` is no older than `requested_at` (refusal 9, unchanged) AND
--     the subject resolves to THE SAME Account through a proven Identity link.
--   * `step_up_collected_at` — set once, by one conditional UPDATE, when the
--     same Account exchanges the proof for a single-use step-up token
--     (`step_up_tokens.method = 'oidc'`, the value 096 already enumerates).
--
-- No secret is added: the step-up token is minted at collection and returned
-- once, exactly as the password path returns it. Nothing about a login row
-- changes — every new column is NULL for it, and the CHECK below says so.
ALTER TABLE sso_authentication_requests
  ADD COLUMN IF NOT EXISTS step_up_principal_id UUID REFERENCES principals(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS step_up_action TEXT,
  ADD COLUMN IF NOT EXISTS step_up_target_id TEXT,
  ADD COLUMN IF NOT EXISTS step_up_proven_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS step_up_collected_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sso_auth_requests_step_up_binding'
  ) THEN
    ALTER TABLE sso_authentication_requests
      ADD CONSTRAINT sso_auth_requests_step_up_binding CHECK (
        (step_up_principal_id IS NULL AND step_up_action IS NULL AND step_up_target_id IS NULL
          AND step_up_proven_at IS NULL AND step_up_collected_at IS NULL)
        OR (step_up_principal_id IS NOT NULL AND step_up_action IS NOT NULL AND step_up_target_id IS NOT NULL
          -- A step-up row always forced a fresh authentication (§8.3).
          AND max_age_requested IS NOT DISTINCT FROM 0
          -- A proof is collected at most after it exists.
          AND (step_up_collected_at IS NULL OR step_up_proven_at IS NOT NULL))
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_sso_auth_requests_step_up_principal
  ON sso_authentication_requests(step_up_principal_id)
  WHERE step_up_principal_id IS NOT NULL;

COMMENT ON COLUMN sso_authentication_requests.step_up_principal_id IS
  'Card a3e76724: the Account a step-up re-authentication is FOR. NULL on a login row. The callback proves a step-up only when the returned subject resolves to this same Account.';
