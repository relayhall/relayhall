import { randomUUID } from 'crypto';
import { identifyCaughtFailure } from './failureClassification';

/**
 * Emit a caught failure without serialising anything supplied by the caught
 * value. Error messages, names, stacks, driver metadata, and object coercion
 * can all contain private data, so the only values published here are: the
 * caller's fixed context string, a bounded category, a registered class name, a
 * closed-set failure code, and a freshly generated failure id.
 *
 * Callers must supply a fixed, developer-authored context string. Never pass
 * request data, database values, or other user-controlled text as `context`.
 *
 * THE CLASS, CODE AND ID ARE NEW (owner ruling R17, plan report 80119869,
 * defect 590e88cc). Before them this sink published a two-value category and
 * nothing else, which left an operator unable to tell one 500 from another —
 * the whole substance of 590e88cc. The widening is the smallest that fixes it:
 * class and code are both decided by lookup in tables written in
 * ./failureClassification, and what is emitted is the table's stored constant,
 * never the string read from the caught value. The id is generated here.
 *
 * NO CALLER CODE RUNS, AND THIS NEVER THROWS. Identification reads only own
 * data properties, so a getter on the caught value is never invoked, and it
 * answers INSPECTION_REFUSED rather than propagating a hostile trap's
 * exception — a sink that threw would replace the failure its caller is trying
 * to report. Review d89f50d8 (B1) rejected an earlier version that read
 * `caught.code` directly and let a getter run inside this function.
 *
 * WHAT THE ID IS FOR. It is returned so a request handler can put the same id
 * in its error response. An operator holding a failing response can then find
 * the exact log line, which is the correlation R17 asked for. It is not a
 * request id and does not span calls: each caught failure gets its own, so two
 * identical log lines remain tellable apart.
 */
export function logCaughtFailure(context: string, caught: unknown): string {
  const { category, errorClass, code } = identifyCaughtFailure(caught);
  const failureId = randomUUID();
  console.error(`${context} (${category}) [class=${errorClass} code=${code} id=${failureId}]`);
  return failureId;
}

/** The warning-level variant, with the same non-disclosure contract. */
export function logCaughtWarning(context: string, caught: unknown): string {
  const { category, errorClass, code } = identifyCaughtFailure(caught);
  const failureId = randomUUID();
  console.warn(`${context} (${category}) [class=${errorClass} code=${code} id=${failureId}]`);
  return failureId;
}
