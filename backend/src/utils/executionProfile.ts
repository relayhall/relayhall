/**
 * Connector-first execution-profile validation (RH-P2.2, task a44b9b06;
 * vocabulary D-15, strategy §2.1, RH-DESIGN.5 R5, design report 2e51b732).
 *
 * An execution profile names a Connector and carries ONLY options that
 * Connector declared in its pinned capability-descriptor version:
 *
 *   { serviceId, descriptorVersion, options: {key: scalar},
 *     parameters?: {optionKey: {paramKey: scalar}} }
 *
 * The board validates choices against the pinned version and never
 * interprets the values (§2.1). Retired pins fail closed (R5): validation
 * refuses a retired descriptor version by name, and re-pinning forces full
 * re-validation because validation always runs against the requested pin.
 *
 * LEGACY blobs (the retired mode/harness/accessProfile shape) are held,
 * reported and never dropped: isLegacyExecutionProfile() classifies stored
 * values so reads can surface them separately; nothing here rewrites them.
 */
import {
  serviceRegistry,
  ServiceRegistryError,
} from '../services/ServiceRegistry';
import {
  DescriptorOption,
  DescriptorParameter,
  ServiceDescriptor,
} from './serviceDescriptor';

export class ProfileValidationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ProfileValidationError';
  }
}

const err = (status: number, code: string, message: string, field?: string) =>
  new ProfileValidationError(status, code, message, field);

export interface ConnectorExecutionProfile {
  serviceId: string;
  descriptorVersion: number;
  options: Record<string, string | number | boolean>;
  parameters?: Record<string, Record<string, string | number | boolean>>;
}

/** The retired legacy shape — recognized so stored bytes surface honestly. */
export function isLegacyExecutionProfile(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.serviceId === 'string') return false;
  return ['mode', 'harness', 'accessProfile', 'requiredCapabilities', 'allowOverrideAtSpawn']
    .some((key) => key in obj);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

function validateScalarAgainst(
  declared: DescriptorParameter,
  value: unknown,
  field: string,
): string | number | boolean {
  const t = declared.type;
  const ok =
    (t === 'boolean' && typeof value === 'boolean') ||
    (t === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    ((t === 'string' || t === 'resourceSelector') && typeof value === 'string' && value.length <= 4096) ||
    (t === 'enum' && typeof value === 'string') ||
    (t === 'secretReference' && typeof value === 'string');
  if (!ok) {
    throw err(422, 'PROFILE_INVALID_VALUE', `'${declared.key}' must match its declared type '${t}'`, field);
  }
  if (t === 'enum' && !(declared.values ?? []).some((v) => v.value === value)) {
    throw err(
      422,
      'PROFILE_INVALID_VALUE',
      `'${declared.key}' must be one of the declared enum values: ${(declared.values ?? []).map((v) => v.value).join(', ')}`,
      field,
    );
  }
  if (t === 'secretReference' && !(declared.allowedReferences ?? []).includes(value as string)) {
    // R5: only connector-resolved reference NAMES are pinnable — never
    // free-form caller input, never secret bytes.
    throw err(
      422,
      'PROFILE_INVALID_SECRET_REFERENCE',
      `'${declared.key}' must be one of the connector's declared reference names`,
      field,
    );
  }
  return value as string | number | boolean;
}

function validateEntryMap(
  declaredList: DescriptorParameter[],
  raw: unknown,
  field: string,
  requiredCheck: boolean,
): Record<string, string | number | boolean> {
  if (!isPlainObject(raw)) {
    throw err(422, 'PROFILE_INVALID_VALUE', `${field} must be an object of key: value entries`, field);
  }
  const declaredByKey = new Map(declaredList.map((d) => [d.key, d]));
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    const declared = declaredByKey.get(key);
    if (!declared) {
      throw err(
        422,
        'PROFILE_UNDECLARED_KEY',
        `'${key}' is not declared by the pinned descriptor version — declared keys: ${[...declaredByKey.keys()].join(', ') || '(none)'}`,
        `${field}.${key}`,
      );
    }
    if (!isScalar(value)) {
      throw err(422, 'PROFILE_INVALID_VALUE', `'${key}' must be a scalar value`, `${field}.${key}`);
    }
    out[key] = validateScalarAgainst(declared, value, `${field}.${key}`);
  }
  if (requiredCheck) {
    for (const declared of declaredList) {
      if (declared.required && !(declared.key in out)) {
        throw err(
          422,
          'PROFILE_MISSING_REQUIRED',
          `required '${declared.key}' is missing`,
          `${field}.${declared.key}`,
        );
      }
    }
  }
  return out;
}

/**
 * Validate a caller-supplied connector profile against the registry.
 * Returns the normalized profile (descriptorVersion resolved to the pin).
 * Throws ProfileValidationError with the exact field named (E-11).
 */
export async function validateConnectorProfile(input: unknown): Promise<ConnectorExecutionProfile> {
  if (!isPlainObject(input)) {
    throw err(422, 'PROFILE_INVALID', 'executionProfile must be an object', 'executionProfile');
  }
  const obj = input as Record<string, unknown>;
  const allowed = ['serviceId', 'descriptorVersion', 'options', 'parameters'];
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw err(
        400,
        'UNKNOWN_FIELD',
        `Unknown executionProfile field '${key}' — accepted fields are: ${allowed.join(', ')} (the legacy mode/harness/accessProfile shape retired with vocabulary D-15)`,
        `executionProfile.${key}`,
      );
    }
  }
  if (typeof obj.serviceId !== 'string' || obj.serviceId.length === 0) {
    throw err(422, 'PROFILE_INVALID', 'executionProfile.serviceId must name a registered Service', 'executionProfile.serviceId');
  }

  let service;
  try {
    service = await serviceRegistry.getByIdOrSlug(obj.serviceId);
  } catch (e) {
    if (e instanceof ServiceRegistryError && e.status === 404) {
      throw err(422, 'PROFILE_SERVICE_NOT_FOUND', 'executionProfile.serviceId names no registered Service', 'executionProfile.serviceId');
    }
    throw e;
  }
  if (service.kind !== 'connector') {
    throw err(
      422,
      'PROFILE_SERVICE_NOT_CONNECTOR',
      `'${service.slug}' is a plain Service — an execution profile names a Connector (a kind of Service that pulls and executes work, D-5/D-15)`,
      'executionProfile.serviceId',
    );
  }
  if (service.status !== 'published') {
    throw err(
      422,
      'PROFILE_SERVICE_NOT_PUBLISHED',
      `'${service.slug}' is ${service.status} — only a published Connector can be targeted`,
      'executionProfile.serviceId',
    );
  }

  let version: number;
  if (obj.descriptorVersion === undefined) {
    if (service.currentDescriptorVersion === null) {
      throw err(422, 'PROFILE_NO_DESCRIPTOR', `'${service.slug}' has no capability descriptor yet`, 'executionProfile.serviceId');
    }
    version = service.currentDescriptorVersion;
  } else if (
    typeof obj.descriptorVersion !== 'number' ||
    !Number.isInteger(obj.descriptorVersion) ||
    obj.descriptorVersion < 1
  ) {
    throw err(422, 'PROFILE_INVALID', 'executionProfile.descriptorVersion must be a positive integer', 'executionProfile.descriptorVersion');
  } else {
    version = obj.descriptorVersion;
  }

  const descriptorVersion = await serviceRegistry.getDescriptorVersion(service.id, version);
  if (descriptorVersion.retiredAt !== null) {
    // R5: retired pins fail closed — by name, at validation time.
    throw err(
      409,
      'PROFILE_DESCRIPTOR_RETIRED',
      `descriptor version ${version} of '${service.slug}' is retired — pin a live version (retirement stops new consumers; existing pins keep resolving read-only)`,
      'executionProfile.descriptorVersion',
    );
  }
  return normalizeConnectorProfileOptions(obj, service.id, version, descriptorVersion.descriptor);
}

/** Pure option validation shared with a visibility-resolved Blueprint plan.
 * The caller owns Service liveness and immutable descriptor pin validation.
 * This preserves the ordinary writer's required/default semantics. */
export function normalizeConnectorProfileOptions(
  obj: { options?: unknown; parameters?: unknown }, serviceId: string, version: number, descriptor: ServiceDescriptor,
): ConnectorExecutionProfile {
  const declaredOptions: DescriptorOption[] = descriptor.options ?? [];

  const options = validateEntryMap(
    declaredOptions,
    obj.options === undefined ? {} : obj.options,
    'executionProfile.options',
    true,
  );

  const profile: ConnectorExecutionProfile = {
    serviceId,
    descriptorVersion: version,
    options,
  };

  if (obj.parameters !== undefined) {
    if (!isPlainObject(obj.parameters)) {
      throw err(422, 'PROFILE_INVALID_VALUE', 'executionProfile.parameters must be an object keyed by option key', 'executionProfile.parameters');
    }
    const parameters: Record<string, Record<string, string | number | boolean>> = {};
    for (const [optionKey, paramMap] of Object.entries(obj.parameters)) {
      const declared = declaredOptions.find((o) => o.key === optionKey);
      if (!declared) {
        throw err(422, 'PROFILE_UNDECLARED_KEY', `parameters are keyed by declared option keys; '${optionKey}' is not declared`, `executionProfile.parameters.${optionKey}`);
      }
      if (!declared.parameters || declared.parameters.length === 0) {
        throw err(422, 'PROFILE_UNDECLARED_KEY', `option '${optionKey}' declares no parameters`, `executionProfile.parameters.${optionKey}`);
      }
      if (!(optionKey in options)) {
        throw err(422, 'PROFILE_INVALID_VALUE', `parameters for '${optionKey}' require the option itself to be set`, `executionProfile.parameters.${optionKey}`);
      }
      parameters[optionKey] = validateEntryMap(
        declared.parameters,
        paramMap,
        `executionProfile.parameters.${optionKey}`,
        true,
      );
    }
    if (Object.keys(parameters).length > 0) profile.parameters = parameters;
  }

  // Options that carry required parameters must have them supplied even when
  // the caller sent no parameters object at all.
  for (const declared of declaredOptions) {
    if (declared.key in options && declared.parameters?.some((p) => p.required)) {
      const supplied = profile.parameters?.[declared.key] ?? {};
      for (const param of declared.parameters) {
        if (param.required && !(param.key in supplied)) {
          throw err(
            422,
            'PROFILE_MISSING_REQUIRED',
            `option '${declared.key}' requires parameter '${param.key}'`,
            `executionProfile.parameters.${declared.key}.${param.key}`,
          );
        }
      }
    }
  }

  return profile;
}
