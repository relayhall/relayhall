import { DiscordThreadService } from '../services/DiscordThreadService';
import type { DiscordNotificationTransport } from '../services/discord';

const mockGetTask = jest.fn();
const mockUpdateTask = jest.fn();

jest.mock('../services/TaskManagerDB', () => ({
  taskManagerDB: {
    getTask: (...args: unknown[]) => mockGetTask(...args),
    updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  },
}));

describe('DiscordThreadService transport integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetTask.mockReset();
    mockUpdateTask.mockReset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('creates threads through the selected transport and persists the thread id', async () => {
    mockGetTask.mockResolvedValue({ id: 'task-1', title: 'Transport task' });
    mockUpdateTask.mockResolvedValue({});
    const transport = fakeTransport({
      createThread: jest.fn(async () => ({ threadId: 'thread-1', threadUrl: 'https://discord.com/channels/guild/thread-1' })),
    });
    const service = new DiscordThreadService({
      transport,
      config: serviceConfig(),
    });

    const threadId = await service.createThreadForTask('task-1', 'Transport task', 'hermes:session-1');

    expect(threadId).toBe('thread-1');
    expect(transport.createThread).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadName: '🤖 Task: Transport task',
      initialMessage: expect.stringContaining('Task Started'),
    });
    expect(mockUpdateTask).toHaveBeenCalledWith('task-1', { discordThreadId: 'thread-1' });
    service.stopTracking('task-1');
  });

});

function fakeTransport(overrides: Partial<DiscordNotificationTransport> = {}): DiscordNotificationTransport {
  return {
    name: 'relayhall-bot',
    createThread: jest.fn(async () => ({ threadId: 'thread-1' })),
    sendThreadMessage: jest.fn(async () => ({ messageId: 'msg-1' })),
    readThreadMessages: jest.fn(async () => ({ messages: [] })),
    archiveThread: jest.fn(async () => undefined),
    ...overrides,
  } as DiscordNotificationTransport;
}

function serviceConfig() {
  return {
    taskThreadChannelId: 'channel-1',
    pollIntervalMs: 15000,
    streamBatchMs: 7000,
    maxMessageLen: 1900,
    archiveOnComplete: true,
    lockOnComplete: false,
  };
}
