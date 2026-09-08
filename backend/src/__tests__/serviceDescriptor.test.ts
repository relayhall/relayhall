/**
 * Capability-descriptor validation (RH-P2.1; §2.1 as amended by E-17, R5).
 *
 * The representative fake connectors double as the contract's worked
 * examples: a Claude-Code-shaped connector (models + effort), an n8n-shaped
 * connector (workflow enum with per-workflow parameters), a Semaphore-shaped
 * connector (templates + parameters incl. a secretReference), and a
 * LiteLLM-gateway-shaped plain service. The hostile suite pins the E-17
 * obligations: no credentials in parameters, one level deep, strict unknown
 * rejection, bounded sizes.
 */
import {
  validateDescriptor,
  DescriptorError,
  DESCRIPTOR_MAX_OPTIONS,
} from '../utils/serviceDescriptor';
import {
  CLAUDE_CODE_DESCRIPTOR,
  N8N_DESCRIPTOR,
  SEMAPHORE_DESCRIPTOR,
  LITELLM_DESCRIPTOR,
} from './fixtures/serviceDescriptors';

function expectRejection(input: unknown, code: string, fieldContains?: string): void {
  try {
    validateDescriptor(input);
    throw new Error('expected DescriptorError, got success');
  } catch (e) {
    expect(e).toBeInstanceOf(DescriptorError);
    const err = e as DescriptorError;
    expect(err.code).toBe(code);
    if (fieldContains) expect(err.field).toContain(fieldContains);
  }
}

describe('representative connector descriptors validate', () => {
  it.each([
    ['Claude Code shaped', CLAUDE_CODE_DESCRIPTOR],
    ['n8n shaped', N8N_DESCRIPTOR],
    ['Semaphore shaped', SEMAPHORE_DESCRIPTOR],
    ['LiteLLM gateway shaped', LITELLM_DESCRIPTOR],
  ])('%s', (_name, fixture) => {
    const descriptor = validateDescriptor(fixture);
    expect(descriptor.options.length).toBeGreaterThan(0);
  });

  it('an empty options array is legal — a service may declare no execution options', () => {
    expect(validateDescriptor({ options: [] }).options).toEqual([]);
  });
});

describe('hostile descriptors are rejected with the exact field named (E-11)', () => {
  it('an inline secret on a secretReference is refused — reference names only (R5)', () => {
    expectRejection(
      {
        options: [{
          key: 'template', type: 'enum', values: [{ value: 't1' }],
          parameters: [{
            key: 'deployKey', type: 'secretReference',
            allowedReferences: ['k1'],
            default: 'ssh-rsa AAAA-verbatim-secret-material',
          }],
        }],
      },
      'DESCRIPTOR_SECRET_VALUE',
      'parameters[0].default',
    );
  });

  it('a secretReference without allowedReferences is refused', () => {
    expectRejection(
      { options: [{ key: 'k', type: 'secretReference' }] },
      'DESCRIPTOR_MISSING_REFERENCES',
    );
  });

  it('a reference name that does not look like a name is refused', () => {
    expectRejection(
      { options: [{ key: 'k', type: 'secretReference', allowedReferences: ['has spaces so plausibly a secret'] }] },
      'DESCRIPTOR_INVALID_REFERENCE',
    );
  });

  it('nested parameter trees are refused — E-17 allows one level, never a tree', () => {
    expectRejection(
      {
        options: [{
          key: 'workflow', type: 'enum', values: [{ value: 'w' }],
          parameters: [{
            key: 'inner', type: 'string',
            parameters: [{ key: 'deeper', type: 'string' }],
          }],
        }],
      },
      'DESCRIPTOR_NESTED_PARAMETERS',
    );
  });

  it('unknown fields are refused wherever they appear', () => {
    expectRejection({ options: [], extra: true }, 'DESCRIPTOR_UNKNOWN_FIELD', 'extra');
    expectRejection(
      { options: [{ key: 'k', type: 'string', surprise: 1 }] },
      'DESCRIPTOR_UNKNOWN_FIELD',
      'surprise',
    );
  });

  it('duplicate option and parameter keys are refused', () => {
    expectRejection(
      { options: [{ key: 'model', type: 'string' }, { key: 'model', type: 'string' }] },
      'DESCRIPTOR_DUPLICATE_KEY',
    );
    expectRejection(
      {
        options: [{
          key: 'w', type: 'enum', values: [{ value: 'v' }],
          parameters: [{ key: 'p', type: 'string' }, { key: 'p', type: 'number' }],
        }],
      },
      'DESCRIPTOR_DUPLICATE_KEY',
    );
  });

  it('enum shape rules hold: values required on enum, refused elsewhere, default must be a member', () => {
    expectRejection({ options: [{ key: 'k', type: 'enum' }] }, 'DESCRIPTOR_INVALID_VALUES');
    expectRejection(
      { options: [{ key: 'k', type: 'string', values: [{ value: 'v' }] }] },
      'DESCRIPTOR_INVALID_VALUES',
    );
    expectRejection(
      { options: [{ key: 'k', type: 'enum', values: [{ value: 'a' }], default: 'zzz' }] },
      'DESCRIPTOR_INVALID_DEFAULT',
    );
  });

  it('defaults must match their declared type', () => {
    expectRejection(
      { options: [{ key: 'k', type: 'number', default: 'not-a-number' }] },
      'DESCRIPTOR_INVALID_DEFAULT',
    );
    expectRejection(
      { options: [{ key: 'k', type: 'number', default: Infinity }] },
      'DESCRIPTOR_INVALID_DEFAULT',
    );
  });

  it('discovery and health endpoints must be absolute http(s) URLs', () => {
    expectRejection(
      { options: [], discovery: { optionsEndpoint: 'ftp://example.test/x' } },
      'DESCRIPTOR_INVALID_URL',
    );
    expectRejection(
      { options: [], health: { endpoint: 'not a url' } },
      'DESCRIPTOR_INVALID_URL',
    );
  });

  it('size bounds hold: option count', () => {
    const options = Array.from({ length: DESCRIPTOR_MAX_OPTIONS + 1 }, (_, i) => ({
      key: `opt${i}`,
      type: 'string',
    }));
    expectRejection({ options }, 'DESCRIPTOR_TOO_LARGE', 'options');
  });

  it('a non-object descriptor is refused', () => {
    expectRejection([], 'DESCRIPTOR_INVALID');
    expectRejection('options', 'DESCRIPTOR_INVALID');
    expectRejection(null, 'DESCRIPTOR_INVALID');
  });
});
