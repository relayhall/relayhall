/**
 * THE DOC-EQUALS-CATALOGUE GATE (card a2d1e317).
 *
 * `docs/roles.md` and the dashboard tests' copy of the catalogue are both
 * committed renderings of `utils/roleCatalogue.ts`. Each must be byte-equal to
 * what the module renders now; a catalogue change that is not regenerated
 * (`npm --prefix backend run docs:roles`) fails here.
 */
import fs from 'fs';
import path from 'path';
import {
  ROLE_CATALOGUE_DOC, ROLE_CATALOGUE_FIXTURE, renderRoleCatalogueFixture, renderRoleCatalogueMarkdown, roleCatalogue,
} from '../utils/roleCatalogue';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

describe('docs/roles.md equals the catalogue', () => {
  it('the committed page is exactly the rendered catalogue', () => {
    expect(read(ROLE_CATALOGUE_DOC)).toBe(renderRoleCatalogueMarkdown());
  });

  it('every role, its purpose and both ceiling sentences appear in the page', () => {
    const page = read(ROLE_CATALOGUE_DOC);
    for (const row of roleCatalogue()) {
      expect(page).toContain(`| \`${row.role}\` | ${row.purpose} | ${row.mayReach} | ${row.neverReaches} |`);
    }
  });

  it('the renderer is not vacuous: a changed purpose changes the page', () => {
    const entries = roleCatalogue();
    entries[0] = { ...entries[0], purpose: `${entries[0].purpose} (changed)` };
    expect(renderRoleCatalogueMarkdown(entries)).not.toBe(read(ROLE_CATALOGUE_DOC));
  });

  it('the docs index and the role guide link the page', () => {
    expect(read('docs/README.md')).toContain('(roles.md)');
    expect(read('docs/authorization.md')).toContain('(roles.md)');
  });
});

describe('the dashboard tests read the same catalogue', () => {
  it('the committed fixture is exactly the route payload', () => {
    expect(read(ROLE_CATALOGUE_FIXTURE)).toBe(renderRoleCatalogueFixture());
    expect(JSON.parse(read(ROLE_CATALOGUE_FIXTURE)).roles).toEqual(JSON.parse(JSON.stringify(roleCatalogue())));
  });
});
