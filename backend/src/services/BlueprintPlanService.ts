import { BlueprintError, BlueprintBodyConfiguration, validateBlueprintDocument,
  validateBlueprintValues, substituteBlueprint, substituteBlueprintText, expandedDependencies, blueprintDigest } from '../utils/blueprintDocument';

import { normalizeConnectorProfileOptions, ProfileValidationError } from '../utils/executionProfile';
import type { ServiceDescriptor } from '../utils/serviceDescriptor';

type Row = Record<string, any>;
export interface BlueprintResolution {
  kind: string; name: string; id: string; version?: number | string; handle?: string;
  projectId?: string; serviceName?: string; pluginVersion?: string; tool?: string; descriptor?: ServiceDescriptor; serviceKind?: string;
}
export interface BlueprintAuthorityRequirement {
  operation: 'project.create' | 'project.write' | 'project.read' | 'phase.create' | 'task.create' | 'task.roles' | 'report.create' | 'service.invoke' | 'skill.use' | 'personality.use';
  scope: string; localKey?: string; resourceId?: string; principalIds?: string[]; shepherdPrincipalId?: string;
}
export interface BlueprintPlanContext {
  target: { mode: 'new-project' | 'existing-project'; projectId?: string };
  resolve(kind: string, name: string, minimumVersion?: number | string, service?: string): Promise<BlueprintResolution | null>;
  authorize(requirement: BlueprintAuthorityRequirement): Promise<boolean>;
}
export interface BlueprintPlan {
  target: BlueprintPlanContext['target']; project: Row | null; phases: Row[]; tasks: Row[]; reports: Row[];
  dependencies: Array<{ task: string; dependsOn: string }>;
  references: Array<{ kind: string; name: string; outcome: 'resolved' | 'missing-required' | 'missing-optional'; resolved: BlueprintResolution | null; requiredAccess?: string; reason?: string }>;
  authority: Array<BlueprintAuthorityRequirement & { allowed: boolean }>;
  humanGates: Row[]; counts: Row; parameterValues: Row;
  refusals: Array<{ code: string; error: string; field: string }>;
}
const descriptorKey = (id: string, version: number | string | undefined): string => `${id}:${version}`;
const missing = (field: string): never => { throw new BlueprintError(422, 'BLUEPRINT_REFERENCE_MISSING', 'Required reference is unavailable', field); };
const parameterKey = (value: unknown): string | null => typeof value === 'string' ? /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(value)?.[1] ?? null : null;

/** Preview and creation call this same builder. Its only callbacks are reads:
 * visibility-narrowed resolution and canonical authority decisions. It never
 * accepts a write callback, and expansion is complete before authority runs. */
export async function buildBlueprintPlan(documentInput: unknown, parameterInput: unknown,
  configuration: BlueprintBodyConfiguration, context: BlueprintPlanContext): Promise<BlueprintPlan> {
  const document = validateBlueprintDocument(documentInput, configuration);
  const values = validateBlueprintValues(document, parameterInput, context.target.mode);
  const materialized = substituteBlueprint(document, values);
  if (context.target.mode !== document.target.mode && !(document.target.allowExisting && context.target.mode === 'existing-project')) throw new BlueprintError(422, 'BLUEPRINT_TARGET_MISMATCH', 'Target mode does not match the Blueprint');
  if (document.target.mode === 'existing-project') {
    const targetKey = parameterKey(document.target.project);
    const selected = targetKey && values[targetKey] != null ? await context.resolve('project', String(values[targetKey])) : null;
    if (!selected || selected.id !== context.target.projectId) return missing('target.project');
  }
  const outcomes: BlueprintPlan['references'] = [];
  const resolved = new Map<string, BlueprintResolution | null>();
  // Descriptors never enter the safe resolution DTO, preview references or ledger.
  const descriptors = new Map<string, { descriptor: ServiceDescriptor; kind: string | undefined }>();
  for (const reference of document.references) {
    let value = await context.resolve(reference.kind, reference.name, reference.minVersion, reference.service);
    let reason: string | undefined;
    if (value && reference.kind.startsWith('plugin:') && (reference.pluginVersion !== value.pluginVersion || reference.tool !== value.tool)) {
      value = null; reason = 'The plugin function descriptor changed; review the portable reference again';
    }
    if (value && reference.descriptorSha256 && (!value.descriptor || blueprintDigest(value.descriptor) !== reference.descriptorSha256)) {
      value = null; reason = 'The Connector descriptor changed; review the portable reference again';
    }
    if (value && (['service','tool'].includes(reference.kind) || reference.kind.startsWith('plugin:')) && !await context.authorize({operation:'service.invoke',scope:'services:invoke',resourceId:value.id})) {
      value = null; reason = 'Service invoke access is required';
    }
    if (value && ['skill','personality'].includes(reference.kind) && !await context.authorize({
      operation:reference.kind === 'skill' ? 'skill.use' : 'personality.use',
      scope:reference.kind === 'skill' ? 'skills:use' : 'personalities:use',resourceId:value.id})) {
      value=null; reason='Read and use access are required';
    }
    if (value?.descriptor) descriptors.set(descriptorKey(value.id, value.version), { descriptor: value.descriptor, kind: value.serviceKind });
    const safe = value ? { kind: value.kind, name: value.name, id: value.id, version: value.version, handle: value.handle, projectId: value.projectId, ...(value.serviceName ? {serviceName:value.serviceName,pluginVersion:value.pluginVersion,tool:value.tool} : {}) } : null;
    resolved.set(`${reference.kind}:${reference.name}`, safe);
    outcomes.push({ kind: reference.kind, name: reference.name, resolved: safe,
      ...(!value ? { reason: reason || 'The named element is unavailable or not granted',
        requiredAccess: (['service','tool'].includes(reference.kind) || reference.kind.startsWith('plugin:')) ? 'services:read and services:invoke' : reference.kind === 'principal' ? 'principals:read' : reference.kind === 'personality' ? 'personalities:read and personalities:use' : reference.kind === 'skill' ? 'skills:read and skills:use' : reference.kind === 'plugin' ? 'services:read' : reference.kind + 's:read' } : {}),
      outcome: value ? 'resolved' : reference.requirement === 'required' ? 'missing-required' : 'missing-optional' });
  }
  const bind = async (kind: string, value: unknown, field: string): Promise<BlueprintResolution | null> => {
    if (value == null) return null;
    const key = parameterKey(value);
    if (key) {
      const supplied = values[key];
      if (supplied == null) return null;
      const result = await context.resolve(kind, String(supplied));
      if (!result) return missing(field);
      if (result.descriptor) descriptors.set(descriptorKey(result.id, result.version), { descriptor: result.descriptor, kind: result.serviceKind });
      return { kind: result.kind, name: result.name, id: result.id, version: result.version, handle: result.handle, projectId: result.projectId };
    }
    const lookup = `${kind}:${value}`;
    if (!resolved.has(lookup)) return missing(field);
    return resolved.get(lookup) ?? null;
  };
  const tasks: Row[] = [];
  for (const task of materialized.tasks) {
    let phaseId: string | null = null;
    if (parameterKey(task.phase)) {
      const phase = await bind('phase', task.phase, `tasks.${task.key}.phase`);
      if (phase && phase.projectId !== context.target.projectId) return missing(`tasks.${task.key}.phase`);
      phaseId = phase?.id ?? null;
    }
    const shepherd = await bind('principal', task.roles?.shepherd, `tasks.${task.key}.roles.shepherd`);
    const verifier = await bind('principal', task.roles?.verifier, `tasks.${task.key}.roles.verifier`);
    const personality = await bind('personality', task.defaults?.personality, `tasks.${task.key}.defaults.personality`);
    const service = await bind('service', task.defaults?.executionProfile?.service, `tasks.${task.key}.defaults.executionProfile.service`);
    let executionProfile = null;
    if (service) {
      const resolvedDescriptor = descriptors.get(descriptorKey(service.id, service.version));
      if (resolvedDescriptor && resolvedDescriptor.kind !== 'connector') throw new BlueprintError(422, 'PROFILE_SERVICE_NOT_CONNECTOR', 'Execution assignment requires a Connector', `tasks.${task.key}.defaults.executionProfile.service`);
      const descriptor = resolvedDescriptor?.descriptor;
      if (!descriptor || typeof service.version !== 'number' || !Number.isInteger(service.version) || service.version < 1) return missing(`tasks.${task.key}.defaults.executionProfile`);
      const raw = task.defaults.executionProfile.options;
      const options: Row = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' && /\{\{[a-z][a-z0-9_]*\}\}/.test(value)) {
          const declared = descriptor.options.find(option => option.key === key);
          if (declared?.type !== 'string') throw new BlueprintError(422, 'BLUEPRINT_INVALID', 'Substitution requires a descriptor string option', `tasks.${task.key}.defaults.executionProfile.options.${key}`);
          options[key] = substituteBlueprintText(value, values);
        } else options[key] = value;
      }
      const parameters: Row = {};
      for (const [optionKey,map] of Object.entries(task.defaults.executionProfile.parameters || {})) {
        parameters[optionKey]={};
        for (const [key,value] of Object.entries(map as Row)) {
          if (typeof value === 'string' && /\{\{[a-z][a-z0-9_]*\}\}/.test(value)) {
            const declared=descriptor.options.find(option=>option.key===optionKey)?.parameters?.find(parameter=>parameter.key===key);
            if (declared?.type !== 'string') throw new BlueprintError(422,'BLUEPRINT_INVALID','Substitution requires a descriptor string parameter','executionProfile.parameters.'+optionKey+'.'+key);
            parameters[optionKey][key]=substituteBlueprintText(value,values);
          } else parameters[optionKey][key]=value;
        }
      }
      try { executionProfile = normalizeConnectorProfileOptions({ options, parameters }, service.id, service.version, descriptor); }
      catch (error) {
        if (error instanceof ProfileValidationError) throw new BlueprintError(error.status, error.code, error.message, `tasks.${task.key}.defaults.${error.field || 'executionProfile'}`);
        throw error;
      }
    }
    const references = outcomes.filter(ref => (task.references || []).includes(ref.name) && ref.resolved).map(ref => ref.resolved);
    tasks.push({ ...task, ...(executionProfile ? { defaults: { ...task.defaults, executionProfile: { ...task.defaults.executionProfile, options: executionProfile.options } } } : {}), autoStart: false, phaseKey: parameterKey(task.phase) ? null : task.phase ?? null, phaseId,
      roles: { shepherdPrincipalId: shepherd?.id ?? null, verifierPrincipalId: verifier?.id ?? null, shepherdHandle: shepherd?.handle ?? null, verifierHandle: verifier?.handle ?? null },
      personalityId: personality?.id ?? null, service, references,
      executionProfile });
  }
  const gates: Row[] = [];
  for (const gate of materialized.humanGates) {
    const decider = await bind('principal', gate.decider, `humanGates.${gate.key}.decider`);
    if (!decider) return missing(`humanGates.${gate.key}.decider`);
    const armList = gate.arms.map((arm: Row) => `${arm.label}: ${arm.tasks.join(', ')}`).join('\n');
    const disposition = 'All tasks begin parked. After the decision, a caller with ordinary task write authority may arm the chosen tasks. Unchosen tasks remain parked. Role assignment does not confer arming authority.';
    tasks.push({ key: gate.key, title: gate.title, status: 'todo', priority: 'normal', autoStart: false,
      phaseKey: gate.phase ?? null, phaseId: null, definitionOfDone: `${gate.decisionPrompt}\n\n${armList}\n\n${disposition}`,
      description: `${armList}\n\n${disposition}`, subtasks: gate.arms.map((arm: Row) => ({ text: arm.label })),
      tags: ['gate', 'sop-decision'], roles: { shepherdPrincipalId: null, verifierPrincipalId: decider.id, shepherdHandle: null, verifierHandle: decider.handle ?? null }, references: [] });
    gates.push({ key: gate.key, decider, arms: gate.arms, allParked: true, disposition });
  }
  for (const gate of gates) {
    const decider = gate.decider;
    for (const armKey of new Set<string>(gate.arms.flatMap((arm: Row) => arm.tasks))) {
      const task = tasks.find(t => t.key === armKey);
      if (!task) return missing(`humanGates.${gate.key}.arms`);
      if (task.roles.shepherdPrincipalId && task.roles.shepherdPrincipalId !== decider.id) {
        throw new BlueprintError(422, 'BLUEPRINT_ROLE_CONFLICT', 'A task cannot bind two different Shepherds', `tasks.${armKey}.roles.shepherd`);
      }
      task.roles.shepherdPrincipalId = decider.id;
      task.roles.shepherdHandle = decider.handle ?? null;
      task.tags = [...new Set([...(task.tags || []), gate.key])];
    }
  }
  const dependencies = expandedDependencies(document);
  // Stable topological order is useful in the preview and deterministic write
  // order; a cycle is refused by the document validator before any callback.
  const ordered: Row[] = []; const remaining = new Map(tasks.map(task => [task.key, task]));
  while (remaining.size) {
    const ready = [...remaining.keys()].filter(key => !dependencies.some(edge => edge.task === key && remaining.has(edge.dependsOn))).sort();
    if (!ready.length) throw new BlueprintError(422, 'BLUEPRINT_DEPENDENCY_CYCLE', 'Dependency graph contains a cycle');
    for (const key of ready) { ordered.push(remaining.get(key)!); remaining.delete(key); }
  }
  const requirements: BlueprintAuthorityRequirement[] = [{ operation: context.target.mode === 'new-project' ? 'project.create' : 'project.write', scope: 'projects:write', resourceId: context.target.projectId }];
  for (const reference of outcomes) if (reference.resolved && ['skill','personality'].includes(reference.kind)) {
    requirements.push({operation:reference.kind === 'skill' ? 'skill.use' : 'personality.use',
      scope:reference.kind === 'skill' ? 'skills:use' : 'personalities:use',resourceId:reference.resolved.id});
  }
  if (ordered.length) requirements.push({ operation: 'project.read', scope: 'projects:read', resourceId: context.target.projectId });
  for (const phase of materialized.phases) requirements.push({ operation: 'phase.create', scope: 'phases:write', localKey: phase.key, resourceId: context.target.projectId });
  for (const task of ordered) {
    if (task.personalityId) requirements.push({operation:'personality.use',scope:'personalities:use',resourceId:task.personalityId,localKey:task.key});
    requirements.push({ operation: 'task.create', scope: 'tasks:write', localKey: task.key, resourceId: context.target.projectId });
    const principalIds = [task.roles.shepherdPrincipalId, task.roles.verifierPrincipalId].filter(Boolean);
    if (principalIds.length) requirements.push({ operation: 'task.roles', scope: 'tasks:write', localKey: task.key, principalIds, ...(task.roles.shepherdPrincipalId ? { shepherdPrincipalId: task.roles.shepherdPrincipalId } : {}) });
    if (task.service) requirements.push({ operation: 'service.invoke', scope: 'services:invoke', localKey: task.key, resourceId: task.service.id });
  }
  for (const report of materialized.reports) requirements.push({ operation: 'report.create', scope: 'reports:write', localKey: report.key });
  const authority: BlueprintPlan['authority'] = [];
  for (const requirement of requirements) authority.push({ ...requirement, allowed: await context.authorize(requirement) });
  return { target: context.target, project: context.target.mode === 'new-project' ? materialized.target.project : null,
    phases: materialized.phases, tasks: ordered, reports: materialized.reports, dependencies, references: outcomes,
    authority, humanGates: gates, parameterValues: values,
    // Owner-approved A: resolving execution defaults does not assign Tasks.
    // Ordinary access effects belong to a later explicit setup transaction.
    refusals: outcomes.filter(reference=>reference.outcome !== 'resolved').map(reference=>({
      code:'BLUEPRINT_REFERENCE_ACCESS_REQUIRED',error:'Access is required for ' + reference.name + ' (' + reference.kind + '): ' + reference.requiredAccess,field:'references',
    })),
    counts: { projects: context.target.mode === 'new-project' ? 1 : 0, phases: materialized.phases.length, tasks: tasks.length,
      subtasks: tasks.reduce((sum, task) => sum + (task.subtasks?.length || 0), 0), reports: materialized.reports.length,
      dependencies: dependencies.length, humanGates: gates.length } };
}
export function enforceBlueprintPlan(plan: BlueprintPlan): void {
  if (plan.references.some(reference => reference.outcome === 'missing-required')) missing('references');
  const refusal = plan.refusals[0];
  if (refusal) throw new BlueprintError(422, refusal.code, refusal.error, refusal.field);
  const requirement = plan.authority.find(item => !item.allowed);
  if (requirement) {
    const error = requirement.operation === 'task.roles'
      ? 'Required task-role assignment authority: tasks:write and, where applicable, services:invoke'
      : `Required scope: ${requirement.scope}`;
    throw new BlueprintError(403, 'BLUEPRINT_AUTHORITY_REQUIRED', error, requirement.localKey);
  }
}
export function blueprintRequestHash(blueprintVersionId: string, target: unknown, parameterValues: Row): string {
  return blueprintDigest({ blueprintVersionId, target, parameterValues });
}

