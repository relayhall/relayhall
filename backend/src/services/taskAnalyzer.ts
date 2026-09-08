/**
 * TaskAnalyzer - Phase 4 Step 4
 * 
 * Breaks down tasks into subtasks using pattern-based analysis.
 * When a task moves to "in-progress" and has no subtasks, this service
 * auto-generates a breakdown based on the task title, description, and tags.
 * 
 * Uses keyword/pattern matching rather than external API calls to avoid
 * token cost and latency. Can be upgraded to use Claude API later.
 */

import { v4 as uuidv4 } from 'uuid';
import { taskManagerDB as taskManager, type Task, type Subtask } from './TaskManagerDB';
import { EventEmitter } from 'events';
import { logCaughtFailure } from '../utils/secretSafeLog';

export interface BreakdownResult {
  subtasks: Subtask[];
  confidence: number;
  method: 'pattern' | 'template' | 'generic';
}

// Common project task templates
const TASK_TEMPLATES: Record<string, string[]> = {
  'frontend-component': [
    'Create component file (.tsx)',
    'Add component styles (.css)',
    'Define TypeScript interfaces/props',
    'Implement component logic',
    'Add to parent page/layout',
    'Test in browser',
  ],
  'backend-service': [
    'Create service file (.ts)',
    'Define interfaces and types',
    'Implement core logic',
    'Add error handling',
    'Register in server.ts',
    'Test API endpoints',
  ],
  'api-endpoint': [
    'Create route file',
    'Define request/response types',
    'Implement handler logic',
    'Add validation',
    'Add error handling',
    'Test with curl/browser',
  ],
  'bug-fix': [
    'Reproduce the issue',
    'Identify root cause',
    'Implement fix',
    'Test fix works',
    'Check for regressions',
    'Commit and deploy',
  ],
  'docker-deploy': [
    'Update Docker configuration',
    'Build container',
    'Test locally',
    'Push to registry/deploy',
    'Verify deployment',
    'Update documentation',
  ],
  'database-migration': [
    'Design schema changes',
    'Write migration SQL',
    'Update TypeScript interfaces',
    'Run migration on dev',
    'Test data integrity',
    'Deploy to production',
  ],
  'documentation': [
    'Review current docs',
    'Identify gaps/outdated sections',
    'Write new content',
    'Add code examples',
    'Review and proofread',
    'Commit and publish',
  ],
  'design-system': [
    'Define CSS variables',
    'Create component styles',
    'Apply to existing components',
    'Test responsiveness',
    'Cross-browser check',
    'Document design tokens',
  ],
  'phase-implementation': [
    'Review design specification',
    'Set up project structure',
    'Implement backend services',
    'Implement frontend components',
    'Wire up API routes',
    'Integration testing',
    'Deploy to dev environment',
    'User testing and feedback',
    'Bug fixes and polish',
    'Deploy to production',
    'Update documentation',
  ],
};

// Keywords that map to templates
const TEMPLATE_KEYWORDS: Record<string, string[]> = {
  'frontend-component': ['component', 'widget', 'ui', 'page', 'modal', 'card', 'button'],
  'backend-service': ['service', 'monitor', 'watcher', 'manager', 'handler', 'engine'],
  'api-endpoint': ['api', 'endpoint', 'route', 'rest', 'crud'],
  'bug-fix': ['fix', 'bug', 'broken', 'issue', 'error', 'wrong', 'crash'],
  'docker-deploy': ['docker', 'deploy', 'container', 'compose', 'production'],
  'database-migration': ['database', 'migration', 'schema', 'sql', 'table', 'column'],
  'documentation': ['doc', 'documentation', 'readme', 'guide', 'wiki'],
  'design-system': ['css', 'style', 'design', 'theme', 'responsive', 'layout'],
  'phase-implementation': ['phase', 'implement', 'build', 'create system', 'orchestration'],
};

export class TaskAnalyzer extends EventEmitter {
  
  constructor() {
    super();
  }

  /**
   * Initialize — listen for task status changes
   */
  initialize(): void {
    // Listen for task updates to auto-generate subtasks
    taskManager.on('task.updated', (task: Task) => {
      if (task.status === 'in-progress' && (!task.subtasks || task.subtasks.length === 0)) {
        this.generateSubtasks(task).catch(err => {
          logCaughtFailure('[TaskAnalyzer] subtask generation failed', err);
        });
      }
    });

    console.log('[TaskAnalyzer] Initialized — listening for task status changes');
  }

  /**
   * Generate subtasks for a task
   */
  async generateSubtasks(task: Task): Promise<BreakdownResult> {
    console.log(`[TaskAnalyzer] Generating subtasks for: "${task.title}"`);

    const result = this.analyzeAndBreakdown(task);

    if (result.subtasks.length > 0) {
      // Save subtasks to the task
      await taskManager.updateTask(task.id, { subtasks: result.subtasks });
      console.log(`[TaskAnalyzer] Created ${result.subtasks.length} subtasks (${result.method}, confidence: ${result.confidence})`);

      this.emit('subtask.generated', {
        taskId: task.id,
        count: result.subtasks.length,
        method: result.method,
      });
    }

    return result;
  }

  /**
   * Analyze task and generate breakdown
   */
  private analyzeAndBreakdown(task: Task): BreakdownResult {
    const taskText = `${task.title} ${task.description} ${task.tags.join(' ')}`.toLowerCase();

    // 1. Try to match a template
    const template = this.matchTemplate(taskText);
    if (template) {
      return {
        subtasks: template.steps.map(text => this.createSubtask(text)),
        confidence: template.confidence,
        method: 'template',
      };
    }

    // 2. Try pattern-based extraction from description
    const patterns = this.extractFromDescription(task.description);
    if (patterns.length >= 3) {
      return {
        subtasks: patterns.map(text => this.createSubtask(text)),
        confidence: 0.6,
        method: 'pattern',
      };
    }

    // 3. Fall back to generic breakdown
    return {
      subtasks: this.genericBreakdown(task).map(text => this.createSubtask(text)),
      confidence: 0.3,
      method: 'generic',
    };
  }

  /**
   * Match task text to a template
   */
  private matchTemplate(taskText: string): { steps: string[]; confidence: number } | null {
    let bestTemplate: string | null = null;
    let bestScore = 0;

    for (const [templateKey, keywords] of Object.entries(TEMPLATE_KEYWORDS)) {
      let score = 0;
      for (const keyword of keywords) {
        if (taskText.includes(keyword)) {
          score++;
        }
      }
      // Normalize by keyword count
      const normalizedScore = score / keywords.length;
      if (normalizedScore > bestScore && score >= 2) {
        bestScore = normalizedScore;
        bestTemplate = templateKey;
      }
    }

    if (bestTemplate && TASK_TEMPLATES[bestTemplate]) {
      return {
        steps: TASK_TEMPLATES[bestTemplate],
        confidence: Math.min(0.9, 0.5 + bestScore),
      };
    }

    return null;
  }

  /**
   * Extract steps from markdown description (looks for lists, numbered items)
   */
  private extractFromDescription(description: string): string[] {
    if (!description) return [];

    const steps: string[] = [];
    const lines = description.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Match markdown checkboxes: - [ ] Step or - [x] Step
      const checkboxMatch = trimmed.match(/^-\s*\[[ x]\]\s*(.+)/i);
      if (checkboxMatch) {
        steps.push(checkboxMatch[1].trim());
        continue;
      }

      // Match numbered lists: 1. Step or 1) Step
      const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)/);
      if (numberedMatch) {
        steps.push(numberedMatch[1].trim());
        continue;
      }

      // Match bullet lists: - Step or * Step
      const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
      if (bulletMatch && bulletMatch[1].length > 10 && bulletMatch[1].length < 120) {
        steps.push(bulletMatch[1].trim());
      }
    }

    return steps.slice(0, 15); // Cap at 15
  }

  /**
   * Generate a generic task breakdown
   */
  private genericBreakdown(task: Task): string[] {
    const steps = [
      `Review requirements for "${task.title}"`,
      'Plan implementation approach',
      'Implement core functionality',
      'Add error handling',
      'Test implementation',
      'Commit and push changes',
    ];

    // Add deploy step if task has a project
    if (task.project) {
      steps.push(`Deploy to development environment`);
      steps.push('Verify in browser');
    }

    // Add doc step if high priority
    if (task.priority === 'urgent' || task.priority === 'high') {
      steps.push('Update documentation');
    }

    return steps;
  }

  /**
   * Create a Subtask object
   */
  private createSubtask(text: string): Subtask {
    return {
      id: uuidv4(),
      text,
      status: 'empty',
      completed: false,  // Legacy field for backward compatibility
    };
  }

  /**
   * Manually trigger breakdown for a specific task (API use)
   */
  async breakdownTask(taskId: string): Promise<BreakdownResult | null> {
    const task = await taskManager.getTask(taskId);
    if (!task) return null;
    return this.generateSubtasks(task);
  }
}

export const taskAnalyzer = new TaskAnalyzer();
