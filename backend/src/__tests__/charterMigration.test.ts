/**
 * Static pins on migration 075 (task f2735f1b), in the style of the 073/074
 * guard pins: the file must stay idempotent, seed nothing (a deployment's
 * Charter content is created through the surface, never shipped as repo
 * bytes), enforce one-Charter-per-Project, and never manage transactions
 * itself (the runner wraps each file).
 */
import fs from 'fs';
import path from 'path';

const sql = fs.readFileSync(
  path.join(__dirname, '../migrations/075_project_charter.sql'),
  'utf8',
);

describe('075_project_charter.sql', () => {
  it('is idempotent: every CREATE is IF NOT EXISTS', () => {
    const creates = sql.match(/CREATE (TABLE|INDEX|EXTENSION)/g) ?? [];
    const guarded = sql.match(/CREATE (TABLE|INDEX|EXTENSION) IF NOT EXISTS/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(creates.length);
  });

  it('seeds nothing — no INSERT, no UPDATE, no DELETE', () => {
    expect(sql).not.toMatch(/\bINSERT\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b\s+\w/i);
    expect(sql).not.toMatch(/\bDELETE\b\s+FROM/i);
  });

  it('enforces one Charter per Project and cascades with it', () => {
    expect(sql).toMatch(/project_id UUID NOT NULL UNIQUE REFERENCES projects\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/UNIQUE \(charter_id, version\)/);
    expect(sql).toMatch(/REFERENCES project_charters\(id\) ON DELETE CASCADE/);
  });

  it('carries the 067 revision discipline on the head row', () => {
    expect(sql).toMatch(/revision UUID NOT NULL DEFAULT gen_random_uuid\(\)/);
  });

  it('never manages transactions itself', () => {
    expect(sql).not.toMatch(/\bBEGIN\b/);
    expect(sql).not.toMatch(/\bCOMMIT\b/);
  });
});
