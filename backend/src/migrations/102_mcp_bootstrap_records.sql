-- 102: RH-P3.C4 subtask [1] — the fail-closed bootstrap record.
--
-- Contract: strategy 4e40f06f §2.10 ("Fail-closed bootstrap, server-enforced
-- [RATIFIED 2026-08-02 — C2]: work-plane tool calls from a session that has
-- not bootstrapped return 'bootstrap first' with the index inline — one
-- middleware check that kills the silent-skip hole"), owner decision D2 in
-- run packet 3e6ec75a: the record is KEYED ON CREDENTIAL ID with a TTL.
--
-- WHY THE CREDENTIAL AND NOT AN MCP SESSION. The MCP surface is stateless by
-- construction under the S-A6 posture (de73f9f8 §1.3, strategy §2.11 as
-- amended): it mints and consumes no MCP session identifier, and the
-- unreleased 2026-07-28 revision deletes the session header outright. There
-- is therefore NO session id to key this on, and inventing one would
-- contradict the ratified posture in the same candidate that gates it. The
-- credential is what identity actually rides on (§1.3: "identity rides
-- exclusively on the per-request Authorization header"), so the credential is
-- what the record is keyed on.
--
-- WHY A TTL RATHER THAN A PERMANENT MARK. Bootstrapping is how a harness
-- acquires its working context — personality, attached Reports, the granted
-- skill index and the board's workflow doctrine (§2.10 owner extension). A
-- record that never lapsed would let a credential parked in a config file
-- stay "bootstrapped" indefinitely and never re-read any of it, which is the
-- drift the cache doctrine (§2.10, C3) exists to discourage. The TTL is the
-- server's half of that: it expires, and the next work-plane call re-bootstraps.

CREATE TABLE IF NOT EXISTS mcp_bootstrap_records (
  -- One live record per credential. The upsert on this key is what makes a
  -- repeated bootstrap a refresh rather than a second row.
  credential_id    UUID PRIMARY KEY REFERENCES principal_credentials(id) ON DELETE CASCADE,
  bootstrapped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Absolute expiry, computed by the writer from the TTL. Stored rather than
  -- derived at read time so a TTL change never retroactively revives or kills
  -- records that were written under the old one.
  expires_at       TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE mcp_bootstrap_records IS
  'RH-P3.C4 [1]: which credentials have bootstrapped, and until when. Read by the one fail-closed gate in mcp/bootstrapGate (strategy 4e40f06f 2.10); written only by the bootstrap verb. Keyed on the credential because the MCP surface mints no session identifier (de73f9f8 1.3).';

COMMENT ON COLUMN mcp_bootstrap_records.expires_at IS
  'When this credential must bootstrap again. A row whose expires_at has passed is treated exactly as an absent row: the gate refuses and names the bootstrap verb.';

-- The gate reads by primary key, so no lookup index is needed. This one
-- serves the sweep that discards lapsed rows.
CREATE INDEX IF NOT EXISTS ix_mcp_bootstrap_expires
  ON mcp_bootstrap_records(expires_at);
