-- HARDENING c18bdb1e: opaque revision for /skills optimistic concurrency.
ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS revision UUID NOT NULL DEFAULT gen_random_uuid();

COMMENT ON COLUMN skills.revision IS
  'Opaque revision rotated on every mutation; /skills writes bind it with If-Match';
