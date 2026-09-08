/**
 * Representative fake-connector descriptors (RH-P2.1 subtask 4). These are
 * the contract's worked examples, shared by the validator and registry
 * suites: a Claude-Code-shaped connector (models + effort), an n8n-shaped
 * connector (workflow enum with per-workflow parameters), a Semaphore-shaped
 * connector (templates + parameters incl. a secretReference), and a
 * LiteLLM-gateway-shaped plain service.
 */

export const CLAUDE_CODE_DESCRIPTOR = {
  options: [
    {
      key: 'model',
      label: 'Model',
      type: 'enum',
      required: true,
      default: 'claude-fable-5',
      values: [
        { value: 'claude-fable-5', label: 'Fable 5' },
        { value: 'claude-opus-5', label: 'Opus 5' },
      ],
    },
    {
      key: 'effort',
      label: 'Reasoning effort',
      type: 'enum',
      default: 'medium',
      values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
    },
  ],
};

export const N8N_DESCRIPTOR = {
  options: [
    {
      key: 'workflow',
      label: 'Workflow',
      type: 'enum',
      required: true,
      values: [{ value: 'deploy-site' }, { value: 'digest-reports' }],
      parameters: [
        { key: 'targetHost', type: 'string', required: true, help: 'Host the workflow acts on' },
        { key: 'dryRun', type: 'boolean', default: false },
      ],
    },
  ],
  discovery: { optionsEndpoint: 'https://n8n.example.test/api/relayhall/options' },
  health: { endpoint: 'https://n8n.example.test/healthz' },
};

export const SEMAPHORE_DESCRIPTOR = {
  options: [
    {
      key: 'template',
      label: 'Ansible template',
      type: 'enum',
      required: true,
      values: [{ value: 'patch-fleet' }, { value: 'provision-vm' }],
      parameters: [
        { key: 'inventoryLimit', type: 'string' },
        // R5: a NAME the connector resolves on its own side, never a secret value.
        { key: 'deployKey', type: 'secretReference', allowedReferences: ['semaphore-deploy-key'] },
      ],
    },
  ],
};

export const LITELLM_DESCRIPTOR = {
  options: [
    {
      key: 'model',
      type: 'enum',
      values: [{ value: 'relayhall:fast' }, { value: 'relayhall:deep' }],
    },
  ],
  tools: [{ name: 'chat-completion', description: 'One callable completion operation' }],
};
