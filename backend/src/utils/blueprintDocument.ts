import { createHash } from 'crypto';

/** The portable document is data. These are its only two transformations:
 * single-pass literal text substitution and typed reference binding. */
export const BLUEPRINT_SCHEMA = 'rh.blueprint/1.0';
export const BLUEPRINT_CAPS = Object.freeze({ documentBytes: 65536, envelopeBytes: 4096,
  phases: 20, tasks: 100, subtasks: 50, reports: 20, parameters: 50, references: 100,
  dependencies: 500, humanGates: 20, arms: 8 });
export type BlueprintLimits = { [K in Exclude<keyof typeof BLUEPRINT_CAPS, 'envelopeBytes'>]: number };
/** Server-owned live limits. Requests cannot supply them. The shipped maxima
 * are immutable; a deployment may tighten current limits without grandfathering
 * already published documents. Raising maxima is a reviewed server change. */
export const blueprintLimits: BlueprintLimits = {
  documentBytes: BLUEPRINT_CAPS.documentBytes, phases: BLUEPRINT_CAPS.phases, tasks: BLUEPRINT_CAPS.tasks,
  subtasks: BLUEPRINT_CAPS.subtasks, reports: BLUEPRINT_CAPS.reports, parameters: BLUEPRINT_CAPS.parameters,
  references: BLUEPRINT_CAPS.references, dependencies: BLUEPRINT_CAPS.dependencies,
  humanGates: BLUEPRINT_CAPS.humanGates, arms: BLUEPRINT_CAPS.arms,
};
export function currentBlueprintLimits(): BlueprintLimits {
  const expected = Object.keys(BLUEPRINT_CAPS).filter(key => key !== 'envelopeBytes');
  if (Object.keys(blueprintLimits).some(key => !expected.includes(key))) throw new Error('Invalid Blueprint limit configuration');
  const result = {} as BlueprintLimits;
  for (const key of expected as Array<keyof BlueprintLimits>) {
    const value = blueprintLimits[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > BLUEPRINT_CAPS[key]) throw new Error('Invalid Blueprint limit configuration');
    result[key] = value;
  }
  return result;
}
export interface BlueprintBodyConfiguration { limit: number }
export function effectiveBlueprintCap(configuration: BlueprintBodyConfiguration): number {
  if (!Number.isSafeInteger(configuration.limit) || configuration.limit <= 0) throw new Error('Invalid JSON body limit configuration');
  return Math.max(0, Math.min(currentBlueprintLimits().documentBytes, configuration.limit - BLUEPRINT_CAPS.envelopeBytes));
}
export class BlueprintError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string) { super(message); }
}
const fail = (field: string, message: string): never => { throw new BlueprintError(422, 'BLUEPRINT_DOCUMENT_REFUSED', message, field); };
type RecordValue = { [key: string]: any };
export interface BlueprintDocument extends RecordValue {
  schemaVersion: string; blueprint: RecordValue; parameters: RecordValue[]; references: RecordValue[];
  target: RecordValue; phases: RecordValue[]; tasks: RecordValue[]; humanGates: RecordValue[];
  reports: RecordValue[]; dependencies: Array<{ task: string; dependsOn: string }>;
}
export const PARAMETER_TYPES = Object.freeze(['string', 'text', 'integer', 'boolean', 'enum', 'date',
  'principal-ref', 'project-ref', 'phase-ref', 'skill-ref', 'personality-ref', 'service-ref'] as const);
export const TEXT_PARAMETER_TYPES = new Set(['string', 'text', 'integer', 'boolean', 'enum', 'date']);
export const BINDING_SLOTS = Object.freeze({
  'tasks.roles.shepherd': 'principal-ref', 'tasks.roles.verifier': 'principal-ref',
  'humanGates.decider': 'principal-ref', 'target.project': 'project-ref',
  'tasks.phase': 'phase-ref', 'tasks.defaults.personality': 'personality-ref',
  'tasks.defaults.executionProfile.service': 'service-ref',
} as const);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARAMETER_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g;
const CREDENTIAL_WORD = /(?:password|secret|token|api[ _-]?key|private[ _-]?key|credential|passphrase)/i;
const SECRET = /(?:\b(?:rh_|cb_|ghp_|xox[a-z]?[-_]|AKIA)[A-Za-z0-9_-]{8,}|\bBearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/;
/** The exact portable literal shape set is executable policy, not a parallel test list. */
export const BLUEPRINT_FORBIDDEN_LITERAL_SHAPES = Object.freeze({
  uuid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  absoluteUrl: /\b[a-z][a-z0-9+.-]*:\/\//i,
  hostname: /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}\b/i,
  ipv4: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/i,
  ipv6: /(?:\[[0-9a-f:]+\]|\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]+\b)/i,
});
export function credentialShaped(value: unknown): boolean {
  if (typeof value === 'string') return SECRET.test(value);
  if (Array.isArray(value)) return value.some(credentialShaped);
  return value !== null && typeof value === 'object' && Object.entries(value).some(([k, v]) => CREDENTIAL_WORD.test(k) || credentialShaped(v));
}
export function stableBlueprintJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableBlueprintJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableBlueprintJson(value[k])).join(',') + '}';
}
export const blueprintDigest = (value: unknown): string => createHash('sha256').update(stableBlueprintJson(value)).digest('hex');
export function blueprintDigests(document: BlueprintDocument) {
  return { contentSha256: blueprintDigest(document), identitySha256: blueprintDigest({ ...document, blueprint: { ...document.blueprint, key: '' } }) };
}
function object(value: any, keys: string[], required: string[], field: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(field, 'Expected a plain object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(field + '.' + (credentialShaped(key) ? '[redacted]' : key), 'Unknown field');
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(field + '.' + key, 'Required field');
  return value;
}
function text(value: any, field: string, max = 8192, min = 0): void {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(field, `Expected text of ${min}..${max} characters`);
}
function optionalText(row: RecordValue, keys: string[], field: string, max = 8192) {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) text(row[key], field + '.' + key, max);
}
function integer(value: any, field: string, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(field, `Expected an integer in ${min}..${max}`);
}
function choice(value: any, choices: readonly string[], field: string) { if (!choices.includes(value)) fail(field, 'Unknown value'); }
function list(value: any, field: string, max: number): any[] {
  if (!Array.isArray(value) || value.length > max) fail(field, `Expected at most ${max} entries`);
  return value;
}
function strings(value: any, field: string, max = 50): void { list(value, field, max).forEach((v, i) => text(v, `${field}.${i}`, 100)); }
function slug(value: any, field: string, min = 1) { text(value, field, 64, min); if (!SLUG.test(value)) fail(field, 'Expected a kebab-case name'); }

/** A deliberately small linear pattern language: anchored literals, character
 * classes and bounded repetition. No groups, alternation, backreferences or
 * unbounded repetitions. Matching visits a bounded set of input positions per
 * token; it never invokes JavaScript's backtracking regular-expression engine. */
interface PatternToken { accepts: (character: string) => boolean; min: number; max: number }
export function compileBlueprintPattern(pattern: string): (value: string) => boolean {
  if (typeof pattern !== 'string' || pattern.length > 200 || !pattern.startsWith('^') || !pattern.endsWith('$')) fail('pattern', 'Pattern must be anchored and at most 200 characters');
  const source = pattern.slice(1, -1); const tokens: PatternToken[] = [];
  for (let i = 0; i < source.length;) {
    let accepts: (character: string) => boolean;
    if (source[i] === '[') {
      const end = source.indexOf(']', i + 1); if (end < 0) fail('pattern', 'Unclosed character class');
      const body = source.slice(i + 1, end); if (!body || /[^A-Za-z0-9 _-]/.test(body)) fail('pattern', 'Unsupported character class');
      const allowed = new Set<string>();
      for (let k = 0; k < body.length; k++) {
        if (k + 2 < body.length && body[k + 1] === '-') {
          const start = body.charCodeAt(k), stop = body.charCodeAt(k + 2);
          if (stop < start || stop - start > 128) fail('pattern', 'Invalid character range');
          for (let n = start; n <= stop; n++) allowed.add(String.fromCharCode(n)); k += 2;
        } else allowed.add(body[k]);
      }
      accepts = c => allowed.has(c); i = end + 1;
    } else {
      let literal = source[i++];
      if (literal === '\\') { literal = source[i++]; if (!literal || !'-_. '.includes(literal)) fail('pattern', 'Unsupported escape'); }
      else if (!/[A-Za-z0-9 _-]/.test(literal)) fail('pattern', 'Pattern is outside the bounded linear subset');
      accepts = c => c === literal;
    }
    let min = 1, max = 1;
    if (source[i] === '{') {
      const end = source.indexOf('}', i); const bounds = /^\{([0-9]{1,4})(?:,([0-9]{1,4}))?\}$/.exec(source.slice(i, end + 1));
      if (!bounds) fail('pattern', 'Repetition needs explicit bounds');
      min = Number(bounds![1]); max = Number(bounds![2] ?? bounds![1]);
      if (min > max || max > 8192) fail('pattern', 'Invalid repetition bounds'); i = end + 1;
    } else if (source[i] === '?') { min = 0; i++; }
    tokens.push({ accepts, min, max });
  }
  return value => {
    if (value.length > 8192) return false;
    let positions = new Set([0]);
    for (const token of tokens) {
      const next = new Set<number>();
      // Prefix counts make each bounded-repeat transition O(input length).
      let runStart = 0; const reachable = new Int32Array(value.length + 2);
      for (let i = 0; i <= value.length; i++) reachable[i + 1] = reachable[i] + Number(positions.has(i));
      for (let end = 0; end <= value.length; end++) {
        if (end > 0 && !token.accepts(value[end - 1])) runStart = end;
        const low = Math.max(runStart, end - token.max), high = end - token.min;
        if (high >= low && reachable[high + 1] > reachable[low]) next.add(end);
      }
      positions = next;
    }
    return positions.has(value.length);
  };
}

function walk(value: unknown, fn: (v: string, path: string[]) => void, path: string[] = []) {
  if (typeof value === 'string') fn(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => walk(v, fn, [...path, String(i)]));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, fn, [...path, k]));
}
const textFields = new Set(['name', 'title', 'summary', 'description', 'goal', 'definitionOfDone', 'successCriteria', 'constraints', 'notes', 'text', 'content', 'decisionPrompt', 'label']);
function bindingType(path: string[]): string | undefined {
  const normalized = path.filter(p => !/^\d+$/.test(p)).join('.');
  return BINDING_SLOTS[normalized as keyof typeof BINDING_SLOTS];
}
function substitutable(path: string[]): boolean {
  // Options are deferred until the pinned descriptor is resolved. Their names
  // cannot opt them into ordinary text substitution.
  if (path.includes('executionProfile') && (path.includes('options') || path.includes('parameters'))) return false;
  if (path[0] === 'references' || path[0] === 'parameters' || path[0] === 'blueprint') return false;
  return ['priority', 'thinking', 'model', 'maxRetries'].includes(path[path.length - 1]) || textFields.has(path[path.length - 1]) || ['tags', 'definitionOfDone', 'successCriteria', 'constraints'].includes(path[path.length - 2]);
}
function descriptorOptionSlot(path: string[]): boolean {
  return path[0] === 'tasks' && /^\d+$/.test(path[1]) && path[2] === 'defaults' && path[3] === 'executionProfile'
    && (path.length === 6 && path[4] === 'options' || path.length === 7 && path[4] === 'parameters');
}
export function validateBlueprintDocument(input: unknown, configuration: BlueprintBodyConfiguration): BlueprintDocument {
  const d = object(input, ['schemaVersion', 'blueprint', 'parameters', 'references', 'target', 'phases', 'tasks', 'humanGates', 'reports', 'dependencies'], ['schemaVersion', 'blueprint', 'parameters', 'references', 'target', 'phases', 'tasks', 'humanGates', 'reports', 'dependencies'], 'document') as BlueprintDocument;
  const cap = effectiveBlueprintCap(configuration);
  if (Buffer.byteLength(stableBlueprintJson(d), 'utf8') > cap) throw new BlueprintError(422, 'BLUEPRINT_DOCUMENT_TOO_LARGE', `Canonical document exceeds ${cap} bytes`, 'document');
  if (d.schemaVersion !== BLUEPRINT_SCHEMA) fail('schemaVersion', 'Unsupported Blueprint schema');
  const b = object(d.blueprint, ['key', 'name', 'version', 'summary', 'description', 'tags', 'provenance'], ['key', 'name', 'version', 'summary', 'description', 'tags', 'provenance'], 'blueprint');
  slug(b.key, 'blueprint.key', 3); text(b.name, 'blueprint.name', 200, 1); integer(b.version, 'blueprint.version', 1, 2147483647);
  text(b.summary, 'blueprint.summary', 500); text(b.description, 'blueprint.description'); strings(b.tags, 'blueprint.tags');
  choice(b.provenance, ['human-authored', 'imported', 'agent-drafted'], 'blueprint.provenance');
  const limits = currentBlueprintLimits();
  for (const field of ['parameters', 'references', 'phases', 'tasks', 'humanGates', 'reports', 'dependencies'] as const) list(d[field], field, limits[field]);
  const parameters = new Map<string, RecordValue>();
  d.parameters.forEach((p, i) => {
    const f = `parameters.${i}`; object(p, ['key', 'label', 'promptText', 'help', 'type', 'required', 'default', 'order', 'constraints'], ['key', 'label', 'promptText', 'type', 'required'], f);
    if (typeof p.key !== 'string' || !PARAMETER_KEY.test(p.key) || parameters.has(p.key) || CREDENTIAL_WORD.test(p.key)) fail(f + '.key', 'Invalid or duplicate parameter key');
    choice(p.type, PARAMETER_TYPES, f + '.type'); if (typeof p.required !== 'boolean') fail(f + '.required', 'Expected boolean');
    optionalText(p, ['label', 'promptText', 'help'], f, 1000);
    if (['label', 'promptText', 'help'].some(k => CREDENTIAL_WORD.test(p[k] || ''))) fail(f, 'A Blueprint cannot ask for credentials');
    if (p.order !== undefined) integer(p.order, f + '.order', 0, 10000);
    if (p.constraints !== undefined) {
      const c = object(p.constraints, ['minLength', 'maxLength', 'pattern', 'enum', 'min', 'max'], [], f + '.constraints');
      for (const k of ['minLength', 'maxLength']) if (c[k] != null) { if (!['string', 'text'].includes(p.type)) fail(f, 'Constraint does not match parameter type'); integer(c[k], f + '.' + k, 0, 8192); }
      for (const k of ['min', 'max']) if (c[k] != null) { if (p.type !== 'integer') fail(f, 'Constraint does not match parameter type'); integer(c[k], f + '.' + k, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER); }
      if (c.pattern != null) { if (p.type !== 'string') fail(f, 'Pattern requires a string'); compileBlueprintPattern(c.pattern); }
      if (c.enum != null) { if (p.type !== 'enum') fail(f, 'Enum requires enum type'); strings(c.enum, f + '.enum'); if (!c.enum.length || new Set(c.enum).size !== c.enum.length) fail(f, 'Enum must contain unique choices'); }
      if (p.type === 'enum' && !c.enum) fail(f, 'Enum choices required');
      if (c.min != null && c.max != null && c.min > c.max || c.minLength != null && c.maxLength != null && c.minLength > c.maxLength) fail(f, 'Reversed bounds');
    } else if (p.type === 'enum') fail(f, 'Enum choices required');
    if (p.type.endsWith('-ref') && p.default != null) fail(f, 'Reference defaults are not portable');
    if (p.default != null) validateValue(p, p.default);
    parameters.set(p.key, p);
  });
  const target = object(d.target, ['mode', 'project', 'allowExisting'], ['mode', 'project'], 'target');
  choice(target.mode, ['new-project', 'existing-project'], 'target.mode');
  if (target.allowExisting !== undefined && (target.mode !== 'new-project' || typeof target.allowExisting !== 'boolean')) fail('target.allowExisting','Only a new-project default may offer an existing Project');
  if (target.mode === 'new-project') { const p = object(target.project, ['name', 'description', 'goal', 'tags'], ['name'], 'target.project'); text(p.name, 'target.project.name', 200, 1); optionalText(p, ['description', 'goal'], 'target.project'); if (p.tags) strings(p.tags, 'target.project.tags'); }
  else text(target.project, 'target.project', 68, 5);
  const fieldChoice = (value: any, choices: readonly string[], field: string) => {
    const match = typeof value === 'string' && /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(value);
    if (!match) return choice(value, choices, field);
    const parameter = parameters.get(match[1]);
    if (!parameter || parameter.type !== 'enum' || !parameter.required && parameter.default == null
      || !parameter.constraints?.enum?.every((entry: string) => choices.includes(entry))) fail(field, 'An enum placeholder must declare only valid field choices and an optional default');
  };
  const keys = new Set<string>(); const phases = new Set<string>(); const tasks = new Set<string>();
  const key = (row: RecordValue, f: string) => { slug(row.key, f + '.key'); if (keys.has(row.key)) fail(f, 'Duplicate local key'); keys.add(row.key); };
  for (const p of d.phases) { object(p, ['key', 'name', 'goal', 'position', 'status'], ['key', 'name'], 'phases'); key(p, 'phases'); text(p.name, 'phases.name', 200, 1); optionalText(p, ['goal'], 'phases'); if (p.status) choice(p.status, ['todo', 'in-progress', 'completed'], 'phases.status'); if (p.position !== undefined) integer(p.position, 'phases.position', 0, 100000); phases.add(p.key); }
  for (const t of d.tasks) {
    object(t, ['key', 'title', 'description', 'definitionOfDone', 'successCriteria', 'constraints', 'notes', 'phase', 'status', 'priority', 'tags', 'thinking', 'subtasks', 'roles', 'defaults', 'references'], ['key', 'title'], 'tasks'); key(t, 'tasks'); tasks.add(t.key); text(t.title, 'tasks.title', 500, 1); optionalText(t, ['description', 'notes'], 'tasks');
    for (const field of ['definitionOfDone', 'successCriteria', 'constraints']) {
      if (Array.isArray(t[field])) list(t[field], 'tasks.' + field, 100).forEach((value, index) => text(value, 'tasks.' + field + '.' + index));
      else optionalText(t, [field], 'tasks');
    }
    if (t.status) choice(t.status, ['ideas', 'todo'], 'tasks.status'); if (t.priority) fieldChoice(t.priority, ['urgent', 'high', 'normal', 'low', 'someday'], 'tasks.priority'); if (t.thinking) fieldChoice(t.thinking, ['low', 'medium', 'high'], 'tasks.thinking');
    if (t.tags) strings(t.tags, 'tasks.tags'); if (t.references) strings(t.references, 'tasks.references', limits.references);
    if (t.subtasks) list(t.subtasks, 'tasks.subtasks', limits.subtasks).forEach(s => { object(s, ['text'], ['text'], 'subtasks'); text(s.text, 'subtasks.text', 1000, 1); });
    if (t.roles) { object(t.roles, ['shepherd', 'verifier'], [], 'tasks.roles'); optionalText(t.roles, ['shepherd', 'verifier'], 'tasks.roles', 68); }
    if (t.defaults) {
      const f = object(t.defaults, ['personality', 'model', 'maxRetries', 'executionProfile'], [], 'tasks.defaults'); optionalText(f, ['personality', 'model'], 'tasks.defaults', 200);
      if (f.maxRetries !== undefined) {
        const match = typeof f.maxRetries === 'string' && /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(f.maxRetries);
        if (match) {
          const parameter = parameters.get(match[1]);
          if (!parameter || parameter.type !== 'integer' || !parameter.required && parameter.default == null
            || parameter.constraints?.min == null || parameter.constraints?.max == null
            || parameter.constraints.min < 0 || parameter.constraints.max > 100) fail('maxRetries','Retry placeholder must be an integer bounded to 0..100');
        } else integer(f.maxRetries, 'maxRetries', 0, 100);
      }
      if (f.executionProfile) { const e = object(f.executionProfile, ['service', 'options', 'parameters'], ['service', 'options'], 'executionProfile'); text(e.service, 'executionProfile.service', 200, 1); if (!e.options || typeof e.options !== 'object' || Array.isArray(e.options)) fail('executionProfile.options', 'Expected options object'); if (Object.keys(e.options).some(key => /\{\{|\}\}/.test(key))) fail('executionProfile.options', 'Substitution is not allowed in field names'); if (e.parameters !== undefined) {
        if (!e.parameters || typeof e.parameters !== 'object' || Array.isArray(e.parameters)) fail('executionProfile.parameters','Expected parameter maps');
        for (const [key,map] of Object.entries(e.parameters)) {
          if (/\{\{|\}\}/.test(key) || !map || typeof map !== 'object' || Array.isArray(map)
            || Object.keys(map).some(name=>/\{\{|\}\}/.test(name))) fail('executionProfile.parameters','Expected fixed parameter names and maps');
        }
      } }
    }
  }
  for (const g of d.humanGates) {
    object(g, ['key', 'title', 'phase', 'decisionPrompt', 'decider', 'arms'], ['key', 'title', 'decisionPrompt', 'decider', 'arms'], 'humanGates'); key(g, 'humanGates'); tasks.add(g.key); text(g.title, 'humanGates.title', 500, 1); text(g.decisionPrompt, 'humanGates.decisionPrompt'); text(g.decider, 'humanGates.decider', 68);
    const arms = list(g.arms, 'humanGates.arms', limits.arms); if (!arms.length) fail('humanGates.arms', 'At least one arm required'); const armKeys = new Set<string>();
    for (const arm of arms) { object(arm, ['key', 'label', 'tasks'], ['key', 'label', 'tasks'], 'arm'); slug(arm.key, 'arm.key'); if (armKeys.has(arm.key)) fail('arm.key', 'Duplicate arm key'); armKeys.add(arm.key); text(arm.label, 'arm.label', 500, 1); strings(arm.tasks, 'arm.tasks', limits.tasks); }
  }
  if (tasks.size > limits.tasks) fail('tasks', `Expanded task count exceeds ${limits.tasks}`);
  for (const t of [...d.tasks, ...d.humanGates]) if (t.phase != null && !phases.has(t.phase) && !(target.mode === 'existing-project' && /^\{\{[a-z][a-z0-9_]*\}\}$/.test(t.phase))) fail('phase', 'Unknown phase key');
  for (const r of d.reports) { object(r, ['key', 'title', 'summary', 'content', 'tasks', 'tags'], ['key', 'title', 'content', 'tasks'], 'reports'); key(r, 'reports'); text(r.title, 'reports.title', 500, 1); optionalText(r, ['summary'], 'reports', 500); text(r.content, 'reports.content', 65536); strings(r.tasks, 'reports.tasks', limits.tasks); for (const t of r.tasks) if (!tasks.has(t)) fail('reports.tasks', 'Unknown task key'); if (r.tags) strings(r.tags, 'reports.tags'); }
  const references = new Set<string>();
  for (const r of d.references) { object(r, ['kind', 'name', 'service', 'minVersion', 'descriptorSha256', 'pluginVersion', 'tool', 'requirement', 'usedBy', 'purpose'], ['kind', 'name', 'requirement'], 'references'); if (!(typeof r.kind === 'string' && /^plugin:[a-z0-9][a-z0-9._-]{1,63}:[a-z0-9][a-z0-9_-]{1,63}$/.test(r.kind))) choice(r.kind, ['skill', 'personality', 'service', 'tool', 'plugin', 'principal', 'report', 'task', 'phase', 'project'], 'references.kind');
    if (r.descriptorSha256 !== undefined && (typeof r.descriptorSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.descriptorSha256))) fail('references.descriptorSha256','Expected a descriptor digest');
    if (r.kind.startsWith('plugin:') && (!r.service || !r.tool || typeof r.pluginVersion !== 'string')) fail('references','Plugin functions require the registry Service, tool and version');
 text(r.name, 'references.name', 200, 1); const refKey = `${r.kind}:${r.service || ''}:${r.name}`; if (references.has(refKey)) fail('references', 'Duplicate reference'); references.add(refKey); choice(r.requirement, ['required', 'optional'], 'references.requirement'); optionalText(r, ['purpose', 'service'], 'references'); if (r.kind === 'tool' && !r.service) fail('references.service', 'Tool references require a service name'); if (r.minVersion != null) { if (r.kind === 'plugin') { if (typeof r.minVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(r.minVersion)) fail('references.minVersion', 'Expected semantic version'); } else integer(r.minVersion, 'references.minVersion', 1, 2147483647); } if (r.usedBy) { strings(r.usedBy, 'references.usedBy', limits.tasks); if (r.usedBy.some((k: string) => !tasks.has(k))) fail('references.usedBy', 'Unknown task key'); } }
  for (const t of d.tasks) for (const ref of t.references || []) if (!d.references.some(r => r.name === ref)) fail('tasks.references', 'Undeclared reference');
  for (const edge of d.dependencies) { object(edge, ['task', 'dependsOn'], ['task', 'dependsOn'], 'dependencies'); if (!tasks.has(edge.task) || !tasks.has(edge.dependsOn) || edge.task === edge.dependsOn) fail('dependencies', 'Invalid dependency'); }
  for (const g of d.humanGates) for (const arm of g.arms) for (const t of arm.tasks) if (!d.tasks.some(row => row.key === t)) fail('humanGates.arms.tasks', 'Unknown arm task');
  const edges = expandedDependencies(d); if (edges.length > limits.dependencies) fail('dependencies', `Expanded dependency count exceeds ${limits.dependencies}`);
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) fail('dependencies', 'Dependency cycle'); if (visited.has(id)) return; visiting.add(id); for (const e of edges) if (e.task === id) visit(e.dependsOn); visiting.delete(id); visited.add(id); };
  tasks.forEach(visit);
  if (credentialShaped(d)) fail('document', 'Credential-shaped literal refused');
  walk(d, (v, path) => {
    // The discriminator is a fixed public format name, never an address.
    if (!(path.length === 1 && path[0] === 'schemaVersion') && Object.values(BLUEPRINT_FORBIDDEN_LITERAL_SHAPES).some(pattern => pattern.test(v))) fail(path.join('.'), 'Installation identifiers and addresses are not portable');
    const matches = [...v.matchAll(PLACEHOLDER)]; const slot = bindingType(path);
    if (slot === 'principal-ref' && !/^\{\{[a-z][a-z0-9_]*\}\}$/.test(v)
      && !d.references.some(reference => reference.kind === 'principal' && reference.name === v)) fail(path.join('.'), 'A fixed role requires a declared Principal reference');

    if (slot && (path.join('.') === 'target.project' && target.mode === 'existing-project') && !/^\{\{[a-z][a-z0-9_]*\}\}$/.test(v)) fail(path.join('.'), 'This slot requires a typed parameter binding');
    for (const match of matches) {
      const p = parameters.get(match[1]); if (!p) fail(path.join('.'), 'Undeclared parameter ' + match[1]);
      if (slot) { if (v !== match[0] || p!.type !== slot) fail(path.join('.'), 'Binding type mismatch'); }
      else if ((!substitutable(path) && !descriptorOptionSlot(path)) || !TEXT_PARAMETER_TYPES.has(p!.type)) fail(path.join('.'), 'Substitution is not allowed in this field');
    }
    if (/\{\{|\}\}/.test(v.replace(PLACEHOLDER, ''))) fail(path.join('.'), 'Malformed placeholder');
  });
  return JSON.parse(stableBlueprintJson(d));
}
function validateValue(p: RecordValue, value: unknown): void {
  const c = p.constraints || {}; const bad = () => { throw new BlueprintError(422, 'PARAMETER_VALUE_REFUSED', 'Parameter value refused', p.key); };
  if (p.type === 'integer') { if (!Number.isSafeInteger(value) || c.min != null && (value as number) < c.min || c.max != null && (value as number) > c.max) bad(); }
  else if (p.type === 'boolean') { if (typeof value !== 'boolean') bad(); }
  else {
    if (typeof value !== 'string' || value.length > 8192) return bad();
    if (p.type === 'string' && /[\r\n]/.test(value)) bad();
    if (p.type === 'enum' && !c.enum?.includes(value)) bad();
    if (p.type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00.000Z')) || new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) !== value) bad(); }
    if (c.minLength != null && value.length < c.minLength || c.maxLength != null && value.length > c.maxLength || c.pattern && !compileBlueprintPattern(c.pattern)(value)) bad();
  }
}
export function validateBlueprintValues(document: BlueprintDocument, supplied: unknown, targetMode?: string): RecordValue {
  // Check shape without echoing unknown keys, then screen all submitted
  // values before schema/default processing or any downstream sink.
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.getPrototypeOf(supplied) !== Object.prototype) fail('parameterValues','Expected a plain object');
  for (const [key,value] of Object.entries(supplied as RecordValue)) if (credentialShaped(key) || credentialShaped(value)) throw new BlueprintError(422,'PARAMETER_VALUE_REFUSED','Parameter value refused',credentialShaped(key) ? 'parameterValues' : key);
  const values = object(supplied, document.parameters.map(p => p.key), [], 'parameterValues');
  const materialized: RecordValue = {};
  const nonTargetFields=stableBlueprintJson({tasks:document.tasks,phases:document.phases,humanGates:document.humanGates,reports:document.reports});
  const newProjectFields=stableBlueprintJson(document.target.project);
  for (const p of document.parameters) {
    const value = values[p.key] === undefined ? p.default : values[p.key];
    if (value === null || value === undefined || value === '') { if (p.required && !(targetMode==='existing-project' && document.target.allowExisting && newProjectFields.includes('{{'+p.key+'}}') && !nonTargetFields.includes('{{'+p.key+'}}'))) throw new BlueprintError(422, 'PARAMETER_VALUE_REFUSED', 'Required parameter value missing', p.key); materialized[p.key] = null; }
    else { validateValue(p, value); materialized[p.key] = value; }
  }
  return materialized;
}
export function expandedDependencies(document: BlueprintDocument): Array<{ task: string; dependsOn: string }> {
  const edges = new Map(document.dependencies.map(e => [`${e.task}:${e.dependsOn}`, e]));
  for (const g of document.humanGates) {
    const reachable = new Set<string>(g.arms.flatMap((a: RecordValue) => a.tasks));
    let changed = true;
    while (changed) { changed = false; for (const e of document.dependencies) if (reachable.has(e.dependsOn) && !reachable.has(e.task)) { reachable.add(e.task); changed = true; } }
    for (const task of reachable) edges.set(`${task}:${g.key}`, { task, dependsOn: g.key });
  }
  return [...edges.values()].sort((a, b) => a.task.localeCompare(b.task) || a.dependsOn.localeCompare(b.dependsOn));
}
/** Exactly one literal pass; inserted braces are never scanned again. */
export function substituteBlueprintText(value: string, values: RecordValue): string {
  return value.replace(PLACEHOLDER, (_match, key) => values[key] == null ? '' : typeof values[key] === 'boolean' ? values[key] ? 'yes' : 'no' : String(values[key]));
}
export function substituteBlueprint(document: BlueprintDocument, values: RecordValue): BlueprintDocument {
  const transform = (value: any, path: string[] = []): any => {
    if (typeof value === 'string' && path[path.length-1] === 'maxRetries') {
      const key = /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(value)?.[1];
      if (key) return values[key];
    }
    if (typeof value === 'string') return substitutable(path) ? substituteBlueprintText(value, values) : value;
    if (Array.isArray(value)) return value.map((v, i) => transform(v, [...path, String(i)]));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, transform(v, [...path, k])]));
    return value;
  };
  return transform(document);
}
