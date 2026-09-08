/**
 * Archived-Project Brief exclusion (task 47ef04a2; review 5d229bf1
 * finding 1; contract c1895aa8 §4.3).
 *
 * Archived Projects are categorically excluded from ordinary generated
 * context: the compiled task Brief content must carry NO project
 * description, NO resource context and NO project-linked capability text
 * when the task's project is archived or absent — the base content only.
 */

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET_DESCRIPTION = 'ARCHIVED PROJECT PRIVATE DESCRIPTION';
const SECRET_SKILL_TEXT = 'ARCHIVED PROJECT CAPABILITY INSTRUCTION';

let projectStatus = 'archived';

jest.mock('../services/ProjectService', () => ({
  projectService: {
    list: jest.fn(async () => [{
      id: PROJECT_ID, name: 'Fixture', description: SECRET_DESCRIPTION,
      status: projectStatus, revision: 'r', is_hidden: false,
      created_at: 'now', updated_at: 'now',
    }]),
  },
}));

jest.mock('../services/CharterService', () => {
  const actual = jest.requireActual('../services/CharterService');
  return {
    CharterLookupError: actual.CharterLookupError,
    charterService: { find: jest.fn(async () => null) },
  };
});

jest.mock('../services/ProjectResourceService', () => ({
  projectResourceService: {
    context: jest.fn(async () => {
      if (projectStatus === 'archived') {
        const e: any = new Error('Archived projects generate no context');
        e.code = 'PROJECT_ARCHIVED';
        e.status = 409;
        throw e;
      }
      return {
        project: { name: 'Fixture' },
        resources: [{ kind: 'reference', name: 'docs', details: { url: 'https://d.example.test', category: 'documentation' } }],
        omitted: { hidden: 0, archived: 0, incompatible: 0 },
        schemaVersion: 1,
      };
    }),
  },
}));

jest.mock('../services/SkillManager', () => ({
  skillManager: {
    getEffectiveSkillsForProject: jest.fn(async () => [
      { name: 'legacy-capability', usage_instructions: SECRET_SKILL_TEXT },
    ]),
  },
}));

jest.mock('../services/TaskManagerDB', () => ({
  taskManagerDB: {
    getBlockingTasks: jest.fn(async () => []),
    // RH-P3.C5: the compiler resolves referenced Reports on every Brief.
    queryLinkedReports: jest.fn(async () => []),
  },
  Task: {},
}));

jest.mock('../services/PersonalityService', () => ({
  personalityService: { getBySlugOrId: jest.fn(async () => null) },
}));

import { generateTaskPromptWithSkills } from '../utils/promptTemplate';

const task: any = {
  id: 'tttttttt-1111-4111-8111-111111111111',
  title: 'Fixture task',
  description: 'Do the fixture work',
  status: 'todo',
  project: 'Fixture',
  subtasks: [],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('archived projects contribute nothing to compiled task Brief content', () => {
  it('archived project -> base content only: no description, resources or capability text', async () => {
    projectStatus = 'archived';
    const compiled = await generateTaskPromptWithSkills(task);
    expect(compiled).toContain('Fixture task');
    expect(compiled).not.toContain(SECRET_DESCRIPTION);
    expect(compiled).not.toContain(SECRET_SKILL_TEXT);
    expect(compiled).not.toContain('Project Context');
    expect(compiled).not.toContain('https://d.example.test');
  });

  it('active project -> enrichment present (the gate is archived-specific)', async () => {
    projectStatus = 'active';
    const compiled = await generateTaskPromptWithSkills(task);
    expect(compiled).toContain(SECRET_DESCRIPTION);
    expect(compiled).toContain('https://d.example.test');
  });
});
