/**
 * Discord thread link derivation — single source of truth (backend).
 *
 * Guild threads live at https://discord.com/channels/<guildId>/<threadId>.
 * The `@me` form only resolves for true DM channels, so it is emitted only when
 * DISCORD_THREAD_URL_CONTEXT=dm is set explicitly. See docs/discord-thread-links.md.
 */

/** Default guild id — set DISCORD_GUILD_ID (or leave empty for @me DM-style links). */
export const DEFAULT_DISCORD_GUILD_ID = '';

export function getDiscordGuildId(): string | null {
  const context = (process.env.DISCORD_THREAD_URL_CONTEXT || '').trim().toLowerCase();
  if (context === 'dm') return null;
  return process.env.DISCORD_GUILD_ID || DEFAULT_DISCORD_GUILD_ID;
}

export function buildDiscordThreadUrl(threadId: string | null | undefined): string | null {
  if (!threadId) return null;
  const guildId = getDiscordGuildId();
  return guildId
    ? `https://discord.com/channels/${guildId}/${threadId}`
    : `https://discord.com/channels/@me/${threadId}`;
}

/**
 * OpenClaw Discord session keys embed the thread id:
 *   agent:main:discord:channel:<threadId>
 *   agent:main:discord:thread:<parentChannelId>:<threadId>
 * (DM keys — discord:dm:<id> — are deliberately not matched: they are not guild threads.)
 */
export function extractDiscordThreadIdFromSessionKey(
  sessionKey: string | null | undefined,
): string | null {
  if (!sessionKey) return null;
  const match = sessionKey.match(/discord:(?:channel|thread:\d{15,21}):(\d{15,21})(?:$|:)/);
  return match ? match[1] : null;
}

/**
 * Resolve a task's thread id: persisted column first, then thread ids embedded
 * in session keys (spawn/bind races can leave discord_thread_id unpersisted).
 */
export function resolveTaskDiscordThreadId(refs: {
  discordThreadId?: string | null;
  acpSessionKey?: string | null;
  activeAgentSessionKey?: string | null;
  completedBySessionKey?: string | null;
}): string | null {
  return (
    refs.discordThreadId
    || extractDiscordThreadIdFromSessionKey(refs.acpSessionKey)
    || extractDiscordThreadIdFromSessionKey(refs.activeAgentSessionKey)
    || extractDiscordThreadIdFromSessionKey(refs.completedBySessionKey)
    || null
  );
}
