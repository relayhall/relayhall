/**
 * AutoArchive - Phase 4 Step 7
 * 
 * Periodically checks for completed tasks older than the archive threshold
 * and moves them to the 'archived' status.
 * 
 * Default: archive after 7 days. Configurable per-task via archivedAt override.
 */

import { taskManagerDB as taskManager } from './TaskManagerDB';
import { pool } from '../db/connection';
import { logCaughtFailure } from '../utils/secretSafeLog';

const DEFAULT_ARCHIVE_AFTER_DAYS = 7;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour

/**
 * 590e88cc. The cycle used to call `getAllTasks()` — the whole estate, fully
 * hydrated — once an hour and then scan it in JavaScript for the handful of
 * rows past the threshold. At the 5,200-Task fixture that is thousands of rows
 * and their child rows pulled through the same twenty-connection pool the
 * request paths are using, to find candidates the database can name in one
 * indexed statement. The job was both a victim of the pool floods this card
 * reports AND a contributor to them.
 *
 * Candidates are now selected in SQL, in BATCHES, with a ceiling on the work
 * one cycle may do. The ceiling is not tidiness: a first cycle against an
 * estate with a large completed backlog would otherwise hold the pool for as
 * long as it took to archive all of it, which is the same failure in a
 * different costume. Whatever a capped cycle leaves behind, the next cycle
 * takes.
 */
export const ARCHIVE_BATCH_SIZE = 100;
export const ARCHIVE_MAX_PER_CYCLE = 1000;

export class AutoArchive {
  private timer: NodeJS.Timeout | null = null;
  private archiveAfterDays: number;
  private batchSize: number;
  private maxPerCycle: number;

  /**
   * The two bounds are constructor parameters for the same reason the
   * threshold already was: they are policy, and a policy that can only be
   * exercised at its shipped value cannot be measured. The shipped instance
   * below takes the defaults, so the deployed behaviour is the constants.
   */
  constructor(
    archiveAfterDays = DEFAULT_ARCHIVE_AFTER_DAYS,
    bounds: { batchSize?: number; maxPerCycle?: number } = {},
  ) {
    this.archiveAfterDays = archiveAfterDays;
    this.batchSize = bounds.batchSize ?? ARCHIVE_BATCH_SIZE;
    this.maxPerCycle = bounds.maxPerCycle ?? ARCHIVE_MAX_PER_CYCLE;
  }

  /**
   * Start the auto-archive timer
   */
  start(): void {
    console.log(`[AutoArchive] Starting — archive completed tasks after ${this.archiveAfterDays} days`);
    
    // Run immediately on start
    this.runArchive();

    // Then check periodically
    this.timer = setInterval(() => this.runArchive(), CHECK_INTERVAL_MS);
  }

  /**
   * Stop the auto-archive timer
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[AutoArchive] Stopped');
  }

  /**
   * Run one archive cycle
   */
  async runArchive(): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - this.archiveAfterDays * 24 * 60 * 60 * 1000);
      let archived = 0;
      let capped = false;

      // The threshold is the SAME comparison the scanning form made, moved to
      // the database: status 'completed', a non-null completed_at, and at or
      // past the cutoff. A row with an unparseable completed_at could not
      // satisfy the JS comparison either — `NaN >= x` is false — so the two
      // forms agree on every row.
      //
      // `<=`, not `<` (round-1 REJECT, non-blocking finding). The scanning form
      // archived on `now - completedTime >= thresholdMs`, which is
      // `completed_at <= cutoff`. A strict `<` made a row sitting exactly on
      // the cutoff wait for the next cycle — a measure-zero case, and a
      // difference all the same.
      for (;;) {
        if (archived >= this.maxPerCycle) { capped = true; break; }
        const batch = await pool.query(
          `SELECT id, title, completed_at
             FROM tasks
            WHERE status = 'completed'
              AND completed_at IS NOT NULL
              AND completed_at <= $1
            ORDER BY completed_at ASC
            LIMIT $2`,
          [cutoff.toISOString(), Math.min(this.batchSize, this.maxPerCycle - archived)],
        );
        if (batch.rows.length === 0) break;

        // Sequential, deliberately: each update is a transaction with history
        // and notification writes hanging off it, and a fan-out here would be
        // the very shape this card was filed about.
        for (const row of batch.rows) {
          await taskManager.updateTask(String(row.id), {
            status: 'archived',
            archivedAt: new Date().toISOString(),
          });
          archived += 1;
          const days = Math.round((Date.now() - new Date(row.completed_at).getTime()) / 86400000);
          console.log(`[AutoArchive] Archived: "${row.title}" (completed ${days}d ago)`);
        }
      }

      if (archived > 0) {
        console.log(`[AutoArchive] Archived ${archived} task(s)${capped ? ` (cycle ceiling ${this.maxPerCycle} reached — the remainder waits for the next cycle)` : ''}`);
      }

      return archived;
    } catch (err) {
      logCaughtFailure('[AutoArchive] cycle failed', err);
      return 0;
    }
  }
}

export const autoArchive = new AutoArchive();
