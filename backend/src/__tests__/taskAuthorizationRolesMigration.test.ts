import fs from 'fs';
import path from 'path';

const sql = fs.readFileSync(
  path.join(__dirname, '../migrations/084_task_authorization_roles.sql'),
  'utf8',
);

describe('082 task authorization roles migration', () => {
  it('adds server-owned Shepherd and Verifier references', () => {
    expect(sql).toMatch(/shepherd_principal_id UUID REFERENCES principals\(id\) ON DELETE RESTRICT/i);
    expect(sql).toMatch(/verifier_principal_id UUID REFERENCES principals\(id\) ON DELETE SET NULL/i);
    expect(sql).toMatch(/ALTER COLUMN shepherd_principal_id SET NOT NULL/i);
    expect(sql).toMatch(/BEFORE INSERT ON tasks/i);
  });

  it('backfills Shepherd in the ratified fallback order', () => {
    const backfill = sql.match(/UPDATE tasks[\s\S]*?WHERE shepherd_principal_id IS NULL;/i)?.[0] ?? '';
    expect(backfill).toMatch(/COALESCE\([\s\S]*creator_principal_id,[\s\S]*owner_principal_id,[\s\S]*dashboard_user/i);
  });

  it('enforces claimant and Verifier separation in the database', () => {
    expect(sql).toContain('tasks_claimant_verifier_separation');
    expect(sql).toMatch(/owner_principal_id <> verifier_principal_id/i);
  });

  it('indexes both role lookups and documents caller ownership', () => {
    expect(sql).toContain('ix_tasks_shepherd_principal');
    expect(sql).toContain('ix_tasks_verifier_principal');
    expect(sql).toMatch(/never caller-writable/);
  });
});
