import fs from 'fs';
import path from 'path';

/**
 * Permanent core invariant: the backend serves no media bytes from directory
 * mounts.
 *
 * History (kept because the failure mode keeps trying to come back): four
 * directory-wide express.static mounts once exposed inbound chat attachments,
 * personal documents and private media files — the last through a second
 * alias that bypassed the deny shim on the first. They were replaced by explicit per-file policy routes, and those
 * routes then left core with their features (dashboard-media with Images,
 * the public journal allowlist with Journal — P1.3 ruling A1). Plugins serve
 * their own bytes; the only media bytes core serves are the authenticated
 * the removed status-voice avatar route's checksummed reads (surface deleted, A13.3).
 *
 * This replaces publicMediaPolicy.test.ts and journalMediaRoot.test.ts, whose
 * subjects (routes/publicMedia.ts) no longer exist.
 */
describe('no static media mounts (permanent core invariant)', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.ts'), 'utf8');

  test('server.ts serves no directory tree, media or otherwise', () => {
    expect(server).not.toContain('express.static(');
  });

  test('the historical media mounts have not grown back', () => {
    expect(server).not.toContain("app.use('/media'");
    expect(server).not.toContain("app.use('/clawd-media'");
    expect(server).not.toContain("app.use('/dashboard-media'");
    expect(server).not.toContain("app.use('/media/screenshots'");
    expect(server).not.toContain("app.use('/media/generated'");
  });
});
