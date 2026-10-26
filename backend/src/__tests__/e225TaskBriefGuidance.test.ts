import { generateTaskPrompt } from '../utils/promptTemplate';
import { BUILT_IN_WORKFLOW_GUIDANCE } from '../utils/workflowGuidance';

it('includes product workflow guidance in a fresh task Brief without project customizations', () => {
  const brief = generateTaskPrompt({
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Fresh task',
    subtasks: [],
    tags: [],
  } as any);
  expect(brief).toContain(BUILT_IN_WORKFLOW_GUIDANCE);
  expect(brief).toContain('only when your assignment uses the native lifecycle');
});
