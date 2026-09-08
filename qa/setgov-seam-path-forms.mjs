/**
 * setgov-seam-path-forms — does `authoritySeamCompositionDrift` detect an
 * authority path composed into `surfaceLevel` that `AUTHORITY_SEAMS` does not
 * declare, whatever SQL form that path takes?
 *
 * Every form below is a real way to make a boolean sub-expression that consults
 * another table or function, and each one confers a surface level exactly as a
 * declared seam does. The last two are the round-5 reviewer's: an expression
 * spelled entirely in words the first (vocabulary-based) form of the control
 * allowed.
 *
 *   node qa/setgov-seam-path-forms.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.RELAYHALL_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { authoritySeamCompositionDrift } = await import(path.join(REPO, 'scripts', 'setgov-drill-contract.mjs'));

const seam = (table) => (offset) => ({
  sql: `EXISTS (SELECT 1 FROM ${table} t WHERE t.p = $${offset} AND t.r = $${offset + 1} AND t.v = $${offset + 2} AND t.rid = <RESOURCE_ID_COLUMN>)`,
  bind: (principalId, resourceType, verb) => [principalId, resourceType, verb],
});
const SEAMS = [
  { store: 'surface-grant', condition: seam('grants') },
  { store: 'profile-assignment', condition: seam('access_profile_assignments') },
];

/** `surfaceLevel`, composed from the inventory, optionally with one more term. */
const composed = (extra) => async (principalId, surfaceId, queryable) => {
  const params = [surfaceId];
  const clause = (verb) => {
    const fragments = SEAMS.map((s) => {
      const opened = s.condition(params.length + 1);
      params.push(...opened.bind(principalId, 'surface', verb));
      return `(${opened.sql.split('<RESOURCE_ID_COLUMN>').join('$1::uuid')
        // A surface has no project perimeter, so the project-bounded arm
        // (card 95572530) renders FALSE - what `renderAuthoritySeam` does.
        .split('<PROJECT_BOUNDED_ARM>').join('FALSE')})`;
    });
    return `(${[...fragments, ...(extra ? [extra] : [])].join(' OR ')})`;
  };
  await queryable.query(`SELECT ${clause('read')} AS can_read, ${clause('write')} AS can_write`, params);
  return 'none';
};

const forms = {
  'EXISTS subquery': 'EXISTS (SELECT 1 FROM undeclared_source b WHERE b.p = $1::uuid)',
  'IN (SELECT ...)': '$1::uuid IN (SELECT surface_id FROM undeclared_source)',
  '= ANY (SELECT ...)': '$1::uuid = ANY (SELECT surface_id FROM undeclared_source)',
  'scalar subquery': '(SELECT count(*) FROM undeclared_source) > 0',
  'bare subquery': '(SELECT b.allowed FROM undeclared_source b LIMIT 1)',
  'function call': 'undeclared_source_check($1::uuid)',
  'column reference': 'undeclared_source_allowed',
  'allowed-words only (round-5 A2 B1)': 'seam(FALSE)',
  'marker forgery': 'seam',
  'always-false term': 'FALSE',
};

let missed = 0;
for (const [form, sql] of Object.entries(forms)) {
  const drift = await authoritySeamCompositionDrift({ AUTHORITY_SEAMS: SEAMS, surfaceLevel: composed(sql) });
  const caught = drift.problems.length > 0;
  if (!caught) missed += 1;
  console.log(`${caught ? 'CAUGHT ' : 'MISSED '} ${form.padEnd(36)} ${drift.problems.join(' | ').slice(0, 96)}`);
}
const clean = await authoritySeamCompositionDrift({ AUTHORITY_SEAMS: SEAMS, surfaceLevel: composed(null) });
const cleanOk = clean.problems.length === 0;
console.log(`${cleanOk ? 'OK     ' : 'BROKEN '} ${'the shipped composition itself'.padEnd(36)} ${clean.problems.join(' | ')}`);
console.log(`\n${Object.keys(forms).length - missed}/${Object.keys(forms).length} undeclared authority-path forms detected; shipped composition ${cleanOk ? 'clean' : 'REDDENED'}`);
if (missed > 0 || !cleanOk) process.exitCode = 1;
