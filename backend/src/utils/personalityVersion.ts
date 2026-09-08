/** Current immutable Personality projection. Requires the reserved schema;
 * missing history is an invariant failure, never an invented version one. */
export const PERSONALITY_SNAPSHOT_FIELDS = Object.freeze([
  'slug', 'name', 'description', 'category', 'color', 'content',
  'source_file', 'is_custom', 'source',
] as const);

export const PERSONALITY_VERSION_JOIN = `personalities p
  LEFT JOIN personality_versions pv
    ON pv.personality_id = p.id AND pv.version = p.current_version`;
export const PERSONALITY_VERSION_IDENTITY = `p.current_version,
  pv.personality_id AS version_parent_id, pv.version AS resolved_version`;
export const PERSONALITY_DETAIL_SELECT = `p.*, ${PERSONALITY_VERSION_IDENTITY}, pv.snapshot AS version_snapshot`;

const unavailable = (): never => {
  throw new Error('Personality immutable version is unavailable or inconsistent');
};

/** Internal SQL aliases never appear in a current Personality DTO. Summary
 * queries do not load snapshot/content bytes merely to expose the version. */
export function projectPersonalityVersion(row: Record<string, any>, detail: boolean): any {
  const { current_version, version_parent_id, resolved_version, version_snapshot, ...publicRow } = row;
  if (!Number.isInteger(current_version) || current_version < 1 || current_version > 2147483647
      || current_version !== resolved_version || typeof row.id !== 'string'
      || row.id !== version_parent_id) unavailable();
  if (detail) {
    if (!version_snapshot || typeof version_snapshot !== 'object' || Array.isArray(version_snapshot)
        || Object.keys(version_snapshot).length !== PERSONALITY_SNAPSHOT_FIELDS.length) unavailable();
    for (const key of PERSONALITY_SNAPSHOT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(version_snapshot, key)
          || version_snapshot[key] !== row[key]) unavailable();
      const value = version_snapshot[key];
      if (key === 'is_custom') { if (typeof value !== 'boolean') unavailable(); }
      else if (key === 'source') {
        if (!['built-in', 'managed', 'git', 'legacy-db'].includes(value)) unavailable();
      } else if (key === 'slug' || key === 'name') {
        if (typeof value !== 'string') unavailable();
      } else if (value !== null && typeof value !== 'string') unavailable();
    }
  }
  return { ...publicRow, version: resolved_version };
}
