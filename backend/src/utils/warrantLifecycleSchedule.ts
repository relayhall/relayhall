/** Shared implementation executed by the real 60-second server callback.
 * One sweep per invocation; a busy warrant is retried only by a later tick.
 * No success counter/effect is invented here and no immediate retry is started.
 */
export interface WarrantSweepRetry { warrantId: string; status: 409; code: 'ASSIGNMENT_REFERENCE_BUSY' }
export interface WarrantSweepResult { expired: number; suspended: number; retryable?: WarrantSweepRetry[] }
export async function runWarrantLifecycleSweep(deps: {
  sweep: () => Promise<WarrantSweepResult>;
  onRetryable: (record: WarrantSweepRetry) => void;
  onFailure: (error: unknown) => void;
}): Promise<void> {
  try {
    const result = await deps.sweep();
    for (const record of result.retryable ?? []) deps.onRetryable(record);
  } catch (error) { deps.onFailure(error); }
}
