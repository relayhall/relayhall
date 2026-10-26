/**
 * Regenerates the two committed renderings of the role catalogue (card
 * a2d1e317) from `src/utils/roleCatalogue.ts`:
 *
 *   docs/roles.md                                        the documentation page
 *   frontend/src/components/access/roleCatalogue.generated.json
 *                                                        the dashboard tests' copy
 *
 * `src/__tests__/roleCatalogueDoc.test.ts` fails when either file differs from
 * what this script would write, so a catalogue change that is not regenerated
 * is a red build, not a stale page.
 *
 *   npm --prefix backend run docs:roles
 */
import fs from 'fs';
import path from 'path';
import {
  ROLE_CATALOGUE_DOC, ROLE_CATALOGUE_FIXTURE, renderRoleCatalogueFixture, renderRoleCatalogueMarkdown, roleCatalogue,
} from '../src/utils/roleCatalogue';

const repoRoot = path.resolve(__dirname, '..', '..');
const entries = roleCatalogue();
fs.writeFileSync(path.join(repoRoot, ROLE_CATALOGUE_DOC), renderRoleCatalogueMarkdown(entries));
fs.writeFileSync(path.join(repoRoot, ROLE_CATALOGUE_FIXTURE), renderRoleCatalogueFixture(entries));
process.stdout.write(`wrote ${ROLE_CATALOGUE_DOC} and ${ROLE_CATALOGUE_FIXTURE} (${entries.length} roles)\n`);
