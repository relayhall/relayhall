export interface DiscordMessageAuthor {
  id: string;
  bot?: boolean;
  username?: string;
}

export interface DiscordMessage {
  id: string;
  content: string;
  author?: DiscordMessageAuthor;
  authorId?: string;
  timestamp?: string;
}

export interface CreateThreadResult {
  threadId: string;
  threadUrl?: string;
}

export interface DiscordNotificationTransport {
  readonly name: 'relayhall-bot' | 'disabled';
  createThread(input: { channelId: string; threadName: string; initialMessage?: string }): Promise<CreateThreadResult>;
  sendThreadMessage(input: { threadId: string; message: string }): Promise<{ messageId?: string }>;
  sendChannelMessage(input: { channelId: string; message: string }): Promise<{ messageId?: string }>;
  readThreadMessages(input: { threadId: string; limit: number; after?: string | null }): Promise<{ messages: DiscordMessage[] }>;
  archiveThread(input: { threadId: string; locked?: boolean }): Promise<void>;
}

export interface DiscordTransportConfig {
  transportName: 'relayhall-bot' | 'disabled';
  taskThreadChannelId: string;
  guildId: string | null;
  botTokenConfigured: boolean;
  pollIntervalMs: number;
  streamBatchMs: number;
  maxMessageLen: number;
  archiveOnComplete: boolean;
  lockOnComplete: boolean;
}

type FetchLike = typeof fetch;
type LoggerLike = Pick<typeof console, 'log' | 'warn' | 'error'>;

const DEFAULT_TASK_THREAD_CHANNEL_ID = '';
const DISCORD_API_BASE = 'https://discord.com/api/v10';

function envFirst(primary: string, legacy?: string, fallback = ''): string {
  return process.env[primary] || (legacy ? process.env[legacy] : undefined) || fallback;
}

function envNumber(primary: string, fallback: number): number {
  const value = process.env[primary];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBool(primary: string, fallback: boolean): boolean {
  const value = process.env[primary];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadDiscordTransportConfig(): DiscordTransportConfig {
  // P1.3: the 'openclaw-gateway' transport (Discord via the harness gateway's
  // /tools/invoke) was retired with the gateway connector; the direct
  // relayhall-bot transport is the only live implementation.
  const transportName = (process.env.RELAYHALL_DISCORD_TRANSPORT || 'disabled').trim() as DiscordTransportConfig['transportName'];
  return {
    transportName: transportName === 'relayhall-bot' ? 'relayhall-bot' : 'disabled',
    taskThreadChannelId: envFirst('RELAYHALL_DISCORD_TASK_THREAD_CHANNEL_ID', 'DISCORD_TASK_THREAD_CHANNEL_ID', DEFAULT_TASK_THREAD_CHANNEL_ID),
    guildId: envFirst('RELAYHALL_DISCORD_GUILD_ID', 'DISCORD_GUILD_ID', '') || null,
    botTokenConfigured: Boolean(process.env.RELAYHALL_DISCORD_BOT_TOKEN),
    pollIntervalMs: envNumber('RELAYHALL_DISCORD_POLL_INTERVAL_MS', 15000),
    streamBatchMs: envNumber('RELAYHALL_DISCORD_STREAM_BATCH_MS', 7000),
    maxMessageLen: envNumber('RELAYHALL_DISCORD_MAX_MESSAGE_LEN', 1900),
    archiveOnComplete: envBool('RELAYHALL_DISCORD_ARCHIVE_ON_COMPLETE', true),
    lockOnComplete: envBool('RELAYHALL_DISCORD_LOCK_ON_COMPLETE', false),
  };
}

export class DisabledDiscordTransport implements DiscordNotificationTransport {
  public readonly name = 'disabled' as const;
  constructor(private readonly reason = 'Discord task thread transport is disabled') {}
  async createThread(): Promise<CreateThreadResult> {
    throw new Error(this.reason);
  }
  async sendThreadMessage(): Promise<{ messageId?: string }> {
    return {};
  }
  async sendChannelMessage(): Promise<{ messageId?: string }> {
    return {};
  }
  async readThreadMessages(): Promise<{ messages: DiscordMessage[] }> {
    return { messages: [] };
  }
  async archiveThread(): Promise<void> {}
}

export class RelayHallBotDiscordTransport implements DiscordNotificationTransport {
  public readonly name = 'relayhall-bot' as const;
  private readonly token: string;
  private readonly guildId: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(options: { token: string; guildId?: string | null; fetchImpl?: FetchLike }) {
    this.token = options.token;
    this.guildId = options.guildId || null;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async createThread(input: { channelId: string; threadName: string; initialMessage?: string }): Promise<CreateThreadResult> {
    const created = await this.request<any>(`/channels/${encodeURIComponent(input.channelId)}/threads`, {
      method: 'POST',
      body: { name: input.threadName, type: 11, auto_archive_duration: 1440 },
      action: 'thread create',
    });
    const threadId = created?.id;
    if (!threadId) throw new Error('Discord API thread create failed: response did not include thread id');
    if (input.initialMessage?.trim()) {
      await this.sendThreadMessage({ threadId, message: input.initialMessage });
    }
    return {
      threadId,
      ...(this.guildId ? { threadUrl: `https://discord.com/channels/${this.guildId}/${threadId}` } : {}),
    };
  }

  async sendThreadMessage(input: { threadId: string; message: string }): Promise<{ messageId?: string }> {
    const sent = await this.request<any>(`/channels/${encodeURIComponent(input.threadId)}/messages`, {
      method: 'POST',
      body: { content: input.message },
      action: 'thread message',
    });
    return { messageId: sent?.id };
  }

  async sendChannelMessage(input: { channelId: string; message: string }): Promise<{ messageId?: string }> {
    return this.sendThreadMessage({ threadId: input.channelId, message: input.message });
  }

  async readThreadMessages(input: { threadId: string; limit: number; after?: string | null }): Promise<{ messages: DiscordMessage[] }> {
    const params = new URLSearchParams({ limit: String(input.limit) });
    if (input.after) params.set('after', input.after);
    const messages = await this.request<any[]>(`/channels/${encodeURIComponent(input.threadId)}/messages?${params.toString()}`, {
      method: 'GET',
      action: 'thread read',
    });
    return {
      messages: Array.isArray(messages) ? messages.map(m => ({
        id: String(m.id || ''),
        content: String(m.content || ''),
        author: m.author ? { id: String(m.author.id || ''), bot: Boolean(m.author.bot), username: m.author.username } : undefined,
        authorId: m.author_id || m.authorId,
        timestamp: m.timestamp,
      })) : [],
    };
  }

  async archiveThread(input: { threadId: string; locked?: boolean }): Promise<void> {
    await this.request<any>(`/channels/${encodeURIComponent(input.threadId)}`, {
      method: 'PATCH',
      body: { archived: true, locked: Boolean(input.locked) },
      action: 'thread archive',
    });
  }

  private async request<T>(path: string, options: { method: string; body?: Record<string, unknown>; action: string }): Promise<T> {
    const response = await this.fetchImpl(`${DISCORD_API_BASE}${path}`, {
      method: options.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${this.token}`,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    } as RequestInit);

    if (!response.ok) {
      throw new Error(`Discord API ${options.action} failed: ${response.status} ${await this.sanitizedErrorText(response)}`.trim());
    }
    return await response.json() as T;
  }

  private async sanitizedErrorText(response: Response): Promise<string> {
    let parsed: any = null;
    try {
      parsed = await response.json();
    } catch {
      try { parsed = JSON.parse(await response.text()); } catch { parsed = null; }
    }
    const message = typeof parsed?.message === 'string' ? parsed.message.replaceAll(this.token, '[redacted]') : '';
    const code = parsed?.code !== undefined ? ` code=${parsed.code}` : '';
    return `${message}${code}`.trim();
  }
}

export function createDiscordNotificationTransport(options: { logger?: LoggerLike } = {}): {
  transport: DiscordNotificationTransport;
  config: DiscordTransportConfig;
  reason: string | null;
} {
  const config = loadDiscordTransportConfig();
  const logger = options.logger || console;

  if (config.transportName === 'disabled') {
    return { transport: new DisabledDiscordTransport('Discord task thread transport disabled by config'), config, reason: 'disabled by config' };
  }

  const token = process.env.RELAYHALL_DISCORD_BOT_TOKEN;
  if (!token) {
    const reason = 'Discord task thread disabled: missing RelayHall bot token';
    logger.warn(reason);
    return { transport: new DisabledDiscordTransport(reason), config, reason };
  }

  return {
    transport: new RelayHallBotDiscordTransport({ token, guildId: config.guildId }),
    config,
    reason: null,
  };
}
