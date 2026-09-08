import {
  RelayHallBotDiscordTransport,
  createDiscordNotificationTransport,
  DisabledDiscordTransport,
} from '../services/discord';

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    process.env = saved;
  }
}

describe('Discord notification transport selection', () => {
  it('selects RelayHall bot transport when configured with a token', () => {
    withEnv({
      RELAYHALL_DISCORD_TRANSPORT: 'relayhall-bot',
      RELAYHALL_DISCORD_BOT_TOKEN: 'super-secret-token',
      RELAYHALL_DISCORD_TASK_THREAD_CHANNEL_ID: 'chan-1',
    }, () => {
      const selected = createDiscordNotificationTransport({ logger: quietLogger() });
      expect(selected.transport).toBeInstanceOf(RelayHallBotDiscordTransport);
      expect(selected.transport.name).toBe('relayhall-bot');
      expect(selected.reason).toBeNull();
    });
  });

  it('fails closed when RelayHall bot token is missing and does not fall back implicitly', () => {
    withEnv({
      RELAYHALL_DISCORD_TRANSPORT: 'relayhall-bot',
      RELAYHALL_DISCORD_BOT_TOKEN: undefined,
      RELAYHALL_DISCORD_TASK_THREAD_CHANNEL_ID: 'chan-1',
      RELAYHALL_DISCORD_FALLBACK_TRANSPORT: undefined,
    }, () => {
      const selected = createDiscordNotificationTransport({ logger: quietLogger() });
      expect(selected.transport).toBeInstanceOf(DisabledDiscordTransport);
      expect(selected.transport.name).toBe('disabled');
      expect(selected.reason).toContain('missing RelayHall bot token');
    });
  });

  it('treats the retired openclaw-gateway transport name as disabled (P1.3: gateway transport removed)', () => {
    withEnv({ RELAYHALL_DISCORD_TRANSPORT: 'openclaw-gateway' }, () => {
      const selected = createDiscordNotificationTransport({ logger: quietLogger() });
      expect(selected.transport).toBeInstanceOf(DisabledDiscordTransport);
      expect(selected.transport.name).toBe('disabled');
    });
  });

  it('honors legacy Discord channel aliases during transition', () => {
    withEnv({
      RELAYHALL_DISCORD_TRANSPORT: 'relayhall-bot',
      RELAYHALL_DISCORD_BOT_TOKEN: 'super-secret-token',
      RELAYHALL_DISCORD_TASK_THREAD_CHANNEL_ID: undefined,
      DISCORD_TASK_THREAD_CHANNEL_ID: 'legacy-channel',
    }, () => {
      const selected = createDiscordNotificationTransport({ logger: quietLogger() });
      expect(selected.config.taskThreadChannelId).toBe('legacy-channel');
    });
  });
});

describe('RelayHallBotDiscordTransport REST behavior', () => {
  const token = 'do-not-leak-token';

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a thread, sends starter text, and returns a derived guild URL', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'thread-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'msg-1' }));
    const transport = new RelayHallBotDiscordTransport({ token, guildId: 'guild-1', fetchImpl: fetchMock as any });

    const result = await transport.createThread({ channelId: 'channel-1', threadName: 'Task thread', initialMessage: 'hello' });

    expect(result).toEqual({ threadId: 'thread-1', threadUrl: 'https://discord.com/channels/guild-1/thread-1' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://discord.com/api/v10/channels/channel-1/threads', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: `Bot ${token}` }),
      body: JSON.stringify({ name: 'Task thread', type: 11, auto_archive_duration: 1440 }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://discord.com/api/v10/channels/thread-1/messages', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ content: 'hello' }),
    }));
  });

  it('posts, reads with after, archives, and maps Discord messages', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'msg-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'm1', content: 'reply', author: { id: 'u1', bot: false, username: 'W' }, timestamp: 'now' }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'thread-1', thread_metadata: { archived: true } }));
    const transport = new RelayHallBotDiscordTransport({ token, fetchImpl: fetchMock as any });

    await expect(transport.sendThreadMessage({ threadId: 'thread-1', message: 'hi' })).resolves.toEqual({ messageId: 'msg-1' });
    await expect(transport.readThreadMessages({ threadId: 'thread-1', limit: 10, after: 'm0' })).resolves.toEqual({
      messages: [{ id: 'm1', content: 'reply', author: { id: 'u1', bot: false, username: 'W' }, timestamp: 'now' }],
    });
    await expect(transport.archiveThread({ threadId: 'thread-1', locked: false })).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[1][0]).toBe('https://discord.com/api/v10/channels/thread-1/messages?limit=10&after=m0');
    expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ archived: true, locked: false }),
    }));
  });

  it('sanitizes Discord API errors so bot tokens are never exposed', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ message: `bad auth ${token}`, code: 50001 }, 403));
    const transport = new RelayHallBotDiscordTransport({ token, fetchImpl: fetchMock as any });

    await expect(transport.sendThreadMessage({ threadId: 'thread-1', message: 'hi' })).rejects.toThrow(/Discord API thread message failed: 403/);
    await expect(transport.sendThreadMessage({ threadId: 'thread-1', message: 'hi' })).rejects.not.toThrow(token);
  });
});

function jsonResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function quietLogger() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}
