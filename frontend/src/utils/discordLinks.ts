/**
 * Discord thread link building (frontend mirror of backend/src/utils/discordLinks.ts).
 *
 * Prefer the backend-provided URL when present; otherwise build a guild-scoped
 * URL locally. `@me` only resolves for true DMs, so it requires the explicit
 * VITE_DISCORD_THREAD_URL_CONTEXT=dm opt-in. See docs/discord-thread-links.md.
 */

const DEFAULT_DISCORD_GUILD_ID = '';

const env = (import.meta as { env?: Record<string, string | undefined> }).env || {};
const GUILD_ID = env.VITE_DISCORD_GUILD_ID || DEFAULT_DISCORD_GUILD_ID;
const DM_CONTEXT = (env.VITE_DISCORD_THREAD_URL_CONTEXT || '').trim().toLowerCase() === 'dm';

export function buildDiscordThreadUrl(
  threadId?: string | null,
  preBuiltUrl?: string | null,
): string | null {
  if (preBuiltUrl) return preBuiltUrl;
  if (!threadId) return null;
  return DM_CONTEXT
    ? `https://discord.com/channels/@me/${threadId}`
    : `https://discord.com/channels/${GUILD_ID}/${threadId}`;
}
