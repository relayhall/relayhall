-- Card 7a99d63e — step-up re-authentication on the open standards (owner
-- rulings E255, E256, E257; design STEPUP-REAUTH clauses SU-4, SU-9, SU-17;
-- reserved in backend/src/migrations/RESERVED as slot 153 before this file
-- was written).
--
-- A step-up asks the Identity provider for a FRESH authentication. Until now
-- the question was fixed: `prompt=login` and `max_age=0` on every step-up
-- request (design `d95136d7` §8.3). Providers disagree about which standard
-- question they honour: one ignores `max_age=0` and honours `prompt=login`
-- only once per provider session, while honouring a positive `max_age` every
-- time. The callback's acceptance never depended on the provider honouring
-- the question (refusal 9 compares `auth_time` with the row's `requested_at`,
-- no skew), so a stale answer was refused, correctly, and the person had no
-- way on.
--
-- This migration adds the one place a deployment can say which standard
-- question to ask THIS provider:
--
--   * `identity_providers.step_up_policy` — nullable JSONB, written only
--     through the root-gated `/identity-providers` owner-plane family and
--     validated there (`validateStepUpPolicy`). NULL is today's request byte
--     for byte. The CHECK below is the floor under that validator: whatever
--     is stored is a JSON object, never a scalar or an array.
--
-- And it states, as a column comment, a reinterpretation the design declares
-- (SU-9): for a step-up row `max_age_requested` stays 0 whatever the policy
-- sends, because it records the freshness RelayHall ENFORCES (zero tolerance
-- relative to `requested_at`), not a parameter on the wire. Migration 140's
-- CHECK `sso_auth_requests_step_up_binding` therefore holds unchanged. No
-- migration before this one carried a comment on that column.
--
-- Nothing about the acceptance changes, no existing column changes, and no
-- row is rewritten.
ALTER TABLE identity_providers
  ADD COLUMN IF NOT EXISTS step_up_policy JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'identity_providers_step_up_policy_object'
  ) THEN
    ALTER TABLE identity_providers
      ADD CONSTRAINT identity_providers_step_up_policy_object CHECK (
        step_up_policy IS NULL OR jsonb_typeof(step_up_policy) = 'object'
      );
  END IF;
END $$;

COMMENT ON COLUMN identity_providers.step_up_policy IS
  'Card 7a99d63e (SU-17): how a step-up asks THIS Identity provider for a fresh authentication. NULL = the default request, prompt=login and max_age=0. Written only through the root-gated /identity-providers family and validated there; it changes what the provider is ASKED, never the acceptance (auth_time no earlier than requested_at, no skew).';

COMMENT ON COLUMN sso_authentication_requests.max_age_requested IS
  'NULL on a plain login row. On a row that forces a fresh authentication (every step-up row) always 0: the freshness RelayHall ENFORCES (auth_time no earlier than requested_at, no skew), whatever max_age the provider step_up_policy put on the wire (card 7a99d63e, SU-9). The parameters actually sent are recorded in the step-up audit rows.';
