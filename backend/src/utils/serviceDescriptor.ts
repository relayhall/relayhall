/**
 * Capability-descriptor validation (RH-P2.1; strategy §2.1 as amended by
 * E-17, task-element design e20a12d6 §6 + §13 R5).
 *
 * A descriptor is an OPAQUE TYPED OPTION LIST: the board validates shape and
 * renders pickers; it never interprets the values — each connector owns its
 * vocabulary. E-17 amends the ratified flat-options cut to allow exactly ONE
 * level of typed parameters per option (a list, still never a tree).
 *
 * The four E-17 obligations, enforced structurally here:
 *  1. Parameters never carry credentials — a secretReference declares
 *     connector-resolved reference NAMES (allowedReferences) and can never
 *     carry a default or inline value; secret bytes never reach the board.
 *  2. Filling arguments IS choosing what executes — the profile-set paths
 *     (RH-P2.2) consult assignment authority / services:invoke; nothing in
 *     this module weakens that.
 *  3. Parameter values are untrusted text under the C2 structural
 *     convention; they reach executors as typed quoted-JSON, declared
 *     best-effort at the estate-side connector boundary (R5).
 *  4. Version pinning covers parameter schemas — parameters live inside the
 *     versioned descriptor blob, so a pin covers them by construction.
 */

export const DESCRIPTOR_MAX_BYTES = 262144; // 256 KiB serialized
export const DESCRIPTOR_MAX_OPTIONS = 64;
export const DESCRIPTOR_MAX_VALUES = 256;
export const DESCRIPTOR_MAX_PARAMETERS = 32;
export const DESCRIPTOR_MAX_TOOLS = 128;
export const DESCRIPTOR_MAX_REFERENCES = 64;
export const DESCRIPTOR_MAX_HELP_LENGTH = 1024;
export const DESCRIPTOR_MAX_LABEL_LENGTH = 128;
/** KNOWLEDGE-DESIGN `94747de9` §4.3: `classes` is 1..16, `compartments` 1..64. */
export const DESCRIPTOR_MAX_KNOWLEDGE_CLASSES = 16;
export const DESCRIPTOR_MAX_KNOWLEDGE_COMPARTMENTS = 64;

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const OPTION_TYPES = [
  'enum',
  'boolean',
  'number',
  'string',
  'secretReference',
  'resourceSelector',
] as const;
export type OptionType = (typeof OPTION_TYPES)[number];

/**
 * §4.3: what a declared knowledge class CONTAINS. Core uses this for the
 * §5.5 class arm only — `mixed` matches every requested kind — and never as
 * a permission input. Declared-and-displayed, like every other descriptor
 * value: the board renders it and never interprets it further.
 */
export const KNOWLEDGE_CONTENT_KINDS = ['code', 'docs', 'data', 'mixed'] as const;
export type KnowledgeContentKind = (typeof KNOWLEDGE_CONTENT_KINDS)[number];

export interface DescriptorEnumValue {
  value: string;
  label?: string;
}

export interface DescriptorParameter {
  key: string;
  type: OptionType;
  label?: string;
  help?: string;
  required?: boolean;
  default?: string | number | boolean;
  values?: DescriptorEnumValue[];
  allowedReferences?: string[];
}

export interface DescriptorOption extends DescriptorParameter {
  /** E-17: one level of typed parameters per option — never nested further. */
  parameters?: DescriptorParameter[];
}

export interface DescriptorTool {
  name: string;
  description?: string;
}

/**
 * The telemetry declaration (owner decision D3; design 7d5c0cdc §5.2, ratified
 * as TS-3).
 *
 * Descriptors are stored as IMMUTABLE VERSIONED JSONB in
 * `service_descriptor_versions` (migration 076), so declaring a tier means
 * publishing a NEW descriptor version — never editing one in place.
 *
 * Both fields are enforced at ingest, and both are deny-by-default: a
 * Connector with no `telemetry` block cannot write envelopes at all, and a
 * declared block with no `products` reports no products rather than all of
 * them. An allowlist that defaults to "everything" is not an allowlist.
 */
export interface DescriptorTelemetry {
  /** What this connector SENDS (ratified strategy §2.6.5). */
  tier: 'none' | 'presence' | 'full';
  /**
   * The adapter/product list this credential may report under (§5.2). One
   * Connector credential per installed outpost; a multi-tool outpost names
   * every product it reports here, and an envelope naming anything else is
   * rejected at ingest.
   */
  products?: string[];
}

/** §4.3: one declared class of content this source serves. */
export interface DescriptorKnowledgeClass {
  key: string;
  label?: string;
  content: KnowledgeContentKind;
}

/**
 * §4.3 — the declared-and-displayed knowledge block.
 *
 * `compartments` is REQUIRED NON-EMPTY (sol R1-3). §4.3 states the reason
 * exactly: "a uniform/unpartitioned corpus declares ONE canonical
 * compartment (e.g. 'corpus'), so §7.2's required-equality check can never
 * make a contract-valid source unusable". An optional list would let a
 * source register with no compartment and then fail every result at the
 * equality check with nothing the operator could read as the cause.
 *
 * These are DECLARED NAMES, never membership (G-7). Core validates result
 * labels against them (§7.2) and displays provenance; permission truth
 * stays satellite-side (§6.1).
 */
export interface DescriptorKnowledgeSource {
  classes: DescriptorKnowledgeClass[];
  compartments: string[];
}

export interface ServiceDescriptor {
  options: DescriptorOption[];
  /** Declared exposed Tools (D-3): registry data; the Tool surface lands later in Phase 2. */
  tools?: DescriptorTool[];
  /** Schema seat only — the discovery fetch machinery is RH-P2.2. */
  discovery?: { optionsEndpoint: string };
  /** Schema seat only — probe machinery lands with the consuming phase. */
  health?: { endpoint: string };
  /** D3: the telemetry tier and product allowlist, enforced at envelope ingest. */
  telemetry?: DescriptorTelemetry;
  /**
   * KNOWLEDGE-DESIGN `94747de9` §4.3. Agent-plane (`services:write`): a
   * re-declaration narrows or widens which QUERIES route to this source
   * (visible in coverage), never WHERE anything is sent — §4.2's
   * owner-plane endpoint owns that — and never whether identity is
   * disclosed. Declaring the block is one HALF of the knowledge-capability
   * predicate; the owner-plane endpoint is the other, and neither half
   * alone makes a Service knowledge-capable.
   */
  knowledgeSource?: DescriptorKnowledgeSource;
}

/** E-11 rich errors: every failure names the field, what was wrong, and the accepted form. */
export class DescriptorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = 'DescriptorError';
  }
}

const fail = (code: string, message: string, field: string): never => {
  throw new DescriptorError(code, message, field);
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: string[],
  field: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(
        'DESCRIPTOR_UNKNOWN_FIELD',
        `Unknown field '${key}' — accepted fields are: ${allowed.join(', ')}`,
        `${field}.${key}`,
      );
    }
  }
}

function validateKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    fail(
      'DESCRIPTOR_INVALID_KEY',
      `'key' must match ${KEY_PATTERN} (letters, digits, '_' or '-', starting with a letter, max 64 chars)`,
      field,
    );
  }
  return value as string;
}

function validateHttpUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    fail('DESCRIPTOR_INVALID_URL', 'Expected a non-empty http(s) URL of at most 2048 characters', field);
  }
  let parsed: URL;
  try {
    parsed = new URL(value as string);
  } catch {
    return fail('DESCRIPTOR_INVALID_URL', 'Expected a valid absolute http(s) URL', field) as never;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('DESCRIPTOR_INVALID_URL', `URL scheme must be http or https, got '${parsed.protocol}'`, field);
  }
  return value as string;
}

function validateEnumValues(raw: unknown, field: string): DescriptorEnumValue[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('DESCRIPTOR_INVALID_VALUES', "'values' must be a non-empty array for type 'enum'", field);
  }
  const arr = raw as unknown[];
  if (arr.length > DESCRIPTOR_MAX_VALUES) {
    fail(
      'DESCRIPTOR_TOO_LARGE',
      `'values' exceeds the ${DESCRIPTOR_MAX_VALUES}-entry bound`,
      field,
    );
  }
  const seen = new Set<string>();
  return arr.map((entry, i) => {
    const entryField = `${field}[${i}]`;
    if (!isPlainObject(entry)) {
      fail('DESCRIPTOR_INVALID_VALUES', "each enum value must be an object {value, label?}", entryField);
    }
    const obj = entry as Record<string, unknown>;
    rejectUnknownKeys(obj, ['value', 'label'], entryField);
    if (typeof obj.value !== 'string' || obj.value.length === 0 || obj.value.length > 256) {
      fail('DESCRIPTOR_INVALID_VALUES', "'value' must be a non-empty string of at most 256 characters", `${entryField}.value`);
    }
    if (obj.label !== undefined && (typeof obj.label !== 'string' || obj.label.length > DESCRIPTOR_MAX_LABEL_LENGTH)) {
      fail('DESCRIPTOR_INVALID_LABEL', `'label' must be a string of at most ${DESCRIPTOR_MAX_LABEL_LENGTH} characters`, `${entryField}.label`);
    }
    const v = obj.value as string;
    if (seen.has(v)) {
      fail('DESCRIPTOR_DUPLICATE_VALUE', `duplicate enum value '${v}'`, `${entryField}.value`);
    }
    seen.add(v);
    return { value: v, ...(obj.label !== undefined ? { label: obj.label as string } : {}) };
  });
}

function validateParameter(
  raw: unknown,
  field: string,
  allowNestedParameters: boolean,
): DescriptorOption {
  if (!isPlainObject(raw)) {
    fail('DESCRIPTOR_INVALID_OPTION', 'each entry must be an object', field);
  }
  const obj = raw as Record<string, unknown>;
  if (!allowNestedParameters && 'parameters' in obj) {
    // E-17: one level deep — a parameter can never carry parameters of its
    // own. Checked before the generic unknown-field rejection so the
    // specific rule is the one a connector author reads.
    fail(
      'DESCRIPTOR_NESTED_PARAMETERS',
      "parameters may not be nested — E-17 allows one level of typed parameters per option, never a tree",
      `${field}.parameters`,
    );
  }
  const allowed = [
    'key', 'type', 'label', 'help', 'required', 'default', 'values', 'allowedReferences',
    ...(allowNestedParameters ? ['parameters'] : []),
  ];
  rejectUnknownKeys(obj, allowed, field);

  const key = validateKey(obj.key, `${field}.key`);
  if (typeof obj.type !== 'string' || !(OPTION_TYPES as readonly string[]).includes(obj.type)) {
    fail(
      'DESCRIPTOR_INVALID_TYPE',
      `'type' must be one of: ${OPTION_TYPES.join(', ')}`,
      `${field}.type`,
    );
  }
  const type = obj.type as OptionType;

  if (obj.label !== undefined && (typeof obj.label !== 'string' || obj.label.length > DESCRIPTOR_MAX_LABEL_LENGTH)) {
    fail('DESCRIPTOR_INVALID_LABEL', `'label' must be a string of at most ${DESCRIPTOR_MAX_LABEL_LENGTH} characters`, `${field}.label`);
  }
  if (obj.help !== undefined && (typeof obj.help !== 'string' || obj.help.length > DESCRIPTOR_MAX_HELP_LENGTH)) {
    fail('DESCRIPTOR_INVALID_HELP', `'help' must be a string of at most ${DESCRIPTOR_MAX_HELP_LENGTH} characters`, `${field}.help`);
  }
  if (obj.required !== undefined && typeof obj.required !== 'boolean') {
    fail('DESCRIPTOR_INVALID_REQUIRED', "'required' must be a boolean", `${field}.required`);
  }

  const out: DescriptorOption = { key, type };
  if (obj.label !== undefined) out.label = obj.label as string;
  if (obj.help !== undefined) out.help = obj.help as string;
  if (obj.required !== undefined) out.required = obj.required as boolean;

  if (type === 'enum') {
    out.values = validateEnumValues(obj.values, `${field}.values`);
  } else if (obj.values !== undefined) {
    fail('DESCRIPTOR_INVALID_VALUES', `'values' is only accepted on type 'enum', not '${type}'`, `${field}.values`);
  }

  if (type === 'secretReference') {
    // R5: secret-typed entries carry connector-resolved reference NAMES,
    // never free-form caller input and never secret bytes on the board.
    if (obj.default !== undefined) {
      fail(
        'DESCRIPTOR_SECRET_VALUE',
        "a secretReference can never carry a 'default' — the board stores reference names, never secret material (RH-DESIGN.5 R5)",
        `${field}.default`,
      );
    }
    if (!Array.isArray(obj.allowedReferences) || obj.allowedReferences.length === 0) {
      fail(
        'DESCRIPTOR_MISSING_REFERENCES',
        "type 'secretReference' requires a non-empty 'allowedReferences' array of connector-resolved reference names",
        `${field}.allowedReferences`,
      );
    }
    const refs = obj.allowedReferences as unknown[];
    if (refs.length > DESCRIPTOR_MAX_REFERENCES) {
      fail('DESCRIPTOR_TOO_LARGE', `'allowedReferences' exceeds the ${DESCRIPTOR_MAX_REFERENCES}-entry bound`, `${field}.allowedReferences`);
    }
    const seen = new Set<string>();
    out.allowedReferences = refs.map((ref, i) => {
      if (typeof ref !== 'string' || !KEY_PATTERN.test(ref)) {
        fail(
          'DESCRIPTOR_INVALID_REFERENCE',
          `each reference name must match ${KEY_PATTERN} — a NAME the connector resolves on its own side, never a secret value`,
          `${field}.allowedReferences[${i}]`,
        );
      }
      if (seen.has(ref as string)) {
        fail('DESCRIPTOR_DUPLICATE_REFERENCE', `duplicate reference name '${ref}'`, `${field}.allowedReferences[${i}]`);
      }
      seen.add(ref as string);
      return ref as string;
    });
  } else if (obj.allowedReferences !== undefined) {
    fail(
      'DESCRIPTOR_INVALID_REFERENCE',
      `'allowedReferences' is only accepted on type 'secretReference', not '${type}'`,
      `${field}.allowedReferences`,
    );
  }

  if (obj.default !== undefined && type !== 'secretReference') {
    const d = obj.default;
    const typeOk =
      (type === 'boolean' && typeof d === 'boolean') ||
      (type === 'number' && typeof d === 'number' && Number.isFinite(d)) ||
      ((type === 'string' || type === 'resourceSelector') && typeof d === 'string' && (d as string).length <= 4096) ||
      (type === 'enum' && typeof d === 'string');
    if (!typeOk) {
      fail(
        'DESCRIPTOR_INVALID_DEFAULT',
        `'default' must match the declared type '${type}'`,
        `${field}.default`,
      );
    }
    if (type === 'enum' && !(out.values ?? []).some((v) => v.value === d)) {
      fail(
        'DESCRIPTOR_INVALID_DEFAULT',
        `'default' must be one of the declared enum values`,
        `${field}.default`,
      );
    }
    out.default = d as string | number | boolean;
  }

  return out;
}

function validateParameterList(
  raw: unknown,
  field: string,
): DescriptorParameter[] {
  if (!Array.isArray(raw)) {
    fail('DESCRIPTOR_INVALID_PARAMETERS', "'parameters' must be an array of typed parameter objects", field);
  }
  const arr = raw as unknown[];
  if (arr.length > DESCRIPTOR_MAX_PARAMETERS) {
    fail('DESCRIPTOR_TOO_LARGE', `'parameters' exceeds the ${DESCRIPTOR_MAX_PARAMETERS}-entry bound`, field);
  }
  const seen = new Set<string>();
  return arr.map((entry, i) => {
    const param = validateParameter(entry, `${field}[${i}]`, false);
    if (seen.has(param.key)) {
      fail('DESCRIPTOR_DUPLICATE_KEY', `duplicate parameter key '${param.key}'`, `${field}[${i}].key`);
    }
    seen.add(param.key);
    return param;
  });
}

/**
 * Validate an incoming descriptor. Throws DescriptorError naming the exact
 * field on the first failure; returns the normalized descriptor on success.
 */
export function validateDescriptor(input: unknown): ServiceDescriptor {
  if (!isPlainObject(input)) {
    fail('DESCRIPTOR_INVALID', 'A descriptor must be a JSON object with an options array', 'descriptor');
  }
  const obj = input as Record<string, unknown>;
  rejectUnknownKeys(
    obj,
    ['options', 'tools', 'discovery', 'health', 'telemetry', 'knowledgeSource'],
    'descriptor',
  );

  const serialized = JSON.stringify(obj);
  if (Buffer.byteLength(serialized, 'utf8') > DESCRIPTOR_MAX_BYTES) {
    fail(
      'DESCRIPTOR_TOO_LARGE',
      `Descriptor exceeds the ${DESCRIPTOR_MAX_BYTES}-byte bound`,
      'descriptor',
    );
  }

  if (!Array.isArray(obj.options)) {
    fail('DESCRIPTOR_INVALID_OPTIONS', "'options' must be an array (empty is allowed for a service that declares no execution options)", 'descriptor.options');
  }
  const optionsRaw = obj.options as unknown[];
  if (optionsRaw.length > DESCRIPTOR_MAX_OPTIONS) {
    fail('DESCRIPTOR_TOO_LARGE', `'options' exceeds the ${DESCRIPTOR_MAX_OPTIONS}-entry bound`, 'descriptor.options');
  }
  const seenOptions = new Set<string>();
  const options = optionsRaw.map((entry, i) => {
    const option = validateParameter(entry, `descriptor.options[${i}]`, true);
    if (seenOptions.has(option.key)) {
      fail('DESCRIPTOR_DUPLICATE_KEY', `duplicate option key '${option.key}'`, `descriptor.options[${i}].key`);
    }
    seenOptions.add(option.key);
    const rawEntry = entry as Record<string, unknown>;
    if (rawEntry.parameters !== undefined) {
      option.parameters = validateParameterList(rawEntry.parameters, `descriptor.options[${i}].parameters`);
    }
    return option;
  });

  const descriptor: ServiceDescriptor = { options };

  if (obj.telemetry !== undefined) {
    // D3 validation. A malformed telemetry block is a REFUSED descriptor, not a
    // silently-ignored one: a connector that believes it declared Tier 0 and
    // did not would fail closed at ingest with no idea why.
    if (!isPlainObject(obj.telemetry)) {
      fail('DESCRIPTOR_INVALID_TELEMETRY', "'telemetry' must be an object {tier, products?}", 'descriptor.telemetry');
    }
    const telemetry = obj.telemetry as Record<string, unknown>;
    rejectUnknownKeys(telemetry, ['tier', 'products'], 'descriptor.telemetry');
    if (telemetry.tier !== 'none' && telemetry.tier !== 'presence' && telemetry.tier !== 'full') {
      fail('DESCRIPTOR_INVALID_TELEMETRY', "'tier' must be one of: none, presence, full", 'descriptor.telemetry.tier');
    }
    const declared: DescriptorTelemetry = { tier: telemetry.tier as DescriptorTelemetry['tier'] };
    if (telemetry.products !== undefined) {
      if (!Array.isArray(telemetry.products) || telemetry.products.length > DESCRIPTOR_MAX_TOOLS) {
        fail('DESCRIPTOR_INVALID_TELEMETRY', `'products' must be an array of at most ${DESCRIPTOR_MAX_TOOLS} product keys`, 'descriptor.telemetry.products');
      }
      const seenProducts = new Set<string>();
      declared.products = (telemetry.products as unknown[]).map((entry, i) => {
        if (typeof entry !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(entry)) {
          fail('DESCRIPTOR_INVALID_TELEMETRY', 'each product must be a bounded product key', `descriptor.telemetry.products[${i}]`);
        }
        const product = entry as string;
        if (seenProducts.has(product)) {
          fail('DESCRIPTOR_DUPLICATE_KEY', `duplicate product '${product}'`, `descriptor.telemetry.products[${i}]`);
        }
        seenProducts.add(product);
        return product;
      });
    }
    descriptor.telemetry = declared;
  }

  if (obj.tools !== undefined) {
    if (!Array.isArray(obj.tools)) {
      fail('DESCRIPTOR_INVALID_TOOLS', "'tools' must be an array of {name, description?} declarations", 'descriptor.tools');
    }
    const toolsRaw = obj.tools as unknown[];
    if (toolsRaw.length > DESCRIPTOR_MAX_TOOLS) {
      fail('DESCRIPTOR_TOO_LARGE', `'tools' exceeds the ${DESCRIPTOR_MAX_TOOLS}-entry bound`, 'descriptor.tools');
    }
    const seenTools = new Set<string>();
    descriptor.tools = toolsRaw.map((entry, i) => {
      const entryField = `descriptor.tools[${i}]`;
      if (!isPlainObject(entry)) {
        fail('DESCRIPTOR_INVALID_TOOLS', 'each declared Tool must be an object {name, description?}', entryField);
      }
      const tool = entry as Record<string, unknown>;
      rejectUnknownKeys(tool, ['name', 'description'], entryField);
      if (typeof tool.name !== 'string' || !KEY_PATTERN.test(tool.name)) {
        fail('DESCRIPTOR_INVALID_TOOLS', `'name' must match ${KEY_PATTERN}`, `${entryField}.name`);
      }
      if (tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > DESCRIPTOR_MAX_HELP_LENGTH)) {
        fail('DESCRIPTOR_INVALID_TOOLS', `'description' must be a string of at most ${DESCRIPTOR_MAX_HELP_LENGTH} characters`, `${entryField}.description`);
      }
      const name = tool.name as string;
      if (seenTools.has(name)) {
        fail('DESCRIPTOR_DUPLICATE_KEY', `duplicate Tool name '${name}'`, `${entryField}.name`);
      }
      seenTools.add(name);
      return {
        name,
        ...(tool.description !== undefined ? { description: tool.description as string } : {}),
      };
    });
  }

  if (obj.discovery !== undefined) {
    if (!isPlainObject(obj.discovery)) {
      fail('DESCRIPTOR_INVALID_DISCOVERY', "'discovery' must be an object {optionsEndpoint}", 'descriptor.discovery');
    }
    const discovery = obj.discovery as Record<string, unknown>;
    rejectUnknownKeys(discovery, ['optionsEndpoint'], 'descriptor.discovery');
    descriptor.discovery = {
      optionsEndpoint: validateHttpUrl(discovery.optionsEndpoint, 'descriptor.discovery.optionsEndpoint'),
    };
  }

  if (obj.knowledgeSource !== undefined) {
    // §4.3. A malformed block is a REFUSED descriptor, not a silently
    // ignored one, on the telemetry-block precedent above: a source that
    // believes it declared two compartments and did not would have every
    // result dropped at §7.2's equality check with no readable cause.
    if (!isPlainObject(obj.knowledgeSource)) {
      fail('DESCRIPTOR_INVALID_KNOWLEDGE_SOURCE', "'knowledgeSource' must be an object {classes, compartments}", 'descriptor.knowledgeSource');
    }
    const block = obj.knowledgeSource as Record<string, unknown>;
    rejectUnknownKeys(block, ['classes', 'compartments'], 'descriptor.knowledgeSource');

    if (!Array.isArray(block.classes) || block.classes.length < 1 || block.classes.length > DESCRIPTOR_MAX_KNOWLEDGE_CLASSES) {
      fail(
        'DESCRIPTOR_INVALID_KNOWLEDGE_SOURCE',
        `'classes' must be an array of 1..${DESCRIPTOR_MAX_KNOWLEDGE_CLASSES} declared content classes`,
        'descriptor.knowledgeSource.classes',
      );
    }
    const seenClasses = new Set<string>();
    const classes = (block.classes as unknown[]).map((entry, i) => {
      const entryField = `descriptor.knowledgeSource.classes[${i}]`;
      if (!isPlainObject(entry)) {
        fail('DESCRIPTOR_INVALID_KNOWLEDGE_SOURCE', 'each declared class must be an object {key, label?, content}', entryField);
      }
      const raw = entry as Record<string, unknown>;
      rejectUnknownKeys(raw, ['key', 'label', 'content'], entryField);
      if (typeof raw.key !== 'string' || !KEY_PATTERN.test(raw.key)) {
        fail('DESCRIPTOR_INVALID_KNOWLEDGE_SOURCE', `'key' must match ${KEY_PATTERN}`, `${entryField}.key`);
      }
      if (raw.label !== undefined && (typeof raw.label !== 'string' || raw.label.length > DESCRIPTOR_MAX_LABEL_LENGTH)) {
        fail('DESCRIPTOR_INVALID_KNOWLEDGE_SOURCE', `'label' must be a string of at most ${DESCRIPTOR_MAX_LABEL_LENGTH} characters`, `${entryField}.label`);
      }
      if (!(KNOWLEDGE_CONTENT_KINDS as readonly string[]).includes(raw.content as string)) {
        fail('DESCRIPTOR_INVALID_KNOWLEDGE_SOURCE', `'content' must be one of: ${KNOWLEDGE_CONTENT_KINDS.join(', ')}`, `${entryField}.content`);
      }
      const key = raw.key as string;
      if (seenClasses.has(key)) {
        fail('DESCRIPTOR_DUPLICATE_KEY', `duplicate class key '${key}'`, `${entryField}.key`);
      }
      seenClasses.add(key);
      return {
        key,
        ...(raw.label !== undefined ? { label: raw.label as string } : {}),
        content: raw.content as KnowledgeContentKind,
      };
    });

    // REQUIRED NON-EMPTY (sol R1-3) — see DescriptorKnowledgeSource.
    if (!Array.isArray(block.compartments) || block.compartments.length < 1 || block.compartments.length > DESCRIPTOR_MAX_KNOWLEDGE_COMPARTMENTS) {
      fail(
        'DESCRIPTOR_INVALID_KNOWLEDGE_SOURCE',
        `'compartments' must be a NON-EMPTY array of 1..${DESCRIPTOR_MAX_KNOWLEDGE_COMPARTMENTS} declared compartment names — a uniform corpus declares one canonical compartment`,
        'descriptor.knowledgeSource.compartments',
      );
    }
    const seenCompartments = new Set<string>();
    const compartments = (block.compartments as unknown[]).map((entry, i) => {
      const entryField = `descriptor.knowledgeSource.compartments[${i}]`;
      if (typeof entry !== 'string' || !KEY_PATTERN.test(entry)) {
        fail('DESCRIPTOR_INVALID_KNOWLEDGE_SOURCE', `each compartment must match ${KEY_PATTERN}`, entryField);
      }
      const compartment = entry as string;
      if (seenCompartments.has(compartment)) {
        fail('DESCRIPTOR_DUPLICATE_KEY', `duplicate compartment '${compartment}'`, entryField);
      }
      seenCompartments.add(compartment);
      return compartment;
    });

    descriptor.knowledgeSource = { classes, compartments };
  }

  if (obj.health !== undefined) {
    if (!isPlainObject(obj.health)) {
      fail('DESCRIPTOR_INVALID_HEALTH', "'health' must be an object {endpoint}", 'descriptor.health');
    }
    const health = obj.health as Record<string, unknown>;
    rejectUnknownKeys(health, ['endpoint'], 'descriptor.health');
    descriptor.health = {
      endpoint: validateHttpUrl(health.endpoint, 'descriptor.health.endpoint'),
    };
  }

  return descriptor;
}
