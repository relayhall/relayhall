import type { CreationTransaction } from '../db/creationTransaction';
export interface BlueprintProvenance {
  key: string; version: number; contentSha256: string; identitySha256: string; instantiationId: string;
}
/** Only provenance fields are writable here. Object creation stays in the
 * canonical Project/Phase/Task/Report services. No future instance behavior
 * reads the registry through this stamp. */
export class BlueprintProvenanceService {
  async stamp(transaction: CreationTransaction, provenance: BlueprintProvenance,
    ids: { project?: string; phases: string[]; tasks: string[]; reports: string[] }): Promise<void> {
    const columns = 'blueprint_key=$2,blueprint_version=$3,blueprint_content_sha256=$4,blueprint_identity_sha256=$5,instantiation_id=$6';
    const values = [provenance.key, provenance.version, provenance.contentSha256, provenance.identitySha256, provenance.instantiationId];
    if (ids.project) await transaction.client.query(`UPDATE projects SET ${columns},instantiated_at=now(),instantiated_by_principal_id=$7 WHERE id=$1`, [ids.project,...values,transaction.actor.principalId]);
    // This table set is a fixed local allowlist, never a document field.
    for (const [table, list] of [['phases',ids.phases],['tasks',ids.tasks],['reports',ids.reports]] as const) {
      if (list.length) await transaction.client.query(`UPDATE ${table} SET ${columns} WHERE id=ANY($1::uuid[])`, [list,...values]);
    }
    if (ids.tasks.length) await transaction.client.query(`UPDATE subtasks SET ${columns} WHERE task_id=ANY($1::uuid[])`, [ids.tasks,...values]);
  }
}
export const blueprintProvenanceService = new BlueprintProvenanceService();
