// FIRST, before any other module loads: refuse the .env.example placeholder
// secrets with a readable reason and exit 1 (config/bootSecretsCheck).
import './config/bootSecretsCheck';
import { runWarrantLifecycleSweep } from './utils/warrantLifecycleSchedule';
import { startKnowledgeLifecycleExporter } from './services/KnowledgeLifecycleExporter';
import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
// Imported HERE, above the module-level `app.use(...)` that reads it. This
// file interleaves imports with top-level statements, and the compiled CJS
// build keeps source order — an import placed below its first use compiles,
// type-checks, and boots under tsx (ESM hoisting), then throws a TDZ
// ReferenceError from `dist/server.js` in the container. The compiled boot
// check in CI exists because that is exactly how this line was first found.
import { jsonBodyOptions } from './utils/jsonBodyTypes';
import morgan from 'morgan';
import http from 'http';
import dotenv from 'dotenv';
import { pool, BOOT_CHECK_MODE } from './db/connection';
import { healthHandler, orchestrationConfigurationHandler } from './routes/health';
// RH-P3.C8: imported ahead of the interleaved route code below — server.ts
// executes statements between import groups, so these must precede their
// first use at the rate-limit/probe block.
import { apiRateLimit } from './middleware/apiRateLimit';
import { runFunctionalProbe } from './utils/functionalProbe';
import { runStartupChecks } from './db/migrate';
import { accessSurfaceService } from './services/AccessSurfaceService';
import { WebSocketService } from './services/websocket';
import { setProjectOwnerInvalidationSink } from './services/ProjectOwnershipService';
import { ConnectorNotificationService } from './services/ConnectorNotificationService';
import { connectorWakeService } from './services/ConnectorWakeService';
import { taskManagerDB as taskManager } from './services/TaskManagerDB';
import { taskAnalyzer } from './services/taskAnalyzer';
import { autoArchive } from './services/autoArchive';
import { reviewerHeartbeatService } from './services/ReviewerHeartbeatService';
import { taskOrchestrationService } from './services/TaskOrchestrationService';
import { loadHardenedOrchestrationConfig } from './config/HardenedOrchestrationConfig';
import { registerOrchestrationSchedules } from './utils/orchestrationSchedules';
import { bootCheckProbePath, formatBootCheckProbeLine, runBootCheckProbe } from './config/bootCheckProbe';
import { PluginLoader } from './services/PluginLoader';
import { appearanceService } from './services/AppearanceService';
import { getLegacyAppearanceDisplayName } from './config/relayhall';
import { apiRootHandler } from './routes/apiRoot';
import {
  deploymentIdentityConfiguration,
  formatDeploymentIdentityRefusal,
  formatDeploymentIdentityResolved,
  resolveDeploymentIdentity,
} from './config/deploymentIdentity';

// Load environment variables
dotenv.config();
const hardenedOrchestrationConfig = loadHardenedOrchestrationConfig();
// Card 590c638a: the claim/lease surface is configured HERE, before the
// listener exists and independent of any database work, so what
// GET /health/orchestration answers is the process's effective configuration
// from the first request - including in boot-check mode, where the drill
// reads it. `configure` is pure (validation + assignment).
taskOrchestrationService.configure({
  maxActiveGlobal: hardenedOrchestrationConfig.maxActiveGlobal,
  maxActivePerProject: hardenedOrchestrationConfig.maxActivePerProject,
  leaseTtlSeconds: Math.floor(hardenedOrchestrationConfig.leaseTtlMs / 1000),
});
// The probe path is validated at boot, not at probe time: a misspelt value
// fails the gate before bind, never silently probes nothing.
const bootCheckProbe = bootCheckProbePath();

// THE FAILURE LOGGER IS IMPORTED HERE, ABOVE ITS FIRST USE, AND NOT WITH
// THE OTHER IMPORTS BELOW.
//
// The two process handlers that follow call `logCaughtFailure`. TypeScript
// emits `require` calls in import order, so with the import at its old
// position — after ~130 other modules — ANY failure raised while those
// modules were still evaluating reached the handler before the logger's
// binding existed, and the process died with
// `ReferenceError: Cannot access 'secretSafeLog_1' before initialization`
// instead of the real diagnostic. A missing JWT_SECRET was enough to do it.
//
// This predates SETGOV — `main` at `7e0a04d` has the identical ordering —
// and is repaired here because round 2 of this candidate's cross-family
// review found it (report `2cef1098`) and because this candidate adds a
// boot census whose whole value is a READABLE refusal at boot. The
// source-order control is in `accessSurfaces.test.ts`.
import { logCaughtFailure, logCaughtWarning } from './utils/secretSafeLog';

// Global error handlers - safety nets to prevent crashes
process.on('uncaughtException', (err: Error) => {
  console.error('╔═══════════════════════════════════════════════════════════╗');
  console.error('║ UNCAUGHT EXCEPTION - Server stability compromised        ║');
  console.error('╚═══════════════════════════════════════════════════════════╝');
  logCaughtFailure('[Server] uncaught exception', err);
  if (BOOT_CHECK_MODE) {
    console.error('❌ BOOT CHECK FAILED (uncaught exception)');
    process.exit(1);
  }
  console.error('⚠️  Server continuing, but this should be investigated!');
  // Don't exit - keep server running
});

process.on('unhandledRejection', (reason: any, _promise: Promise<any>) => {
  console.error('╔═══════════════════════════════════════════════════════════╗');
  console.error('║ UNHANDLED PROMISE REJECTION - Check async error handling ║');
  console.error('╚═══════════════════════════════════════════════════════════╝');
  logCaughtFailure('[Server] unhandled promise rejection', reason);
  if (BOOT_CHECK_MODE) {
    console.error('❌ BOOT CHECK FAILED (unhandled rejection)');
    process.exit(1);
  }
  console.error('⚠️  Server continuing, but this should be investigated!');
  // Don't exit - keep server running
});

const app: Express = express();
// Without this every proxied request reports the nginx container's address, so
// a per-source throttle would collapse into one global bucket and a single
// scanner could throttle the owner. Hop count is configurable because the edge
// topology differs between environments.

const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS);
app.set('trust proxy', Number.isFinite(trustProxyHops) ? trustProxyHops : 1);
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Initialize WebSocket service for real-time task events
const wsService = new WebSocketService(server, '/ws');
// AZ-A12 clause 13: the recipients are both owners and, for a Group owner, its active members.
setProjectOwnerInvalidationSink((recipientIds) => {
  wsService.broadcastToPrincipals(recipientIds, { type: 'project.authority_changed' });
});
// Card 6dea3cca: `?wake=1` sockets double as Connector wake endpoints; the
// dispatcher itself starts below with the other background workers.
const connectorNotifications = new ConnectorNotificationService(server, 1000, connectorWakeService);

// Initialize Plugin Loader
const PLUGINS_CONFIG = process.env.RELAYHALL_PLUGINS_CONFIG || './relayhall.plugins.json';
const pluginLoader = new PluginLoader(PLUGINS_CONFIG);

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(morgan(NODE_ENV === 'development' ? 'dev' : 'combined'));
// The JSON types in ONE place (`utils/jsonBodyTypes`): `application/json`
// and RFC 7644's `application/scim+json`, which the default type list left
// unparsed and a conforming provisioning client refused (card 127556e1).
app.use(express.json(jsonBodyOptions));
app.use(express.urlencoded({ extended: true }));

// No media bytes are served from core: the last policy route (the public
// journal allowlist) left with the Journal plugin (P1.3 ruling A1) — plugins
// serve their own bytes. Directory-wide static mounts stay banned permanently:
// two pre-policy directory mounts once exposed inbound chat attachments,
// personal documents and private media — the second through an alias that
// bypassed the first mount's deny shim. The noStaticMediaMounts test pins
// this invariant.

// RH-P3.C8 (§2.12 abuse controls): the API-wide per-source ceiling sits in
// front of every route; health/readiness/functional probes are exempt (a
// monitor must never be told 429 about the thing it watches), and the login
// path keeps its own stricter exponential backoff underneath.
app.use(apiRateLimit);

// Readiness: can this process serve requests right now (DB answers)?
app.get('/readiness', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not-ready' });
  }
});

// RH-P3.C8: the functional probe — "an HTTP 200 is not health". DB, auth
// and the cursor feed must each actually work, or the probe fails 503 with
// per-check booleans (coarse detail words only; never errors or secrets).
app.get('/health/functional', async (_req: Request, res: Response) => {
  const result = await runFunctionalProbe();
  res.status(result.ok ? 200 : 503).json({
    status: result.ok ? 'functional' : 'failing',
    checks: result.checks,
  });
});

// Health check endpoint
// Handler lives in routes/health.ts so its failure envelope is
// behaviorally testable without booting the server (review 3db17273 B2).
app.get('/health', healthHandler);
// Card 590c638a: the effective orchestration configuration, read from the
// configured service - the reachability check. Same audience as /health.
app.get('/health/orchestration', orchestrationConfigurationHandler);

// API root: the version and the backend image's own build identity (card
// 6d549392). Named, like healthHandler, so it is testable without a boot.
app.get('/', apiRootHandler);

// Routes
import authRoutes from './routes/auth';
import configRoutes from './routes/config';
import oauthRoutes, { oauthWellKnownRoutes } from './routes/oauth';
import appearanceRoutes from './routes/appearance';
import { telemetryService } from './services/TelemetryService';
import { telemetryRetentionService } from './services/TelemetryRetentionService';
import { telemetryQuarantineService } from './services/TelemetryQuarantineService';
import { registerTelemetrySchedules } from './utils/telemetrySchedules';
import { warrantService } from './services/WarrantService';
import { oauthAuthorizationService } from './services/OAuthAuthorizationService';
import { approvalService } from './services/ApprovalService';
import { authorityEditExecutor } from './services/AuthorityEditExecutor';
import { knowledgeSharedWriterService } from './services/KnowledgeSharedWriterService';
import { loginSessionService } from './services/LoginSessionService';
import { agentLifecycleService } from './services/AgentLifecycleService';
import { setPluginLoader, publicPluginThemeRoutes } from './routes/plugins';
import { authMiddleware } from './middleware/auth';
import { sharedAuthorizationMiddleware } from './middleware/sharedAuthorization';
// RH-P3.C4: the ordered protected-route list lives in ONE module, which the
// REST ingress here and the board's in-process MCP ingress both iterate. The
// two ingresses differ in the transport class each stamps and in nothing else
// (AUTHZ design 4d961e37 §7.5).
import { registerProtectedRoutes } from './routeRegistry';
import mcpRoutes, { MCP_ROUTE_PATH } from './mcp/httpRoute';
// RH-TW1b slice 2 (card dac2ca71, estate card 928586a6): the OTLP/gRPC
// receiver, a SECOND listener that dispatches into the telemetry registration
// above. Imported AFTER routeRegistry, which it reads, so it adds no module
// evaluation ahead of the route list under either build.
import { startOtlpGrpcIngress, type OtlpGrpcIngressHandle } from './services/otlp/OtlpGrpcIngress';
import { otlpGrpcPortFromEnv } from './utils/otlp/otlpGrpc';
import { OAUTH_ROUTE_PATH, OAUTH_WELL_KNOWN_ROUTE_PATH } from './utils/oauthMetadata';
import knowledgeJwksRoutes from './routes/knowledgeJwks';
import { buildOpenApiSpec } from './openapi/spec';
import { apiErrorHandler } from './utils/apiErrors';
import { webhookDeliveryWorker } from './services/WebhookDeliveryWorker';
import { createPluginProxy } from './middleware/pluginProxy';
import { setPluginHostLoader, PLUGIN_EFFECTIVE_SETTINGS_ROUTE_PATH, pluginEffectiveSettingsHandler } from './routes/pluginHost';
import { refreshTrustedProxyAddresses } from './middleware/loginRateLimit';
import { sweepExpiredIdempotencyRecords } from './middleware/idempotency';

// RELAYHALL_OTLP_GRPC_PORT: unset or empty = no OTLP/gRPC listener. A value
// that is not a port refuses the boot here, in boot-check mode too, so a typo
// can never silently become "no receiver".
let otlpGrpcPort: number | null = null;
try {
  otlpGrpcPort = otlpGrpcPortFromEnv(process.env.RELAYHALL_OTLP_GRPC_PORT);
} catch {
  console.error('🛑 RELAYHALL_OTLP_GRPC_PORT must be a TCP port number (1-65535), or empty to disable the OTLP/gRPC receiver — refusing to start');
  process.exit(1);
}
let otlpGrpcIngress: OtlpGrpcIngressHandle | null = null;

// Wire up route dependencies
setPluginLoader(pluginLoader);
setPluginHostLoader(pluginLoader);

// One registration funnel for every protected router. Keeping the shared
// predicate adjacent to authentication makes bypass a structural diff rather
// than a convention each route author has to remember.
const protectedRouter = (path: string, ...handlers: any[]): void => {
  app.use(path, authMiddleware, sharedAuthorizationMiddleware, ...handlers);
};

// Public routes (no auth required)
app.use('/auth', authRoutes);
app.use('/config', configRoutes);
// Deployment identity is public pre-login by design (RH-DESIGN.6 §5.4): the
// login page renders the deployment's own logo before anyone authenticates.
// Only the ACTIVE asset is reachable here — history is root-gated and arrives
// with the rest of RH-UI.4.
app.use('/appearance', appearanceRoutes);

// RH-P3.C6 — the OAuth 2.1 authorization server (strategy §Phase 3, ratified
// C3 amendment). Public by contract: its whole purpose is to serve a client
// that has no credential yet. It reads and writes no board object; the human
// consent endpoints inside it authenticate the login session in-handler and
// refuse bearer credentials (AZ-18), and the authority a consent confers is
// evaluated by the shared predicate on every subsequent call, never here.
app.use(OAUTH_ROUTE_PATH, oauthRoutes);

// RH-P3.C6 — the two OAuth discovery documents, at the API ROOT rather than
// under /oauth: RFC 8414 has a client construct
// `<issuer>/.well-known/oauth-authorization-server`, and the issuer IS this
// root. The router renders two constants; it reads nothing, writes nothing and
// authenticates nobody.
app.use(OAUTH_WELL_KNOWN_ROUTE_PATH, oauthWellKnownRoutes);

// RH-KW1 candidate B (design 94747de9 §10.2, owner decision D8): the
// knowledge-assertion JWKS, mounted on the SAME well-known path and for the
// same reason — a relying source must verify an assertion core signed
// before, and independently of, any credential it holds for core.
//
// It is THE ONE knowledge route outside the auth mesh, and the design says
// so in as many words. What makes that safe is not the mount but the
// handler: it renders the PUBLIC half of each non-retired signing key from
// process configuration, touches no database, takes no parameters, and
// therefore produces identical bytes for every caller.
app.use(OAUTH_WELL_KNOWN_ROUTE_PATH, knowledgeJwksRoutes);

// Plugin proxy middleware — public, MUST be before /plugins auth route
// Iframes can't send JWT headers, so plugin content must be unauthenticated
app.use(createPluginProxy(pluginLoader));

// Card bedf50cc (E380, design section 9, choice C8): the plugin BACKEND's
// read of one Account's effective settings. Mounted here, beside the proxy and
// BEFORE the protected funnel: it authenticates by the plugin assertion in
// X-RelayHall-Assertion alone (HS256 pinned, audience, expiry, a core-issued
// jti for that plugin and Account), never reads Authorization, and is not in
// routeRegistry, so no other ingress reaches it.
app.get(PLUGIN_EFFECTIVE_SETTINGS_ROUTE_PATH, pluginEffectiveSettingsHandler);

// The plugin theme stylesheet is PUBLIC (RH-DESIGN.6 §4.4): plugin iframes
// cannot send a JWT, so an authenticated stylesheet is unreachable by the only
// caller it has. It publishes canonical semantic token values and nothing else.
app.use('/plugins', publicPluginThemeRoutes);

// Every protected router, in the ONE order routeRegistry declares. Adding a
// mount there adds it to BOTH ingresses at once, which is the point: a family
// reachable over REST is reachable over MCP by construction.
registerProtectedRoutes(protectedRouter);
app.get('/openapi.json', authMiddleware, sharedAuthorizationMiddleware, (_req, res) => res.json(buildOpenApiSpec()));

// RH-P3.C4 — the board's IN-PROCESS MCP endpoint (design 4d961e37 §7.5, MCP
// spec de73f9f8 §1.3/§1.4). It is DELIBERATELY not a `protectedRouter` mount:
// `authMiddleware` stamps `api`, and this ingress must stamp `mcp` after
// transport termination. It authenticates every call itself, accepting rh_
// principal credentials only, and answers 401 + WWW-Authenticate rather than
// redirecting to a login page. Its transport class is declared `mcp` in
// utils/transportMap; authorizationRouteCoverage pins that this is the only
// authenticated mount outside the funnel.
app.use(MCP_ROUTE_PATH, mcpRoutes);
app.use(apiErrorHandler); // must stay after all routes: normalizes uncaught errors to the API envelope
if (!BOOT_CHECK_MODE) {
  webhookDeliveryWorker.start();
  connectorWakeService.start();
}
// Note: nginx strips /api/ prefix, so routes are registered without it

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: any) => {
  const errorId = logCaughtFailure('[Server] request handler failed', err);
  res.status(500).json({
    error: 'Internal Server Error',
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong',
    errorId
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path
  });
});

// Pre-initialize plugin loader before server starts so /plugins is ready on first request
if (!BOOT_CHECK_MODE) {
  pluginLoader.initialize().then(() => {
    const pluginCount = pluginLoader.getAllPlugins().length;
    if (pluginCount > 0) {
      console.log(`✅ Plugin system pre-initialized (${pluginCount} plugins loaded)`);
    } else {
      console.log('ℹ️  Plugin system pre-initialized (no plugins configured — core-only mode)');
    }
  }).catch((err: Error) => {
    logCaughtWarning('[Startup] plugin pre-initialization failed', err);
  });
}

// Start server
// Keep the trusted-proxy address list current; container addresses change on
// every recreate. Started here, after all imports have initialised.
if (!BOOT_CHECK_MODE) {
  void refreshTrustedProxyAddresses();
  setInterval(() => { void refreshTrustedProxyAddresses(); }, 60_000).unref();
}

// RH-P3.C7: the task.stuck derivation sweep — lease expiry or status
// staleness, on the board's own clock (§2.6.3/§2.6.5: derived events come
// from board-owned timestamps, never agent internals; telemetry frames have
// zero server-side effect and are NOT an input here). Episode-deduplicated
// inside the sweep; failures are logged and the next tick retries.
if (!BOOT_CHECK_MODE) {
  setInterval(() => {
    telemetryService.sweepStuckTasks().catch((err: unknown) => {
      logCaughtWarning('[Startup] task.stuck sweep failed', err as Error);
    });
  }, 60_000).unref();
}

// Card c8f95fef: the LEASE EXPIRY sweep, beside the derivation above and on
// its cadence. `expireActiveLeases()` was a public method NOTHING called, so
// a lapsed Lease stayed marked `active` on a quiet board — the column was
// reconciled only by the private in-transaction sweep at the top of
// `claimReadyTask`, which is to say only when somebody attempted a claim.
//
// Nothing depended on the column: the derivation above compares expires_at
// to the board clock and the capacity budgets carry `AND expires_at > NOW()`
// (S-A5). What was wrong is that `task_execution_leases.status` did not mean
// what it said, which is a trap for the next query written against it.
//
// The schedule lives in `utils/orchestrationSchedules` as DATA rather than
// inline here, for the reason review `2b893224` gave for the telemetry ones:
// a test injects a fake registrar and fake service and RUNS the callback,
// instead of proving that a line of this file still contains a name.
if (!BOOT_CHECK_MODE) {
  registerOrchestrationSchedules({
    expireActiveLeases: () => taskOrchestrationService.expireActiveLeases(),
    onFailure: (context: string, err: unknown) => { logCaughtWarning(context, err as Error); },
  }, setInterval as never);
}

// Card fb06c930 (design bf8928ee v5 §3.6): retire expired retry records.
// The CORRECTNESS rule is the read rule — a row past expires_at is treated as
// absent by the middleware whatever the sweep has done — so this is storage
// hygiene, bounded per tick, and never a gate on the contract being true.
if (!BOOT_CHECK_MODE) {
  setInterval(() => {
    sweepExpiredIdempotencyRecords().catch((err: unknown) => {
      logCaughtWarning('[Startup] retry-record sweep failed', err as Error);
    });
  }, 600_000).unref();
}

// RH-TW1a: the telemetry plane's background schedules — the TS-9 retention
// sweep (ratification sitting 7e7eeca3, design 7d5c0cdc §6.5.1) and the §6.5.2
// per-connector quarantine-rate alarm.
//
// Both live in `utils/telemetrySchedules` as DATA rather than inline here.
// Review `d9697a35` F2 found the alarm computed but never asked for, and the
// control that answered it could only prove a line of this file still contained
// a name. Review `2b893224` asked for better: with the registration extracted,
// a test injects a fake registrar and fake services and RUNS the callback —
// which schedules exist, how often, what each does with what it gets back, and
// what happens when one rejects, all without starting a listener.
//
// This file's remaining job is to hand over the real timer and the real
// services. Nothing decidable happens here.
if (!BOOT_CHECK_MODE) {
  registerTelemetrySchedules({
    // Reuse the existing hourly retention tick. Product event detail must age
    // out even on an idle deployment with no new completion to trigger pruning.
    sweepRetention: async () => {
      await telemetryRetentionService.sweep();
      await pool.query('SELECT product_metric_prune()');
    },
    evaluateAlarms: () => telemetryQuarantineService.evaluateAlarms(),
    // Identifiers and numbers only — the same rule the plane's audit writes
    // follow (§6.5.3). Nothing in the line comes from a payload.
    emitAlarm: (line: string) => { console.warn(line); },
    onFailure: (context: string, err: unknown) => { logCaughtWarning(context, err as Error); },
  }, setInterval as never);
}

// RH-P3.AZ-S4: the warrant/approval lifecycle sweep (design 4d961e37
// §6.1/§6.2/§6.4). Mint, decide and collect enforce every TTL and status
// LIVE — the sweep only PERSISTS the flips (warrant date/anchor-terminal
// expiry, AZ-31a creator-cap auto-suspension, approval pending/collect
// TTLs, bound-credential death) and emits their events, the §7.3 doctrine.
if (!BOOT_CHECK_MODE) {
  setInterval(() => {
    void runWarrantLifecycleSweep({
      sweep: () => warrantService.sweepLifecycles(),
      onRetryable: (record) => logCaughtWarning('[Startup] warrant lifecycle sweep retryable ' + JSON.stringify(record), new Error('Retry on a later periodic sweep')),
      onFailure: (err) => logCaughtWarning('[Startup] warrant lifecycle sweep failed', err as Error),
    });
    approvalService.sweepTtls().catch((err: unknown) => {
      logCaughtWarning('[Startup] approval TTL sweep failed', err as Error);
    });
    // RH-P3.AZ-S5 (AZ-29): persist terminal-state Agent auto-revokes — the
    // middleware refuses these live (T6); the sweep writes the durable
    // revocations, events and AZ-31c invalidations.
    agentLifecycleService.sweepTerminalAgents().catch((err: unknown) => {
      logCaughtWarning('[Startup] terminal-agent sweep failed', err as Error);
    });
    // RH-P3.C6: retire spent authorization-code rows. They hold protocol state
    // only — a code DIGEST, a challenge, a scope list, never a token — so
    // deleting them destroys no evidence: the audit ledger holds the approval
    // and the issuance, and the credential row holds the grant. Without this
    // the table grows one row per authorization forever.
    oauthAuthorizationService.sweepExpired().catch((err: unknown) => {
      logCaughtWarning('[Startup] OAuth authorization-request sweep failed', err);
    });
    // RH-P5.SSO.W3 (review R2 F1): SSO-R16 binds retained-ID-token disposal to
    // LOGIN-SESSION DEATH. The explicit revocation paths dispose in the same
    // statement that revokes; a login session that dies by absolute expiry or
    // idle timeout writes nothing at all, so its artefact is disposed of here.
    // Liveness itself is enforced live in LoginSessionService.resolve — this
    // sweep persists the physical consequence and never extends a login session.
    loginSessionService.disposeRetainedTokensOnDeadLoginSessions().catch((err: unknown) => {
      logCaughtWarning('[Startup] retained ID-token disposal sweep failed', err as Error);
    });
    // Card 549cc51f (E298 Q5): a shared-area writer row whose expiry has
    // passed is removed, audited as actor `system`. The snapshot exporter and
    // the list already omit it live; the sweep persists the removal.
    knowledgeSharedWriterService.sweepExpired().catch((err: unknown) => {
      logCaughtWarning('[Startup] shared-area writer expiry sweep failed', err as Error);
    });
  }, 60_000).unref();
}

// AZ-A13 clause 6j (E94; card 1a38270d): revert every widening approved "until
// this task ends" that is DUE - its date passed, or its related task is
// completed or archived (the two terminal writers revert at once, in their own
// transaction; this backstops them) - one transaction per revert. A
// warrant-ceiling revert while tasks ride the warrant waits for a person's
// acknowledgement. Its own timer, at the lifecycle sweep's cadence, so a date
// revert is late by at most one minute.
if (!BOOT_CHECK_MODE) {
  setInterval(() => {
    authorityEditExecutor.sweepReverts().catch((err: unknown) => {
      logCaughtWarning('[Startup] authority-edit revert sweep failed', err as Error);
    });
  }, 60_000).unref();
}


// §7.2/T30 (review e5e437a0 B4): credential-keyset integrity is a MANDATORY
// startup prerequisite verified BEFORE the HTTP listener is exposed, wholly
// independent of optional startup work. Failure exits the process non-zero.
async function verifyCredentialKeysetOrExit(): Promise<void> {
  try {
    const { runCredentialCanary, runIdentityProviderSecretCanary, credentialKeysetConfigured } =
      await import('./utils/credentialCrypto');
    const { pool: canaryPool } = await import('./db/connection');
    const encrypted = await canaryPool.query(
      'SELECT COUNT(*)::int AS n FROM principal_credentials WHERE secret_ciphertext IS NOT NULL AND revoked_at IS NULL');
    const encryptedRows = Number(encrypted.rows[0]?.n ?? 0);
    // SS-7 (review R2 round 1, finding B1): the missing-keyset refusal has to
    // see EVERY kind of envelope-encrypted secret, not only Account
    // credentials. A deployment holding federated providers and no encrypted
    // Account credentials at all is an ordinary state, and it used to warn and
    // continue here with its provider secrets unreachable.
    const providerSecretsPresent = await canaryPool.query(
      'SELECT COUNT(*)::int AS n FROM identity_providers WHERE client_secret_ct IS NOT NULL OR client_private_key_ct IS NOT NULL');
    const providerSecretRows = Number(providerSecretsPresent.rows[0]?.n ?? 0);
    if (!credentialKeysetConfigured()) {
      if (encryptedRows > 0 || providerSecretRows > 0) {
        throw new Error('RELAYHALL_CREDENTIAL_KEYS is unset but encrypted secrets exist — refusing to run with unreachable secrets (§7.2, SS-7)');
      }
      console.warn('⚠️ Credential envelope keyset not configured — credential issuance will refuse until RELAYHALL_CREDENTIAL_KEYS/RELAYHALL_CREDENTIAL_ACTIVE_KEY are set (§7.2)');
      return;
    }
    if (encryptedRows > 0) {
      const checked = await runCredentialCanary(canaryPool);
      console.log(`✅ Credential canary: ${checked} sample(s) decrypt and match their hashes`);
      setInterval(() => {
        runCredentialCanary(canaryPool).catch((err) => {
          logCaughtFailure('🛑 [CredentialCanary] periodic check FAILED (T30):', err);
        });
      }, 6 * 60 * 60 * 1000).unref();
    }
    // SS-7: the same treatment for Identity provider secrets. Kept separate
    // from the count above because a deployment can hold federated providers
    // and no encrypted Account credentials at all, and the reverse.
    if (providerSecretRows > 0) {
      const checkedProviders = await runIdentityProviderSecretCanary(canaryPool);
      console.log(`✅ Identity provider secret canary: ${checkedProviders} secret(s) decrypt under their declared keys`);
      setInterval(() => {
        runIdentityProviderSecretCanary(canaryPool).catch((err) => {
          logCaughtFailure('🛑 [IdentityProviderCanary] periodic check FAILED (SS-7):', err);
        });
      }, 6 * 60 * 60 * 1000).unref();
    }
  } catch (err) {
    logCaughtFailure('🛑 [CredentialCanary] startup check FAILED (T30) — terminating before listen:', err);
    process.exit(1);
  }
}

// RH-TW1a (design 7d5c0cdc §6.1): the Tier-0 pseudonymization pepper is an
// ENVIRONMENT value that must actually reach this process. A pepper that only
// failed on the first telemetry write would silently degrade the privacy
// property for every row written before anyone noticed, so it is proven at
// startup by a canary in the shape credentialCrypto's canary established.
//
// Refusal rule, matching the credential gate's SS-7 shape: if envelope rows
// already exist and no pepper is configured, the deployment cannot write
// consistent pseudonyms and must not run. With no envelope rows yet, an
// unconfigured pepper is an ordinary pre-TW1a state and only warns — the
// ingest path refuses on its own when a write is actually attempted.
async function verifyTelemetryPepperOrExit(): Promise<void> {
  try {
    const { telemetryPepperCanary, telemetryPepperConfigured } = await import('./utils/telemetryPepper');
    const { pool: canaryPool } = await import('./db/connection');
    const envelopeRows = await canaryPool.query(
      'SELECT COUNT(*)::int AS n FROM session_events WHERE schema_version IS NOT NULL');
    const rows = Number(envelopeRows.rows[0]?.n ?? 0);
    if (!telemetryPepperConfigured()) {
      if (rows > 0) {
        throw new Error('RELAYHALL_TELEMETRY_PEPPERS is unset but pseudonymized telemetry rows exist — refusing to run with an unreachable pepper (design 7d5c0cdc §6.1)');
      }
      console.warn('⚠️ Telemetry pseudonymization pepper not configured — envelope ingest will refuse until RELAYHALL_TELEMETRY_PEPPERS/RELAYHALL_TELEMETRY_ACTIVE_PEPPER are set (§6.1)');
      return;
    }
    const canary = telemetryPepperCanary();
    console.log(`✅ Telemetry pepper canary: active pepper '${canary.activePepperId}' of ${canary.pepperCount} reaches this process`);
  } catch (err) {
    logCaughtFailure('🛑 [TelemetryPepperCanary] startup check FAILED (§6.1) — terminating before listen:', err);
    process.exit(1);
  }
}

// Card 7f0c84f0 (owner ruling D33): the server refuses to serve without a
// RESOLVED deployment identity - the named local administrator Account,
// active, a parentless human, holding the root sentinel. The definition and
// its five conditions live in `config/deploymentIdentity.ts`. Like the two
// gates above it runs to completion BEFORE the listener exists and exits
// non-zero with one line; unlike them it has no warn-and-continue arm. It
// reads one row and changes nothing about how an identity is used once
// resolved.
//
// Boot-check mode has no database by contract, so it checks the
// configuration half only (the handle is well formed); everything else waits
// for a real boot.
function verifyDeploymentIdentityConfigurationOrExit(): void {
  const configured = deploymentIdentityConfiguration();
  if (!configured.ok) {
    console.error(formatDeploymentIdentityRefusal(configured));
    process.exit(1);
  }
}

async function verifyDeploymentIdentityOrExit(): Promise<void> {
  let outcome: Awaited<ReturnType<typeof resolveDeploymentIdentity>>;
  try {
    outcome = await resolveDeploymentIdentity(pool);
  } catch (err) {
    // The row could not be READ - not evidence that it is missing. Same
    // redacting sink and the same exit as the gates above.
    logCaughtFailure('🛑 [DeploymentIdentity] the local administrator Account could not be read — terminating before listen:', err);
    process.exit(1);
  }
  if (!outcome.ok) {
    console.error(formatDeploymentIdentityRefusal(outcome));
    process.exit(1);
  }
  console.log(formatDeploymentIdentityResolved(outcome));
}

// Boot-check mode: bind must either succeed and exit 0 or fail and exit 1 —
// never linger. The timeout(1) form of the old gate left orphaned node
// children squatting the port (task 97cb6261); a hard in-process deadline and
// an explicit listen-error handler make the gate deterministic instead.
if (BOOT_CHECK_MODE) {
  server.on('error', (err: Error) => {
    logCaughtFailure('❌ BOOT CHECK FAILED (listen error)', err);
    process.exit(1);
  });
  setTimeout(() => {
    console.error('❌ BOOT CHECK FAILED (deadline exceeded before bind report)');
    process.exit(1);
  }, 20_000);
}

const startListening = (): void => { server.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════╗
║   RelayHall API                   ║
║   Environment: ${NODE_ENV.padEnd(22)}║
║   Port: ${String(PORT).padEnd(30)}║
║   URL: http://localhost:${PORT}       ║
║   WebSocket: ws://localhost:${PORT}/ws    ║
╚═══════════════════════════════════════╝
  `);

  // Boot-check mode ends here, deliberately BEFORE any database-touching
  // initialization (startup checks, task manager, auto-archive, heartbeat,
  // behaviour-profile sync, credential telemetry) and before any background job
  // starts. The pool is already pinned to an unreachable endpoint in
  // db/connection.ts; skipping initialization here is the second layer.
  if (BOOT_CHECK_MODE) {
    const finish = (): void => {
      console.log('✅ BOOT CHECK OK — server constructed and bound; no database, webhook or background-job activity. Exiting.');
      server.close(() => {
        process.exit(0);
      });
    };
    const runBootCheck = (): void => {
      if (bootCheckProbe) {
        // Card 590c638a: one self-request over the bound socket, printed on a
        // single line; the drill judges it. Any failure here is a failed gate.
        const address = server.address();
        const boundPort = typeof address === 'object' && address ? address.port : Number(PORT);
        runBootCheckProbe(boundPort, bootCheckProbe).then((answer) => {
          console.log(formatBootCheckProbeLine(answer));
          finish();
        }).catch((err: unknown) => {
          logCaughtFailure('❌ BOOT CHECK FAILED (probe request failed)', err);
          process.exit(1);
        });
        return;
      }
      finish();
    };
    // RH-TW1b slice 2: when the OTLP/gRPC receiver is configured, the boot
    // check binds it and closes it again, so a bind failure fails the gate.
    // Binding touches no database: calls are dispatched only when they arrive.
    if (otlpGrpcPort === null) { runBootCheck(); return; }
    startOtlpGrpcIngress({ port: otlpGrpcPort }).then(async (ingress) => {
      console.log(`✅ BOOT CHECK OTLP/gRPC receiver bound on port ${ingress.port}`);
      await ingress.close();
      runBootCheck();
    }).catch((err: unknown) => {
      logCaughtFailure('❌ BOOT CHECK FAILED (OTLP/gRPC listener)', err);
      process.exit(1);
    });
    return;
  }

  // Schema/migration consistency check (task 475a54c9) — logs a loud warning
  // on ledger-vs-directory drift or missing critical tables; never crashes.
  await runStartupChecks();
  startKnowledgeLifecycleExporter();

  // SETGOV: the Access-surface census (design 7a9317b2 §3.3, acceptance annex
  // 85a2218d D2 clauses (i)(ii)(iii)(v)(vi)(vii), and D15's overlap refusal).
  // This one DOES crash. A registration that breaks the governable rule, two
  // surfaces resolving one path, a stale `excluded_families` requirement, or a
  // state-changing method declared as a read family are all authorization
  // defects, and the ratified answer to each is a boot-time error rather than
  // a discovery at the first refusal.
  //
  // Clause (iv) — the root-gated families a surface's frontend route actually
  // calls, CAPTURED FROM A RENDERED PAGE — is deliberately deferred to SETGOV
  // candidate C, which is where rendered pages exist. Declared, not omitted.
  //
  // It runs here, after `runStartupChecks`, because it reads the catalogue: in
  // boot-check mode (RELAYHALL_BOOT_CHECK=1) the process has already exited
  // above, before any database activity, and never reaches this line.
  try {
    const findings = await accessSurfaceService.auditCatalogue();
    if (findings.length > 0) {
      // The findings are DATA this boot owns, not a caught message: they name
      // route families, surface keys and ratified requirements, never a
      // secret, and an operator cannot repair the catalogue without reading
      // them. Routing them through `logCaughtFailure` would redact them to
      // `(Error) [class=Error code=ERROR_UNCLASSIFIED]` — an undiagnosable
      // boot, which is how the first version of this behaved.
      console.error('❌ Access-surface census FAILED — refusing to serve');
      console.error('   (design 7a9317b2 §3.3; acceptance annex 85a2218d D2/D15)');
      for (const finding of findings) console.error(`   - ${finding}`);
      process.exit(1);
    }
    console.log('✅ Access-surface census passed');
  } catch (err: unknown) {
    // Reaching here means the census could not RUN — an unreachable database,
    // not an unsound catalogue. That is the redacting logger's case.
    logCaughtFailure('❌ Access-surface census could not run — refusing to serve', err);
    process.exit(1);
  }

  // RH-TW1b slice 2: the OTLP/gRPC receiver binds only AFTER the census has
  // passed, so it never serves telemetry the census would have refused. A
  // configured receiver that cannot bind refuses the process, as the census
  // does: the operator asked for it, and a silent absence would look like an
  // exporter fault.
  if (otlpGrpcPort !== null) {
    try {
      otlpGrpcIngress = await startOtlpGrpcIngress({ port: otlpGrpcPort });
      console.log(`✅ OTLP/gRPC receiver listening on port ${otlpGrpcIngress.port}`);
    } catch (err: unknown) {
      logCaughtFailure('❌ OTLP/gRPC receiver could not bind — refusing to serve', err);
      process.exit(1);
    }
  }

  try {
    const imported = await appearanceService.importLegacyDisplayName(getLegacyAppearanceDisplayName());
    if (imported) console.log('✅ Imported legacy sidebar title into Appearance');
  } catch {
    console.warn('⚠️  Legacy Appearance import skipped (non-fatal)');
  }

  // Initialize task manager
  try {
    await taskManager.initialize();
    console.log('✅ Task manager initialized');
  } catch (err: any) {
    logCaughtWarning('[Startup] task manager initialization failed', err);
  }

  taskAnalyzer.initialize();
  console.log('✅ Task analyzer started');

  autoArchive.start();
  console.log('✅ Auto-archive started');
  
  console.log('[OrchestrationConfig]', {
    reviewerHeartbeatEnabled: hardenedOrchestrationConfig.reviewerHeartbeatEnabled,
    reviewerHeartbeatIntervalMs: hardenedOrchestrationConfig.reviewerHeartbeatIntervalMs,
    reviewTimeoutMs: hardenedOrchestrationConfig.reviewTimeoutMs,
    // Read back from the service, not the parsed config: this log line and
    // GET /health/orchestration report the same object (card 590c638a).
    orchestration: taskOrchestrationService.effectiveConfiguration(),
    hermesQaRepoConfigured: Boolean(hardenedOrchestrationConfig.hermesQaRepo),
  });
  reviewerHeartbeatService.configure(
    hardenedOrchestrationConfig.reviewerHeartbeatIntervalMs,
    hardenedOrchestrationConfig.reviewerHeartbeatStateFile,
  );

  if (hardenedOrchestrationConfig.reviewerHeartbeatEnabled) {
    reviewerHeartbeatService.start();
    console.log('✅ Verifier heartbeat started (bounded structured review for review tasks)');
  } else {
    console.log('⏸️ Verifier heartbeat disabled (fail-closed rollout default)');
  }

  // The startup personality repository sync was removed 2026-08-09 (owner
  // ruling: board-native personalities only; no import surface).

  // Upsert retirement-telemetry rows for the legacy env keys (spec §2.3).
  // Skips-and-retries-next-boot on a pre-migration DB; it must never crash
  // the container the migration runbook needs to exec into.
  try {
    const { principalService } = await import('./services/PrincipalService');
    await principalService.syncLegacyEnvCredentials();
    console.log('✅ Legacy env credential telemetry synced');
  } catch (err) {
    logCaughtWarning('[Startup] legacy credential telemetry sync skipped', err);
  }


  // Board-side observation is retired (strategy §2.6.5/F11): no gateway
  // connection, no sessions-file ingestion, no transcript reads. Session data
  // arrives only when reporter plugins push it — see docs/observability.md.

  // Plugin system is pre-initialized before server.listen() — no double-init needed here.

  // Helper: enrich a task with computed dependency fields for WS broadcast.
  // getTask() in TaskManagerDB always returns blockedBy: [] without computing it —
  // this function adds the real blocked/blockingTasks/dependentTasks fields so the
  // frontend can reactively update the locked/greyed visual state without a refresh.
  async function enrichTaskWithDeps(task: any): Promise<any> {
    try {
      const [blocked, blockingTasks, dependentTasks] = await Promise.all([
        taskManager.isTaskBlocked(task.id),
        taskManager.getBlockingTasks(task.id),
        taskManager.getDependentTasks(task.id),
      ]);
      return {
        ...task,
        blocked,
        blockingTasks: blockingTasks.map((t: any) => ({ id: t.id, title: t.title })),
        dependentTasks: dependentTasks.map((t: any) => ({ id: t.id, title: t.title })),
      };
    } catch (err) {
      logCaughtFailure('[WebSocket] task dependency enrichment failed', err);
      return task;
    }
  }

  // Wire up task manager events to WebSocket
  taskManager.on('tasks.updated', (tasks) => {
    wsService.broadcast({ type: 'tasks.updated', tasks });
  });
  
  taskManager.on('task.created', async (task) => {
    const enriched = await enrichTaskWithDeps(task);
    wsService.broadcast({ type: 'task.created', task: enriched });
  });
  
  taskManager.on('task.updated', async (task) => {
    // Enrich the updated task with computed dependency state
    const enriched = await enrichTaskWithDeps(task);
    wsService.broadcast({ type: 'task.updated', task: enriched });

    // Cascade: also emit updates for tasks that depend on this task.
    // Their blocked state may have changed — e.g. this task was just completed
    // (unblocking dependents) or a new dependency was added (blocking a dependent).
    // Without this, dependent tasks only update on a full page refresh.
    try {
      const dependentTasks = await taskManager.getDependentTasks(task.id);
      for (const depTask of dependentTasks) {
        const enrichedDep = await enrichTaskWithDeps(depTask);
        wsService.broadcast({ type: 'task.updated', task: enrichedDep });
      }
    } catch (err) {
      logCaughtFailure('[WebSocket] dependent-task cascade failed', err);
    }

    // Cascade: also emit updates for tasks that THIS task depends on.
    // Their dependentTasks list may have changed — e.g. when B.dependsOn=[A] is updated,
    // A's "Blocks N tasks" badge should update immediately without a refresh.
    try {
      if (task.dependsOn && task.dependsOn.length > 0) {
        for (const blockerId of task.dependsOn) {
          const blockerTask = await taskManager.getTask(blockerId);
          if (blockerTask) {
            const enrichedBlocker = await enrichTaskWithDeps(blockerTask);
            wsService.broadcast({ type: 'task.updated', task: enrichedBlocker });
          }
        }
      }
    } catch (err) {
      logCaughtFailure('[WebSocket] blocker-task cascade failed', err);
    }
  });
  
  taskManager.on('task.deleted', (id) => {
    wsService.broadcast({ type: 'task.deleted', id });
  });
  
  taskManager.on('task.archived', (id) => {
    wsService.broadcast({ type: 'task.archived', id });
  });
  
  console.log('✅ Task WebSocket events configured');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');

  autoArchive.stop();

  // Stop plugin loader
  pluginLoader.stop();

  // Stop task manager
  await taskManager.shutdown();

  // Shutdown WebSocket
  wsService.shutdown();
  connectorWakeService.stop();
  connectorNotifications.shutdown();

  // Close the OTLP/gRPC listener (in-flight calls get a short grace).
  if (otlpGrpcIngress) await otlpGrpcIngress.close();

  // Close HTTP server
  server.close(() => {
    console.log('Server closed');
    pool.end();
    process.exit(0);
  });
}); };

// B4: the credential-keyset gate runs to completion BEFORE the socket is
// exposed; only then do we start listening. Boot-check mode has no DB
// activity by contract and starts directly once the identity configuration
// is well formed. The deployment identity (card 7f0c84f0) is the LAST gate
// before the listener, so every existing gate still runs first, unchanged.
if (BOOT_CHECK_MODE) {
  verifyDeploymentIdentityConfigurationOrExit();
  startListening();
} else {
  void verifyCredentialKeysetOrExit()
    .then(verifyTelemetryPepperOrExit)
    .then(verifyDeploymentIdentityOrExit)
    .then(startListening);
}

export { app, server };
