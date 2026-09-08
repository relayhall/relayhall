// onboardingPack.ts — one-time onboarding packs (RH-P3.AZ-S5, card
// bb4a5f79; AUTHZ design 4d961e37 §7.4, AZ-13, sol m11; strategy §2.10).
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
import type { Request } from 'express';
import type { ProfileRule } from '../services/AccessProfileService';

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
