import { readFileSync } from 'fs';
import path from 'path';

describe('RH-P2.11 Task element migration contract', () => {
  const sql = readFileSync(
    path.join(__dirname, '../migrations/086_task_element_substrate.sql'),
    'utf8',
  );

  test('keeps live legacy stores and imports them without laundering provenance', () => {
    expect(sql).toContain('WITH legacy_entries AS');
    expect(sql).toContain("SELECT task_id, 'legacy', event_type, content");
    expect(sql).toContain('ORDER BY created_at, legacy_source, legacy_source_id');
    expect(sql).not.toContain("left(concat_ws(E'\\n', NULLIF(e.title, '')");
    expect(sql).not.toMatch(/DROP TABLE(?: IF EXISTS)?\s+(task_links|task_tags|task_attempt_links|task_attempt_ownership)/i);
  });

  test('has one immutable stream and three views', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS task_stream_entries');
    expect(sql).toContain('Task stream entries are append-only');
    expect(sql).toContain('Task stream entries are immutable outside attributed redaction');
    expect(sql).toContain('CREATE OR REPLACE VIEW task_history_view');
    expect(sql).toContain('CREATE OR REPLACE VIEW task_handover_view');
    expect(sql).toContain('CREATE OR REPLACE VIEW task_timeline_view');
  });

  test('pins review pointers to attempts belonging to the same Task', () => {
    expect(sql).toContain('FOREIGN KEY (task_id, current_attempt_id)');
    expect(sql).toContain('REFERENCES task_review_attempts(task_id, id)');
    expect(sql).toContain('trg_task_review_attempt_state');
  });

  test('preserves oversized handbacks and promotion provenance', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS task_stream_quarantine');
    expect(sql).toContain('auto_promoted BOOLEAN NOT NULL DEFAULT FALSE');
    expect(sql).toContain('source_outpost_visibility_tier');
  });

  test('pins attempt links to stable Subtask ids while preserving positional compatibility', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS subtask_id INTEGER REFERENCES subtasks(id)');
    expect(sql).toContain('resolve_attempt_link_subtask_compat');
    expect(sql).toContain('mirror_stable_subtask_display_index');
    expect(sql).toContain('DEFERRABLE INITIALLY IMMEDIATE');
  });

  test('drops thoughts only behind an empty-table proof', () => {
    expect(sql).toContain("IF to_regclass('public.thoughts') IS NOT NULL");
    expect(sql).toContain('IF EXISTS (SELECT 1 FROM thoughts LIMIT 1)');
    expect(sql).toContain("RAISE EXCEPTION '086 refuses to drop non-empty thoughts table'");
  });
});
