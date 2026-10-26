// onboardingPack.ts — one-time onboarding packs (RH-P3.AZ-S5, card
// bb4a5f79; AUTHZ design 4d961e37 §7.4, AZ-13, review m11; strategy §2.10).
//
// A pack is RENDERED ONCE into the response that mints its credential and
// is NEVER stored server-side: board endpoint, the credential (secretOnce),
// per-harness MCP config snippets (Claude Code / Codex / generic JSON),
// the §2.10 bootstrap line, CLI env setup, a granted-authority summary and
// the self-preview link. AGENT packs additionally carry the COMPILED
// BRIEF for the bound task; CONNECTOR packs ride the credential-issuance /
// registration response (§7.4: "collect" is an Agent-flow term only).
//
// The board endpoint comes from RELAYHALL_PUBLIC_API_URL when the
// deployment declares one, else from the request's own origin — the pack
// must name the endpoint its credential actually authenticates against.
//
// Card 94e8bb0b items 1-3: the pack also carries ONE short bootstrap prompt
// and a few lines of secure configuration guidance. Both are composed from
// the MCP endpoint alone — the composer is never handed the credential — so
// no arm of this file can put a token into text a person pastes into a chat.
import type { Request } from 'express';
import type { ProfileRule } from '../services/AccessProfileService';

/**
 * The registry Skill a fresh session is sent to. Its reviewed source is
 * `skills/relayhall-connector-bootstrap/SKILL.md`; publication is the normal
 * Skill lifecycle (docs/connector-onboarding.md), never this file.
 */
export const CONNECTOR_BOOTSTRAP_SKILL = 'relayhall-connector-bootstrap';

/** The MCP server name every configuration block in the pack registers. */
export const MCP_SERVER_ALIAS = 'relayhall';

/** The environment variable the Codex block and the CLI lines name. */
export const TOKEN_ENV_VAR = 'RELAYHALL_TOKEN';

/**
 * What a new connector may read (owner ruling E475 (3)): the board, through
 * MCP, and the connector's own folders, nothing else. The sentence itself says
 * which folders those are, so a harness opened inside some other folder cannot
 * count that folder as its own before the Skill loads. One sentence, said in the
 * bootstrap prompt AND, verbatim, in the registry Skill's ground rules
 * (`skills/relayhall-connector-bootstrap/SKILL.md`), so the two cannot drift.
 */
export const CONNECTOR_READ_BOUNDARY = "Read only the board, through this MCP server, and this connector's own folders (its MCP entry, its local connection skill and its state folder); never the owner's private working set, other sessions' scratchpads or other hosts.";

/**
 * The copyable bootstrap prompt. It names the configured MCP origin, what the
 * session may read, and the steps, and nothing else: the signature takes no
 * credential, so the prompt is identical before and after a token is minted
 * and is safe to re-show. The read boundary comes second, before any step that
 * reads.
 */
export function composeBootstrapPrompt(mcpEndpoint: string): string {
  return [
    `Connect to the RelayHall MCP server "${MCP_SERVER_ALIAS}" at ${mcpEndpoint} with the credential from your secure store; never paste the credential into this chat.`,
    CONNECTOR_READ_BOUNDARY,
    'Call relayhall_brief_compile with {"session": true} to get your session brief.',
    `Find the published Skill ${CONNECTOR_BOOTSTRAP_SKILL} with relayhall_skill_list, load it with relayhall_skill_get (fullContent: true) and run the onboarding it describes, using only what this harness supports.`,
    'Finish with a readiness matrix: measured results with real ids, then the remaining gaps. Do not arm or claim unrelated work.',
  ].join('\n');
}

/** Secure configuration guidance shown beside the prompt; credential-free by the same construction. */
export function composeConfigurationGuidance(mcpEndpoint: string): string[] {
  return [
    `Register the MCP server as "${MCP_SERVER_ALIAS}" at ${mcpEndpoint} using the block for your client.`,
    `Keep the credential in your client's secret store or the ${TOKEN_ENV_VAR} environment variable. Never put it in a prompt, a Skill, a Report or a repository; Claude Code reads \${${TOKEN_ENV_VAR}} inside .mcp.json headers.`,
    'Then paste the bootstrap prompt into a fresh session. It carries no credential, so it is safe to keep and to re-run.',
    'For a local pointer to this connection, run relayhall connection-skill install --harness claude-code (or --harness codex). It records the origin, the Skill version and digest, and where the credential is kept, never the credential.',
  ];
}

export interface PackCredential {
  credentialId: string;
  keyId: string;
  /** The full token — shown exactly once, never stored server-side. */
  secretOnce: string;
  expiresAt: string | null;
  transport: string;
}

export interface OnboardingPack {
  boardEndpoint: string;
  /** Strategy §2.10: the only instruction a harness keeps locally. */
  bootstrapLine: string;
  /** Card 94e8bb0b: the one copyable prompt for a fresh session. Never carries a credential. */
  bootstrapPrompt: string;
  /** Card 94e8bb0b: secure configuration guidance, one sentence per line. */
  configurationGuidance: string[];
  credential: PackCredential;
  /** Per-harness MCP config for the board's own `/mcp` endpoint (§7.4). */
  mcpConfig: {
    claudeCode: Record<string, unknown>;
    codex: string;
    generic: Record<string, unknown>;
  };
  cliEnv: string[];
  authoritySummary: {
    scopes: string[];
    rules: ProfileRule[];
    boundTaskId?: string | null;
  };
  previewPath: string;
  /** Agent packs only: the compiled Brief for the bound task. */
  brief?: string;
  briefUnavailableReason?: string;
}

export function boardEndpointFor(req: Request): string {
  const declared = process.env.RELAYHALL_PUBLIC_API_URL;
  if (declared) return declared.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0] || req.get('host') || 'localhost';
  return `${proto}://${host}/api`;
}

export function composeOnboardingPack(input: {
  endpoint: string;
  credential: PackCredential;
  scopes: string[];
  rules: ProfileRule[];
  boundTaskId?: string | null;
  brief?: string | null;
  briefUnavailableReason?: string | null;
}): OnboardingPack {
  const { endpoint, credential } = input;
  // The CLI still uses RELAYHALL_API_URL/RELAYHALL_TOKEN (cliEnv below); the
  // MCP snippets carry the credential in the Authorization header instead,
  // because the surface is now the board's own HTTP endpoint.
  const mcpEndpoint = `${endpoint}/mcp`;
  return {
    boardEndpoint: endpoint,
    bootstrapLine: `You have a RelayHall board at ${endpoint}. Authenticate with your credential and fetch everything else from it.`,
    bootstrapPrompt: composeBootstrapPrompt(mcpEndpoint),
    configurationGuidance: composeConfigurationGuidance(mcpEndpoint),
    credential,
    // RH-P3.C4: the MCP surface is IN-PROCESS now (owner decision D1). The
    // packs name the board's own `/mcp` Streamable HTTP endpoint — no local
    // checkout, no second process, no Python — and the out-of-process adapter
    // they used to name is retired with this candidate.
    mcpConfig: {
      // Claude Code `.mcp.json` server entry (strategy §2.10 pack shape).
      claudeCode: {
        mcpServers: {
          relayhall: {
            type: 'http',
            url: mcpEndpoint,
            headers: { Authorization: `Bearer ${credential.secretOnce}` },
          },
        },
      },
      // Codex config.toml snippet.
      codex: [
        '[mcp_servers.relayhall]',
        `url = "${mcpEndpoint}"`,
        'bearer_token_env_var = "RELAYHALL_TOKEN"',
      ].join('\n'),
      generic: {
        transport: 'streamable-http',
        url: mcpEndpoint,
        headers: { Authorization: `Bearer ${credential.secretOnce}` },
      },
    },
    cliEnv: [
      `export RELAYHALL_API_URL=${endpoint}`,
      `export RELAYHALL_TOKEN=${credential.secretOnce}`,
    ],
    authoritySummary: {
      scopes: input.scopes,
      rules: input.rules,
      ...(input.boundTaskId !== undefined ? { boundTaskId: input.boundTaskId } : {}),
    },
    previewPath: '/principals/me/effective-access',
    ...(input.brief ? { brief: input.brief } : {}),
    ...(input.briefUnavailableReason ? { briefUnavailableReason: input.briefUnavailableReason } : {}),
  };
}
