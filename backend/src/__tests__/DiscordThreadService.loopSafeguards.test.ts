import { DiscordThreadService } from '../services/DiscordThreadService';

// P1.3: the agent:stream mirroring safeguards left with the gateway
// connector (the board no longer observes agent output). What remains
// loop-relevant is the outbound dedup window on thread posts.
describe('DiscordThreadService loop safeguards', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('suppresses identical outbound thread posts after a successful send', async () => {
    const service = new DiscordThreadService();
    const sendThreadMessage = jest.fn(async () => ({ messageId: 'msg-1' }));
    (service as any).transport = { sendThreadMessage };

    await (service as any).sendToThread('thread-1', 'duplicate check');
    await (service as any).sendToThread('thread-1', 'duplicate check');

    expect(sendThreadMessage).toHaveBeenCalledTimes(1);
    expect(sendThreadMessage).toHaveBeenCalledWith({
      threadId: 'thread-1',
      message: 'duplicate check',
    });
  });

  it('allows retrying the same outbound text after a failed send', async () => {
    const service = new DiscordThreadService();
    let fail = true;
    const sendThreadMessage = jest.fn(async (_input: { threadId: string; message: string }) => {
      if (fail) throw new Error('temporary send failure');
      return { messageId: 'msg-1' };
    });
    (service as any).transport = { sendThreadMessage };

    await (service as any).sendToThread('thread-1', 'retry me');

    fail = false;
    await (service as any).sendToThread('thread-1', 'retry me');

    expect(sendThreadMessage).toHaveBeenCalledTimes(2);
    expect(sendThreadMessage.mock.calls[1][0]).toEqual({
      threadId: 'thread-1',
      message: 'retry me',
    });
  });
});
