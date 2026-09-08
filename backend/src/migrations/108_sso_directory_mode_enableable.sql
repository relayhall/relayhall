-- 108: RH-P5.SSO.W4 candidate C — `directory` mode becomes enableable (SS-22 lifted).
--
-- Contract: design `d95136d7` §6.3 **SS-22** and §7.4 (SS-15 rung 2); wave brief
-- `4bbfe967` §2.8; packet `aa36da97` §2 candidate C; disposition `ec580913` §3
-- (card `c91d009b`). Owner ruling `6bdcc16c` §1 fixes what the producer writes.
--
-- ── THE SENTENCE, AND WHAT "LIFTED" MEANS ──
--
-- SS-22: "Until §7.4's rung supplies that producer, `directory` mode cannot be
-- enabled, refused at configuration time with a named error rather than
-- silently binding by whatever the sync happened to write."
--
-- Migration 104 put that refusal in the schema as
-- `identity_providers_directory_mode_not_yet_enableable`, and 106's header
-- promised to drop it "exactly when the producer is COMPLETE". The producer is
-- complete: candidate A supplies the arrival half (the SCIM endpoint), and
-- candidate B the binding half (the `expected` link with `externalId` as its
-- subject). This migration drops the "not yet" refusal.
--
-- ── WHAT IS NOT LIFTED: THE NAMED REFUSAL FOR MISCONFIGURATION ──
--
-- "Exactly when the producer exists" is a property of ONE Identity provider,
-- not of the codebase: the producer for an Identity provider exists when that
-- Identity provider has a SCIM client (migration 106's
-- `scim_client_principal_id`), because only that client can push the
-- expectations `directory` mode binds through. A directory-mode
-- Identity provider with no SCIM client would be enabled and unable to admit anyone —
-- every first login refused `SSO_ACCOUNT_UNAVAILABLE` — which is the silent
-- misconfiguration SS-22's named refusal exists to prevent. So the CHECK is
-- REPLACED rather than removed: `active` + `directory` requires a bound SCIM
-- client. `IdentityProviderService` turns the violation into the SAME named
-- error (`PROVIDER_DIRECTORY_MODE_UNAVAILABLE`) with a sentence that says what
-- to do, and refuses to clear the SCIM client of an enabled directory-mode
-- Identity provider for the same reason. The naive repair — delete the CHECK,
-- delete the branch — is the one the brief warns against.
--
-- Additive in effect (no row that satisfied 104 fails 108: an enabled
-- directory-mode row could not exist), replay-safe (DROP IF EXISTS, guarded
-- ADD CONSTRAINT), `database/init.sql` untouched; the CHECKs of 105–107 stand.

ALTER TABLE identity_providers
  DROP CONSTRAINT IF EXISTS identity_providers_directory_mode_not_yet_enableable;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'identity_providers_directory_mode_requires_scim_client'
  ) THEN
    ALTER TABLE identity_providers
      ADD CONSTRAINT identity_providers_directory_mode_requires_scim_client
      CHECK (status <> 'active' OR provisioning_mode <> 'directory' OR scim_client_principal_id IS NOT NULL);
  END IF;
END
$$;

COMMENT ON CONSTRAINT identity_providers_directory_mode_requires_scim_client ON identity_providers IS
  'SS-22, lifted by RH-P5.SSO.W4 candidate C: directory mode may be enabled exactly where its producer exists — this Identity provider''s SCIM client, which writes the expected Identity links directory mode binds through. The named refusal (PROVIDER_DIRECTORY_MODE_UNAVAILABLE) now guards MISCONFIGURATION: enabling directory mode without a SCIM client, or clearing the client of an enabled directory-mode Identity provider.';
