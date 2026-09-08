import http from 'http';

/**
 * Boot-check probe (card 590c638a, ruling 4). In boot-check mode
 * (`RELAYHALL_BOOT_CHECK=1`) the server binds, reports, and exits before any
 * database or background activity. `RELAYHALL_BOOT_CHECK_PROBE=<path>` adds
 * ONE self-request to the bound port between bind and exit, and prints the
 * answer on a single `BOOT CHECK PROBE` line, so a drill can prove that
 * configuration handed to the COMPILED process is what its live endpoint
 * answers - without a database and without lingering.
 *
 * The admissible paths are an enumerated set (never a pattern): every entry
 * must be answerable with no database, or the probe would hang the gate on
 * the pinned unreachable pool.
 */
export const BOOT_CHECK_PROBE_PATHS: ReadonlySet<string> = new Set(['/health/orchestration']);

export const BOOT_CHECK_PROBE_LINE_PREFIX = 'BOOT CHECK PROBE';

export interface BootCheckProbeAnswer {
  path: string;
  status: number;
  body: string;
}

export function bootCheckProbePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.RELAYHALL_BOOT_CHECK_PROBE;
  if (raw === undefined || raw === '') return null;
  if (!BOOT_CHECK_PROBE_PATHS.has(raw)) {
    throw new Error(`RELAYHALL_BOOT_CHECK_PROBE must be one of: ${[...BOOT_CHECK_PROBE_PATHS].join(', ')}`);
  }
  return raw;
}

export function runBootCheckProbe(port: number, path: string, timeoutMs = 5_000): Promise<BootCheckProbeAnswer> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ path, status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => { req.destroy(new Error('boot-check probe timed out')); });
    req.on('error', reject);
  });
}

/** One line, machine-readable: `BOOT CHECK PROBE <path> <status> <body>`. */
export function formatBootCheckProbeLine(answer: BootCheckProbeAnswer): string {
  return `${BOOT_CHECK_PROBE_LINE_PREFIX} ${answer.path} ${answer.status} ${answer.body.replace(/\s+/g, ' ').trim()}`;
}
