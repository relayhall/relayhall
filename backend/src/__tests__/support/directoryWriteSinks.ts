/** R-3: discover SQL literals at their syntax nodes, then register individual
 * writes. File membership grants no write exemption. The production source
 * root is traversed in full; fixtures and migration DDL are separately covered
 * by the existing schema/occurrence registers. Dynamic SQL with a protected
 * table token must still resolve to an explicitly registered expression. */
import ts from 'typescript';
import fs from 'fs';
import path from 'path';

type Sink = { file: string; owner: string; sql: string; line: number };
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
const dml = /\b(?:insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?)\s+(?:(?:[a-z_][a-z0-9_]*|"[^"]+")\s*\.\s*)?"?(?:groups|group_members)"?\b/i;
const dynamicTable = /\b(?:insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?)\s+\$\{/i;

function sqlText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map(s => (sqlText(s.expression) ?? '${' + s.expression.getText() + '}') + s.literal.text).join('');
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = sqlText(node.left), right = sqlText(node.right);
    return left === null && right === null ? null : (left ?? '${' + node.left.getText() + '}') + (right ?? '${' + node.right.getText() + '}');
  }
  return null;
}

function ownerOf(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) return current.name?.getText() ?? '<anonymous>';
  }
  return '<module>';
}

export function directoryWriteSinks(root: string): Sink[] {
  const result: Sink[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['__tests__', 'node_modules', 'migrations'].includes(entry.name)) walk(full);
      } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        const source = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit(node: ts.Node): void {
          const sql = sqlText(node);
          // The outer concatenation/template owns its fragments; scan once.
          const parentSql = node.parent && sqlText(node.parent);
          if (sql !== null && parentSql === null && (dml.test(sql.replace(/\/\*[\s\S]*?\*\//g, ' ')) || dynamicTable.test(sql))) {
            result.push({ file: path.relative(root, full).split(path.sep).join('/'),
              owner: ownerOf(node), sql: normalize(sql), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  walk(root);
  return result;
}

// Every row is a value-scoped exemption, including metadata/local writes.
export const DIRECTORY_WRITE_REGISTER = [
  // Exact no-op MVCC version fence, not a directory/binding write. The closed
  // grant/profile-assignment mapping and NOWAIT read are asserted in the census.
  ['services/AccessVehicleService.ts', 'versionReferenceTarget', 'UPDATE ${table} SET id=id WHERE id=$1'],
  // AZ-A12 build 1 (card 20f40e40, clause 2): the two Group writers insert the
  // kind='group' principal row first and the groups row with the same id, in
  // ONE statement; `update` returns the Group principal's status beside the
  // member count. Repaired BY NAME, each row to its new exact value.
  ['services/GroupService.ts', 'create', "WITH group_principal AS ( INSERT INTO principals (id, kind, handle, display_name, status) SELECT minted.id, 'group', 'group:' || minted.id::text, $1::text, 'active' FROM (SELECT gen_random_uuid() AS id) minted RETURNING id ) INSERT INTO groups (id, name, description, created_by_principal_id) SELECT group_principal.id, $1::text, $2, $3 FROM group_principal RETURNING *, 0 AS member_count, 'active' AS ownership_status"],
  ['services/GroupService.ts', 'update', "UPDATE groups SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *, (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = groups.id) AS member_count, (SELECT gp.status FROM principals gp WHERE gp.id = groups.id AND gp.kind = 'group') AS ownership_status"],
  ['services/GroupService.ts', 'remove', 'DELETE FROM groups WHERE id = $1 RETURNING *, 0 AS member_count'],
  ['services/GroupService.ts', 'addMember', "INSERT INTO group_members (group_id, account_principal_id, source, added_by_principal_id) VALUES ($1, $2, 'local', $3) RETURNING *"],
  ['services/GroupService.ts', 'removeMember', "DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2 AND source = 'local' RETURNING source"],
  ['services/GroupService.ts', 'applyAccountDirectorySnapshot', 'DELETE FROM group_members WHERE group_id = $1 AND account_principal_id = $2'],
  ['services/GroupService.ts', 'applyAccountDirectorySnapshot', "INSERT INTO group_members (group_id, account_principal_id, source, added_by_principal_id) VALUES ($1, $2, 'directory', $3) ON CONFLICT (group_id, account_principal_id) DO NOTHING RETURNING group_id"],
  ['services/DirectoryCarriageService.ts', 'bindReferenceToGroup', "WITH group_principal AS ( INSERT INTO principals (id, kind, handle, display_name, status) SELECT minted.id, 'group', 'group:' || minted.id::text, $1::text, 'active' FROM (SELECT gen_random_uuid() AS id) minted RETURNING id ) INSERT INTO groups (id, name, description, created_by_principal_id, identity_provider_id, external_group_ref) SELECT group_principal.id, $1::text, $2, $3, $4, $5 FROM group_principal RETURNING id, name"],
  // A DYNAMIC table token, and the reason this register admits it: the token is
  // not a document field and not a parameter. `BlueprintProvenanceService.stamp`
  // interpolates it from a FIXED LOCAL LITERAL LIST written three lines above
  // the statement -- `phases`, `tasks`, `reports` -- so the set of tables this
  // expression can name is closed by the source, and neither `groups` nor
  // `group_members` is in it. That closure is asserted next to this row rather
  // than trusted: see 'the one dynamic table token is drawn from a closed
  // literal list' in directoryCarriageSeamCensus.
  ['services/BlueprintProvenanceService.ts', 'stamp', 'UPDATE ${table} SET ${columns} WHERE id=ANY($1::uuid[])'],
];
