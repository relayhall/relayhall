/**
 * TaskDetector - Phase 4 Step 3
 * 
 * Parses transcript messages and extracts structured WorkEvents.
 * Detects: tool calls, file writes, git commits, errors, completions.
 * 
 * Used by WorkMonitor to understand what's happening in a session.
 */

export interface WorkEvent {
  type: 'tool-call' | 'file-write' | 'file-read' | 'git-commit' | 'git-push' |
        'exec-command' | 'web-fetch' | 'browser-action' | 'message-send' |
        'error' | 'task-mention' | 'build' | 'deploy' | 'test';
  /** Human-readable description */
  description: string;
  /** Extra details (file paths, command output, etc.) */
  details?: string[];
  /** Tool name if applicable */
  tool?: string;
  /** Timestamp from transcript */
  timestamp?: string;
  /** Confidence score 0-1 */
  confidence: number;
}

interface TranscriptMessage {
  type: string;
  message: {
    role: string;
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      id?: string;
      input?: any;
      [key: string]: any;
    }>;
    [key: string]: any;
  };
  timestamp: string;
}

export class TaskDetector {

  /**
   * Extract work events from a transcript message
   */
  detectEvents(msg: TranscriptMessage): WorkEvent[] {
    const events: WorkEvent[] = [];

    if (!msg.message?.content || !Array.isArray(msg.message.content)) {
      return events;
    }

    const role = msg.message.role;

    if (role === 'assistant') {
      // Look for tool calls
      for (const block of msg.message.content) {
        if (block.type === 'toolCall' || block.type === 'tool_use') {
          const toolEvents = this.detectToolCall(block, msg.timestamp);
          events.push(...toolEvents);
        }
      }
    }

    if (role === 'toolResult' || role === 'tool') {
      // Look for tool results — errors, outputs
      for (const block of msg.message.content) {
        const resultEvents = this.detectToolResult(block, msg.timestamp);
        events.push(...resultEvents);
      }
    }

    return events;
  }

  /**
   * Detect events from a tool call block
   */
  private detectToolCall(block: any, timestamp: string): WorkEvent[] {
    const events: WorkEvent[] = [];
    const toolName = block.name || '';
    const input = block.input || {};

    switch (toolName) {
      case 'Write':
      case 'write': {
        const filePath = input.path || input.file_path || '';
        events.push({
          type: 'file-write',
          description: `Writing file: ${this.shortenPath(filePath)}`,
          details: [filePath],
          tool: toolName,
          timestamp,
          confidence: 0.9,
        });

        // Detect specific file types
        if (filePath.endsWith('.tsx') || filePath.endsWith('.ts')) {
          events.push({
            type: 'build',
            description: `Creating TypeScript component: ${path.basename(filePath)}`,
            details: [filePath],
            tool: toolName,
            timestamp,
            confidence: 0.7,
          });
        }
        if (filePath.endsWith('.css')) {
          events.push({
            type: 'build',
            description: `Creating stylesheet: ${path.basename(filePath)}`,
            details: [filePath],
            tool: toolName,
            timestamp,
            confidence: 0.7,
          });
        }
        break;
      }

      case 'Edit':
      case 'edit': {
        const filePath = input.path || input.file_path || '';
        events.push({
          type: 'file-write',
          description: `Editing file: ${this.shortenPath(filePath)}`,
          details: [filePath],
          tool: toolName,
          timestamp,
          confidence: 0.9,
        });
        break;
      }

      case 'Read':
      case 'read': {
        const filePath = input.path || input.file_path || '';
        events.push({
          type: 'file-read',
          description: `Reading file: ${this.shortenPath(filePath)}`,
          details: [filePath],
          tool: toolName,
          timestamp,
          confidence: 0.6,
        });
        break;
      }

      case 'exec': {
        const command = input.command || '';
        const execEvents = this.detectExecCommand(command, timestamp);
        events.push(...execEvents);
        break;
      }

      case 'web_fetch': {
        const url = input.url || '';
        events.push({
          type: 'web-fetch',
          description: `Fetching: ${url}`,
          details: [url],
          tool: toolName,
          timestamp,
          confidence: 0.7,
        });
        break;
      }

      case 'browser': {
        const action = input.action || '';
        events.push({
          type: 'browser-action',
          description: `Browser: ${action}`,
          details: [action, input.targetUrl || ''].filter(Boolean),
          tool: toolName,
          timestamp,
          confidence: 0.7,
        });
        break;
      }

      case 'message': {
        events.push({
          type: 'message-send',
          description: `Sending message`,
          tool: toolName,
          timestamp,
          confidence: 0.5,
        });
        break;
      }

      default: {
        // Generic tool call
        events.push({
          type: 'tool-call',
          description: `Tool: ${toolName}`,
          tool: toolName,
          timestamp,
          confidence: 0.5,
        });
      }
    }

    return events;
  }

  /**
   * Detect events from exec commands
   */
  private detectExecCommand(command: string, timestamp: string): WorkEvent[] {
    const events: WorkEvent[] = [];
    const cmd = command.toLowerCase();

    // Git operations
    if (cmd.includes('git commit')) {
      const msgMatch = command.match(/-m\s+["'](.+?)["']/);
      events.push({
        type: 'git-commit',
        description: `Git commit: ${msgMatch ? msgMatch[1] : 'unknown'}`,
        details: [command],
        tool: 'exec',
        timestamp,
        confidence: 0.95,
      });
    }

    if (cmd.includes('git push')) {
      events.push({
        type: 'git-push',
        description: `Git push`,
        details: [command],
        tool: 'exec',
        timestamp,
        confidence: 0.95,
      });
    }

    // Docker / deploy operations
    if (cmd.includes('docker compose') || cmd.includes('docker-compose')) {
      if (cmd.includes('up') || cmd.includes('build')) {
        events.push({
          type: 'deploy',
          description: `Docker build/deploy`,
          details: [command],
          tool: 'exec',
          timestamp,
          confidence: 0.85,
        });
      }
    }

    // npm / build operations
    if (cmd.includes('npm run build') || cmd.includes('npm install') || cmd.includes('npx')) {
      events.push({
        type: 'build',
        description: `NPM: ${command.substring(0, 60)}`,
        details: [command],
        tool: 'exec',
        timestamp,
        confidence: 0.8,
      });
    }

    // Test operations
    if (cmd.includes('npm test') || cmd.includes('jest') || cmd.includes('vitest')) {
      events.push({
        type: 'test',
        description: `Running tests`,
        details: [command],
        tool: 'exec',
        timestamp,
        confidence: 0.9,
      });
    }

    // Generic exec if nothing specific matched
    if (events.length === 0) {
      events.push({
        type: 'exec-command',
        description: `Running: ${command.substring(0, 80)}`,
        details: [command],
        tool: 'exec',
        timestamp,
        confidence: 0.5,
      });
    }

    return events;
  }

  /**
   * Detect events from tool results (mainly errors)
   */
  private detectToolResult(block: any, timestamp: string): WorkEvent[] {
    const events: WorkEvent[] = [];
    const text = (block.text || block.content || '').toString();

    // Detect errors
    if (this.isErrorOutput(text)) {
      events.push({
        type: 'error',
        description: this.extractErrorSummary(text),
        details: [text.substring(0, 500)],
        timestamp,
        confidence: 0.8,
      });
    }

    return events;
  }

  /**
   * Check if output looks like an error
   */
  private isErrorOutput(text: string): boolean {
    const errorPatterns = [
      /error:/i,
      /Error:/,
      /FATAL/i,
      /failed/i,
      /exit code: [1-9]/i,
      /Cannot find module/i,
      /SyntaxError/i,
      /TypeError/i,
      /ReferenceError/i,
      /ENOENT/i,
      /EACCES/i,
      /ECONNREFUSED/i,
      /Build failed/i,
      /Compilation failed/i,
    ];

    return errorPatterns.some(p => p.test(text));
  }

  /**
   * Extract a short error summary from output
   */
  private extractErrorSummary(text: string): string {
    // Try to find a specific error line
    const lines = text.split('\n');
    for (const line of lines) {
      if (/error:|Error:|FATAL|failed|Cannot find/i.test(line)) {
        return line.trim().substring(0, 120);
      }
    }
    return text.substring(0, 120);
  }

  /**
   * Shorten a file path for display
   */
  private shortenPath(filePath: string): string {
    // Remove common prefixes
    return filePath
      .replace(/^\/home\/[^/]+\//, '~/')
      .replace(/^projects\/relayhall\//, 'relayhall/');
  }
}

// Need path for basename
import path from 'path';
