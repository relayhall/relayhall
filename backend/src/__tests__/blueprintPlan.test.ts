import { BlueprintDocument, BLUEPRINT_SCHEMA } from '../utils/blueprintDocument';
import { buildBlueprintPlan, enforceBlueprintPlan, blueprintRequestHash, BlueprintPlanContext } from '../services/BlueprintPlanService';
const config = { limit: 102400 };
function document(): BlueprintDocument {
  return { schemaVersion: BLUEPRINT_SCHEMA, blueprint: { key: 'incident-investigation', name: 'Incident investigation', version: 1, summary: '', description: '', tags: [], provenance: 'human-authored' },
    parameters: [{ key: 'decider', label: 'Decider', promptText: 'Who decides?', type: 'principal-ref', required: true },
      { key: 'title', label: 'Title', promptText: 'What happened?', type: 'string', required: false, default: 'Incident' }],
    target: { mode: 'new-project', project: { name: '{{title}}' } }, phases: [], reports: [], references: [],
    tasks: [{ key: 'announce', title: 'Announce {{title}}' }, { key: 'after', title: 'After' }],
    humanGates: [{ key: 'decision', title: 'Decision', decisionPrompt: 'Proceed or wait?', decider: '{{decider}}', arms: [
      { key: 'proceed', label: 'Proceed', tasks: ['announce'] }, { key: 'wait', label: 'Wait', tasks: ['announce'] }] }],
    dependencies: [{ task: 'after', dependsOn: 'announce' }] };
}
function context(): BlueprintPlanContext {
  return { target: { mode: 'new-project' }, resolve: jest.fn(async (kind, name) => ({ kind, name, id: 'resolved-human', handle: 'Decider', ...(kind === 'service' ? { version: 1, serviceKind: 'connector', descriptor: { options: [] } } : {}) })), authorize: jest.fn(async () => true) };
}
describe('Blueprint whole plan', () => {
  test('shared gate arm is created once, parked, dependent, and stewarded; downstream remains gated', async () => {
    const plan = await buildBlueprintPlan(document(), { decider: 'human' }, config, context());
    expect(plan.tasks.map(task => task.key)).toEqual(['decision', 'announce', 'after']);
    expect(plan.tasks.every(task => task.autoStart === false)).toBe(true);
    expect(plan.tasks[0].roles.verifierPrincipalId).toBe('resolved-human');
    expect(plan.tasks[1].roles.shepherdPrincipalId).toBe('resolved-human');
    expect(plan.tasks[0].subtasks).toEqual([{ text: 'Proceed' }, { text: 'Wait' }]);
    expect(plan.dependencies).toContainEqual({ task: 'after', dependsOn: 'decision' });
    expect(plan.counts.tasks).toBe(3);
  });
  test('generated role assignments reach authority; denied preview survives but execution is refused', async () => {
    const ctx = context(); ctx.authorize = jest.fn(async requirement => requirement.operation !== 'task.roles');
    const plan = await buildBlueprintPlan(document(), { decider: 'human' }, config, ctx);
    expect(plan.authority.filter(a => a.operation === 'task.roles')).toEqual([
      { operation: 'task.roles', scope: 'tasks:write', localKey: 'decision', principalIds: ['resolved-human'], allowed: false },
      { operation: 'task.roles', scope: 'tasks:write', localKey: 'announce', principalIds: ['resolved-human'], shepherdPrincipalId: 'resolved-human', allowed: false },
    ]);
    expect(() => enforceBlueprintPlan(plan)).toThrow('Required task-role assignment authority: tasks:write and, where applicable, services:invoke');
  });
  test('execution defaults remain in the shared plan for separately confirmed setup', async () => {
    const source = document();
    source.references.push({ kind: 'service', name: 'hermes', requirement: 'optional' });
    source.tasks[0].defaults = { executionProfile: { service: 'hermes', options: {} } };
    const plan = await buildBlueprintPlan(source, { decider: 'human' }, config, context());
    expect(plan.authority.every(item => item.allowed)).toBe(true);
    expect(plan.refusals).toEqual([]);
    expect(plan.tasks.find(task => task.key === 'announce')?.executionProfile).toMatchObject({ serviceId: 'resolved-human', descriptorVersion: 1, options: {} });
    expect(plan.tasks.every(task => task.autoStart === false)).toBe(true);
    expect(() => enforceBlueprintPlan(plan)).not.toThrow();
    const ctx = context(); ctx.resolve = jest.fn(async (kind, name) => kind === 'service' ? null : ({kind, name, id: 'human'}));
    const unavailable = await buildBlueprintPlan(source, { decider: 'human' }, config, ctx);
    expect(unavailable.refusals[0].code).toBe('BLUEPRINT_REFERENCE_ACCESS_REQUIRED');
    expect(() => enforceBlueprintPlan(unavailable)).toThrow('Access is required for hermes');
  });
  test('secret rejection precedes every resolver and authority callback', async () => {
    const ctx = context(); await expect(buildBlueprintPlan(document(), { decider: 'human', title: 'rh_live_abcdefghijklmnopqrstuvwxyz' }, config, ctx)).rejects.toThrow();
    expect(ctx.resolve).not.toHaveBeenCalled(); expect(ctx.authorize).not.toHaveBeenCalled();
  });
  test('one-pass answers are literal, source remains unchanged, and absent defaults hash identically', async () => {
    const source = document(); const initial = JSON.stringify(source);
    const first = await buildBlueprintPlan(source, { decider: 'human' }, config, context());
    const second = await buildBlueprintPlan(source, { title: 'Incident', decider: 'human' }, config, context());
    expect(blueprintRequestHash('v1', first.target, first.parameterValues)).toBe(blueprintRequestHash('v1', second.target, second.parameterValues));
    const literal = await buildBlueprintPlan(source, { title: '{{decider}}', decider: 'human' }, config, context());
    expect(literal.tasks[1].title).toBe('Announce {{decider}}'); expect(JSON.stringify(source)).toBe(initial);
  });
  test.each(['required', 'optional'])('missing %s capability has an explicit outcome without disclosing hidden metadata', async requirement => {
    const source = document(); source.references.push({ kind: 'personality', name: 'incident-helper', requirement });
    source.tasks[0].defaults = { personality: 'incident-helper' };
    const ctx = context(); ctx.resolve = jest.fn(async (kind, name) => kind === 'personality' ? null : ({ kind, name, id: 'resolved-human' }));
    const plan = await buildBlueprintPlan(source, { decider: 'human' }, config, ctx);
    expect(plan.tasks[1].personalityId).toBeNull(); expect(plan.references[0].outcome).toBe(`missing-${requirement}`);
    if (requirement === 'required') expect(() => enforceBlueprintPlan(plan)).toThrow('Required reference is unavailable');
    else expect(() => enforceBlueprintPlan(plan)).toThrow('Access is required for incident-helper');
  });
  test('conflicting deciders on the same task refuse instead of silently replacing a role', async () => {
    const source = document(); source.parameters.push({ key: 'other', label: 'Other', promptText: 'Who else?', type: 'principal-ref', required: true });
    source.tasks[0].roles = { shepherd: '{{other}}' }; const ctx = context();
    ctx.resolve = jest.fn(async (kind, name) => ({ kind, name, id: name }));
    await expect(buildBlueprintPlan(source, { decider: 'first', other: 'second' }, config, ctx)).rejects.toThrow('two different Shepherds');
  });
  test('binding a visible Phase from another Project is concealed as unavailable', async () => {
    const source = document(); source.target = { mode: 'existing-project', project: '{{project}}' };
    source.parameters.push({ key: 'project', label: 'Project', promptText: 'Where?', type: 'project-ref', required: true }, { key: 'phase', label: 'Phase', promptText: 'Which phase?', type: 'phase-ref', required: true });
    source.tasks[0].phase = '{{phase}}'; const ctx = context(); ctx.target = { mode: 'existing-project', projectId: 'visible-project' };
    ctx.resolve = jest.fn(async (kind, name) => ({ kind, name, id: name, projectId: 'other-project' }));
    await expect(buildBlueprintPlan(source, { decider: 'human', project: 'visible-project', phase: 'other-phase' }, config, ctx)).rejects.toThrow('Required reference is unavailable');
  });
});

test('Personality placeholder binding requires use authority on the selected Personality',async()=>{
 const d=document();d.parameters.push({key:'personality',label:'Personality',promptText:'Choose a Personality',type:'personality-ref',required:true});
 d.tasks[0].defaults={personality:'{{personality}}'};
 const ctx=context();ctx.authorize=jest.fn(async requirement=>requirement.operation!=='personality.use');
 const plan=await buildBlueprintPlan(d,{decider:'human',personality:'helper'},config,ctx);
 expect(plan.authority).toContainEqual(expect.objectContaining({operation:'personality.use',scope:'personalities:use',localKey:'announce',allowed:false}));
 expect(()=>enforceBlueprintPlan(plan)).toThrow();
});
