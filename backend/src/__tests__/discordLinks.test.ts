import {
  DEFAULT_DISCORD_GUILD_ID,
  buildDiscordThreadUrl,
  extractDiscordThreadIdFromSessionKey,
  getDiscordGuildId,
  resolveTaskDiscordThreadId,
} from '../utils/discordLinks';

describe('discordLinks', () => {
  const savedGuild = process.env.DISCORD_GUILD_ID;
  const savedContext = process.env.DISCORD_THREAD_URL_CONTEXT;

  afterEach(() => {
    if (savedGuild === undefined) delete process.env.DISCORD_GUILD_ID;
    else process.env.DISCORD_GUILD_ID = savedGuild;
    if (savedContext === undefined) delete process.env.DISCORD_THREAD_URL_CONTEXT;
    else process.env.DISCORD_THREAD_URL_CONTEXT = savedContext;
  });

  describe('buildDiscordThreadUrl', () => {
    it('falls back to @me when no guild is configured', () => {
      delete process.env.DISCORD_GUILD_ID;
      delete process.env.DISCORD_THREAD_URL_CONTEXT;
      expect(DEFAULT_DISCORD_GUILD_ID).toBe('');
      expect(buildDiscordThreadUrl('999999999999999991')).toBe(
        'https://discord.com/channels/@me/999999999999999991',
      );
    });

    it('honors DISCORD_GUILD_ID override', () => {
      process.env.DISCORD_GUILD_ID = '42';
      expect(buildDiscordThreadUrl('7')).toBe('https://discord.com/channels/42/7');
    });

    it('emits @me only for explicit DM context', () => {
      process.env.DISCORD_THREAD_URL_CONTEXT = 'dm';
      expect(buildDiscordThreadUrl('7')).toBe('https://discord.com/channels/@me/7');
      expect(getDiscordGuildId()).toBeNull();
    });

    it('returns null without a thread id', () => {
      expect(buildDiscordThreadUrl(null)).toBeNull();
      expect(buildDiscordThreadUrl(undefined)).toBeNull();
      expect(buildDiscordThreadUrl('')).toBeNull();
    });
  });

  describe('extractDiscordThreadIdFromSessionKey', () => {
    it('extracts from channel-style keys', () => {
      expect(
        extractDiscordThreadIdFromSessionKey('agent:main:discord:channel:999999999999999992'),
      ).toBe('999999999999999992');
    });

    it('extracts the thread id (not parent) from thread-style keys', () => {
      expect(
        extractDiscordThreadIdFromSessionKey(
          'agent:main:discord:thread:999999999999999993:999999999999999994',
        ),
      ).toBe('999999999999999994');
    });

    it('ignores DM keys and non-discord keys', () => {
      expect(extractDiscordThreadIdFromSessionKey('agent:main:discord:dm:999999999999999995')).toBeNull();
      expect(extractDiscordThreadIdFromSessionKey('agent:main:main')).toBeNull();
      expect(extractDiscordThreadIdFromSessionKey(null)).toBeNull();
    });
  });

  describe('resolveTaskDiscordThreadId', () => {
    it('prefers the persisted column', () => {
      expect(
        resolveTaskDiscordThreadId({
          discordThreadId: '111111111111111111',
          acpSessionKey: 'agent:main:discord:channel:222222222222222222',
        }),
      ).toBe('111111111111111111');
    });

    it('falls back through session keys in order', () => {
      expect(
        resolveTaskDiscordThreadId({
          acpSessionKey: 'agent:main:main',
          activeAgentSessionKey: 'agent:main:discord:channel:333333333333333333',
        }),
      ).toBe('333333333333333333');
      expect(
        resolveTaskDiscordThreadId({
          completedBySessionKey: 'agent:main:discord:thread:444444444444444444:555555555555555555',
        }),
      ).toBe('555555555555555555');
      expect(resolveTaskDiscordThreadId({})).toBeNull();
    });
  });
});
