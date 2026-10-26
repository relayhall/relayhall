-- 159_change_request_session_door.sql — the universal change request, train T1
-- slice S2 (card 502fb19e; design ratified by owner ruling E325, section 9.2;
-- reserved in backend/src/migrations/RESERVED before this file was written).
--
-- Section 9.2: "Session filing: POST /approvals/requests (login session only,
-- ceiling authenticated, family added to the settings.access-manager surface
-- row by additive UPDATE as 142/148 did), GET /approvals/requests/preview,
-- POST /approvals/:id/withdraw (the requester's session)", and section 4.3 the
-- bearer's preview, GET /delegation/access-requests/preview. No new surface,
-- no menu entry and no new mount: the four families join the existing
-- settings.access-manager row (109_access_surfaces.sql), which already owns
-- /approvals and /delegation/access-requests, so the D15 overlap census
-- (AccessSurfaceService.censusFindings) finds no path another surface claims.
--
-- No table, column, constraint, trigger or function is touched: the change
-- arm of migration 158 already admits a session-filed row (exactly one of
-- requesting_credential_id and session_evidence), and its decider standings
-- (root, administrator, owner, group-owner, group-manager) are 158's CHECK.
--
-- Replay-safe: an UPDATE that appends each family only when the row does not
-- carry it yet, so re-running this file is a no-op. A catalogue with no
-- settings.access-manager row is left unchanged.
UPDATE access_surfaces AS s
   SET read_families = s.read_families || ARRAY(
         SELECT family FROM unnest(ARRAY[
           'GET /approvals/requests/preview',
           'GET /delegation/access-requests/preview']::text[]) AS family
          WHERE NOT (family = ANY (s.read_families))),
       write_families = s.write_families || ARRAY(
         SELECT family FROM unnest(ARRAY[
           'POST /approvals/requests',
           'POST /approvals/:id/withdraw']::text[]) AS family
          WHERE NOT (family = ANY (s.write_families)))
 WHERE s.key = 'settings.access-manager';
