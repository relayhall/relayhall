/**
 * Charter-in-every-Brief (task f2735f1b): the object's reason to exist is
 * that the authority index rides every compiled Brief automatically. Pins:
 * the Charter section appears for an active chartered Project; absence
 * contributes nothing; the archived-Project exclusion covers the Charter;
 * and enriched context is spliced BEFORE the workflow footer — the stale
 * 'Standard Instructions' marker bug fixed with this task.
 */

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHARTER_SENTINEL = 'CHARTER AUTHORITY INDEX SENTINEL CONTENT';

let projectStatus = 'active';
let charter: any = null;

jest.mock('../services/ProjectService', () => ({
  projectService: {
    list: jest.fn(async () => [{
      id: PROJECT_ID, name: 'Fixture', description: 'Fixture project description',
      status: projectStatus, revision: 'r', is_hidden: false,
      created_at: 'now', updated_at: 'now',
    }]),
  },
}));

let charterLookupFails = false;

jest.mock('../services/CharterService', () => {
  const actual = jest.requireActual('../services/CharterService');
  return {
    CharterLookupError: actual.CharterLookupError,
    charterService: {
      find: jest.fn(async () => {
        if (charterLookupFails) throw new Error('charter db unavailable');
        return charter;
      }),
    },
  };
});

jest.mock('../services/ProjectResourceService', () => ({
  projectResourceService: {
    context: jest.fn(async () => ({
      project: { name: 'Fixture' },
      resources: [],
      omitted: { hidden: 0, archived: 0, incompatible: 0 },
      schemaVersion: 1,
    })),
  },
}));

jest.mock('../services/SkillManager', () => ({
  skillManager: {
    getEffectiveSkillsForProject: jest.fn(async () => [
      { name: 'fixture-skill', category: 'general', instructions: 'skill text', is_global: false, has_override: false },
    ]),
  },
}));

jest.mock('../services/TaskManagerDB', () => ({
  // RH-P3.C5: the compiler now resolves referenced Reports on every Brief.
  taskManagerDB: { getBlockingTasks: jest.fn(async () => []), queryLinkedReports: jest.fn(async () => []) },
  Task: {},
}));

jest.mock('../services/PersonalityService', () => ({
  personalityService: { getById: jest.fn(async () => null) },
}));

import { generateTaskPromptWithSkills } from '../utils/promptTemplate';
import { skillManager } from '../services/SkillManager';

const task: any = {
  id: 'tttttttt-1111-4111-8111-111111111111',
  title: 'Fixture task',
  description: 'Do the fixture work',
  status: 'todo',
  project: 'Fixture',
  subtasks: [],
};

const FOOTER_HEADING = '## Agent Workflow Instructions (auto-generated)';

beforeEach(() => {
  jest.clearAllMocks();
  projectStatus = 'active';
  charterLookupFails = false;
  charter = { id: 'c', projectId: PROJECT_ID, content: CHARTER_SENTINEL, version: 3, revision: 'rev' };
});

describe('the Charter rides every compiled Brief', () => {
  it('active chartered project: the section, its version, and the index framing are present', async () => {
    const compiled = await generateTaskPromptWithSkills(task);
    expect(compiled).toContain('### Project Charter (authority index)');
    expect(compiled).toContain('version 3');
    expect(compiled).toContain(CHARTER_SENTINEL);
    expect(compiled).toContain('asserts nothing new');
  });

  it('an unchartered project contributes no Charter section', async () => {
    charter = null;
    const compiled = await generateTaskPromptWithSkills(task);
    expect(compiled).not.toContain('Project Charter');
    expect(compiled).not.toContain(CHARTER_SENTINEL);
  });

  it('the archived-Project exclusion covers the Charter', async () => {
    projectStatus = 'archived';
    const compiled = await generateTaskPromptWithSkills(task);
    expect(compiled).not.toContain(CHARTER_SENTINEL);
    expect(compiled).not.toContain('Project Context');
  });

  it('enriched context (Charter included) is spliced BEFORE the workflow footer', async () => {
    const compiled = await generateTaskPromptWithSkills(task);
    const charterIdx = compiled.indexOf(CHARTER_SENTINEL);
    const footerIdx = compiled.indexOf(FOOTER_HEADING);
    expect(charterIdx).toBeGreaterThan(-1);
    expect(footerIdx).toBeGreaterThan(-1);
    expect(charterIdx).toBeLessThan(footerIdx);
  });

  it('a Charter LOOKUP FAILURE fails the compile closed — never a silent base Brief (review 6fa91e28 F1)', async () => {
    charterLookupFails = true;
    await expect(generateTaskPromptWithSkills(task)).rejects.toMatchObject({
      name: 'CharterLookupError',
    });
  });

  it('splice-before-footer also holds on the no-skills path', async () => {
    (skillManager.getEffectiveSkillsForProject as jest.Mock).mockResolvedValueOnce([]);
    const compiled = await generateTaskPromptWithSkills(task);
    const charterIdx = compiled.indexOf(CHARTER_SENTINEL);
    const footerIdx = compiled.indexOf(FOOTER_HEADING);
    expect(charterIdx).toBeGreaterThan(-1);
    expect(charterIdx).toBeLessThan(footerIdx);
  });
});


describe('transport-neutral task workflow in the compiled Brief', () => {
  it.each([
    ['no project', { project: undefined }],
    ['project context', {}],
    ['connector execution profile', { executionProfile: {
      serviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      descriptorVersion: 1, options: { runner: 'fixture' },
    } }],
    ['legacy execution profile', { legacyExecutionProfile: { harness: 'fixture-harness' } }],
  ])('%s retains stable IDs, atomic finish and independent verification', async (_label, extra) => {
    const compiled = await generateTaskPromptWithSkills({
      ...task, ...extra,
      definitionOfDone: ['Evidence verified'],
      subtasks: [{ id: '903', index: 0, text: 'First item', completed: false },
        { id: '41', index: 1, text: 'Second item', completed: true }],
    });
    const footer = compiled.slice(compiled.indexOf(FOOTER_HEADING));
    expect(compiled.split(FOOTER_HEADING)).toHaveLength(2);
    expect(compiled).toContain('First item (stable id: 903)');
    expect(compiled).toContain('Second item (stable id: 41)');
    expect(footer).toContain(`**Task ID:** ${task.id}`);
    expect(footer).toContain('MCP, CLI, or REST API');
    expect(footer).toContain('Do not switch transports or identities to bypass a refusal');
    expect(footer).toContain('relayhall_subtask_set');
    expect(footer).toContain(`relayhall set-subtask ${task.id} <STABLE_SUBTASK_ID>`);
    expect(footer).toContain(`/api/tasks/${task.id}/subtasks/by-id/<STABLE_SUBTASK_ID>/status`);
    expect(footer).toContain('relayhall_task_finish');
    expect(footer).toContain(`relayhall finish ${task.id}`);
    expect(footer).toContain(`POST /api/tasks/${task.id}/finish`);
    expect(footer).toContain('Finish atomically appends the handover, creates or links the Report, and moves the Task to Review');
    expect(footer).toContain('independent assigned Verifier, distinct from the Assignee');
    expect(footer).toContain('Never self-approve');
    expect(footer).toContain('Session exit alone does not establish handover or notification delivery');
    expect(footer).toContain('read the Task and linked Report before retrying');
    expect(footer).toContain('A dry run is validation only');
    for (const legacy of ['<INDEX>', '$CB', 'RELAYHALL_AGENT=1', 'Use the CLI, never raw API',
      'automatically notify the orchestrator', 'before calling `review`']) {
      expect(compiled).not.toContain(legacy);
    }
    if (!Object.prototype.hasOwnProperty.call(extra, 'project')) {
      for (const context of ['Fixture project description', CHARTER_SENTINEL, 'skill text']) {
        expect(compiled.indexOf(context)).toBeGreaterThan(-1);
        expect(compiled.indexOf(context)).toBeLessThan(compiled.indexOf(FOOTER_HEADING));
      }
    } else {
      for (const context of ['## Project Context', CHARTER_SENTINEL, 'skill text']) {
        expect(compiled).not.toContain(context);
      }
    }
    if (_label === 'connector execution profile') {
      const profileAt = compiled.indexOf('**Execution profile**');
      expect(profileAt).toBeGreaterThan(-1);
      expect(profileAt).toBeLessThan(compiled.indexOf(FOOTER_HEADING));
      expect(compiled).toContain('"serviceId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"');
      expect(compiled).toContain('"runner": "fixture"');
      expect(compiled).not.toContain('**Model:**');
    }
    if (_label === 'legacy execution profile') {
      const profileAt = compiled.indexOf('**Harness:** fixture-harness');
      expect(profileAt).toBeGreaterThan(-1);
      expect(profileAt).toBeLessThan(compiled.indexOf(FOOTER_HEADING));
    }
  });
});
