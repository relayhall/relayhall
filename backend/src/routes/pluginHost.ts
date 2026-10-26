import { Router, Request, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { LoadedPlugin, PluginLoader } from '../services/PluginLoader';
import { activePluginAccount } from '../services/PluginAccountScope';
import { isPluginV1, pluginAccountCan } from '../services/PluginHostContract';
import { telemetryProjectionService } from '../services/TelemetryProjectionService';
import { usageQuotaService } from '../services/UsageQuotaService';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { pluginMetricsService } from '../services/PluginMetricsService';
import { accountWideReach, boardMetricsService } from '../services/BoardMetricsService';
import { scopesSatisfy } from '../utils/scopeMap';
import { idempotent } from '../middleware/idempotency';
import { isLoginSessionKind } from '../utils/administratorSession';
import { auditService } from '../services/AuditService';
import { auditActorFromRequest } from '../utils/auditActor';
import { StepUpError } from '../services/StepUpService';
import { verifyIssuedPluginAssertion } from '../services/PluginAssertion';
import { pool } from '../db/connection';
import { bearerLayerFor, ACCOUNT_BEARER_LAYER } from '../utils/bearerLayers';
import {
  PluginNotFoundError, PluginRevisionError, availabilityUserControlled, pluginSettingsSchemaOf, pluginSettingsService,
  PLUGIN_AUDIT_RESOURCE_TYPE,
} from '../services/PluginSettingsService';
import {
  PluginSettingsError, publicSchema, resolveEffectiveSettings, settingDelivery, staleSettingKeys,
} from '../services/PluginSettingsSchema';
const router = Router();
let loader: PluginLoader | null = null;
export function setPluginHostLoader(value: PluginLoader) { loader = value; }
/** The loader the plugin host and the plugin administration routes share. */
export function pluginHostLoader(): PluginLoader | null { return loader; }

/** The bridge's byte-identical concealment answer, used by every host route. */
export function sendPluginNotFound(res: Response): void { res.status(404).json({code:'PLUGIN_NOT_FOUND'}); }

/**
 * The If-Match revision of a PUT (card bedf50cc, design section 10): absent is
 * 400 REVISION_REQUIRED; an absent row is revision 0, so the first PUT sends
 * `If-Match: 0`.
 */
export function ifMatchRevision(req: Request): number {
  const raw = req.headers['if-match'];
  const value = (typeof raw === 'string' ? raw : '').replace(/^"+|"+$/g, '').trim();
  if (!/^(0|[1-9][0-9]{0,9})$/.test(value)) {
    throw new PluginRevisionError(400, 'REVISION_REQUIRED', 'Send If-Match with the revision you last read (0 for a setting never written)');
  }
  return Number(value);
}

/** The refusals the plugin settings routes answer themselves: typed, instanceof-guarded, fixed text. */
export function sendPluginSettingsError(res: Response, err: unknown): boolean {
  if (err instanceof PluginNotFoundError) { sendPluginNotFound(res); return true; }
  if (err instanceof PluginRevisionError) {
    res.status(err.status).json({ success: false, error: 'Refused', code: err.code, message: err.message,
      ...(err.current !== undefined ? { details: { revision: err.current } } : {}) });
    return true;
  }
  if (err instanceof PluginSettingsError) {
    res.status(err.status).json({ success: false, error: 'Refused', code: err.code, message: err.message,
      ...(err.field ? { field: err.field } : {}) });
    return true;
  }
  if (err instanceof StepUpError) {
    res.status(err.status).json({ success: false, error: 'Refused', code: err.code, message: err.message,
      ...(err.challenge ? { stepUp: err.challenge } : {}) });
    return true;
  }
  return false;
}

/** The plugin's label for a person: its first sidebar label, else its name. */
function pluginLabel(plugin: LoadedPlugin): string {
  const label = plugin.manifest?.ui?.sidebar?.[0]?.label;
  return typeof label === 'string' && label.trim() ? label : plugin.name;
}

/**
 * The bridge's predicate (a v1 manifest and the installation file's view
 * grant) ANDed with availability: the plugin is visible to this Account.
 */
async function visiblePlugin(req: Request): Promise<{ plugin: LoadedPlugin; account: string } | null> {
  const plugin = loader?.getPlugin(req.params.name);
  const account = await activePluginAccount(req as AuthRequest);
  if (!plugin?.manifest || !isPluginV1(plugin.manifest) || !pluginAccountCan(plugin.config,account)) return null;
  const availability = await pluginSettingsService.availability(plugin.name, account);
  return availability.enabled ? { plugin, account: account! } : null;
}

router.get('/:name/bridge', async (req: Request, res: Response) => {
  res.set('Cache-Control','private, no-store');
  try {
    const plugin = loader?.getPlugin(req.params.name);
    const account = await activePluginAccount(req as AuthRequest);
    if (!plugin?.manifest || !isPluginV1(plugin.manifest) || !pluginAccountCan(plugin.config,account)) {
      res.status(404).json({code:'PLUGIN_NOT_FOUND'}); return;
    }
    // Card bedf50cc (E380): availability is ANDed with the file predicate
    // above, never substituted for it. A hidden plugin answers the same 404.
    const availability = await pluginSettingsService.availability(plugin.name, account);
    if (!availability.enabled) { res.status(404).json({code:'PLUGIN_NOT_FOUND'}); return; }
    const capabilities = plugin.manifest.relayhall?.capabilities ?? [];
    const payload: Record<string,unknown> = {schemaVersion:'rh.plugin.bridge/1',observedAt:new Date().toISOString()};
    // Two UNGATED members (C7): no third capability joins the vocabulary.
    // `settings` leaves out every `deliver: backend` key and every secret.
    payload.availability = { state: availability.state, enabled: availability.enabled };
    const effective = resolveEffectiveSettings(pluginSettingsSchemaOf(plugin),
      await pluginSettingsService.layers(plugin.name, account), { includeBackend: false });
    payload.settings = { values: effective.values, sources: effective.sources };
    if (capabilities.includes('telemetry.sessions')) {
      // rh.plugin.bridge/1 carries an ARRAY of every session, short ones
      // included: the Sessions page's default hiding (card 0ac41d40) is a page
      // view, and changing what a plugin receives is a contract revision.
      payload.sessions = (await telemetryProjectionService.sessions(
        {kind:'account',accountId:account!},{limit:200,includeShort:true})).sessions;
      const metrics = await pluginMetricsService.read(account!,plugin.config.metrics_source_product);
      payload.metricsSources = metrics;
      payload.metrics = !metrics.truncated && metrics.sources.length === 1 ? metrics.sources[0] :
        {schemaVersion:'rh.plugin.metrics/1',queue:null,throughput:null};
      // Card e220be94 (E353): an ADDITIVE field. The core's own count of the
      // caller Account's board work (queue = armed todo Tasks it owns,
      // throughput = its handbacks in the rolling hour), versioned on its own
      // and freshness-stamped; metrics and metricsSources above are unchanged.
      // It never throws: what cannot be computed is 'unknown', never 0.
      // The route itself needs only services:read, but these are Task
      // aggregates: a caller whose effective scopes lack tasks:read is
      // answered unknown (caller-reach), never a count.
      const authReq = req as AuthRequest;
      payload.boardMetrics = await boardMetricsService.read(account!,
        scopesSatisfy(authReq.scopes, 'tasks:read')
        && accountWideReach(account!, authReq.principal?.id, authReq.delegationLinks));
    }
    if (capabilities.includes('usage.quotas')) payload.quotas = await usageQuotaService.read(account!);
    res.json(payload);
  } catch (err) {
    const errorId = logCaughtFailure('[Plugin host] bridge failed',err);
    res.status(503).json({code:'PLUGIN_BRIDGE_UNAVAILABLE',errorId});
  }
});

/**
 * GET /plugin-host/choices — the Account's eligible plugins (design section
 * 10, the B3 repair): those the installation file lets it view, v1, state not
 * `disabled`. A switched-off `default_on` or `available` plugin is listed here
 * (and on the choice route) and nowhere else; nothing about it but its name,
 * label, state and switch is disclosed. `services:read`; the Account is
 * derived, never named.
 */
router.get('/choices', async (req: Request, res: Response) => {
  res.set('Cache-Control','private, no-store');
  try {
    const account = await activePluginAccount(req as AuthRequest);
    const eligible = (loader?.getAllPlugins() ?? []).filter(plugin =>
      plugin.manifest && isPluginV1(plugin.manifest) && pluginAccountCan(plugin.config, account));
    const reads = await pluginSettingsService.availabilityFor(eligible.map(plugin => plugin.name), account);
    const plugins = eligible.flatMap(plugin => {
      const read = reads.get(plugin.name);
      if (!read || read.state === 'disabled') return [];
      return [{ name: plugin.name, label: pluginLabel(plugin), state: read.state, enabled: read.enabled,
        userControlled: availabilityUserControlled(read.state), revision: read.choiceRevision }];
    }).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ schemaVersion: 'rh.plugin.choices/1', plugins });
  } catch (err) {
    const errorId = logCaughtFailure('[Plugin host] choices failed', err);
    res.status(503).json({ code: 'PLUGIN_UNAVAILABLE', errorId });
  }
});

/**
 * The gate on the Account's own writes (design section 7): the /warrants
 * precedent (a LOGIN SESSION with a resolved principal) plus this design's
 * additions, no delegation link and activePluginAccount(req) === the
 * principal. Anything else is 403 SESSION_ONLY, audited as denied. Exported
 * for its unit test: the authentication middleware sets delegation links only
 * on a bearer, so no live fixture can present a login session carrying one.
 */
export async function ownSessionAccount(req: AuthRequest, res: Response, action: string): Promise<string | null> {
  let account: string | null = null;
  if (isLoginSessionKind(req.authMethod) && req.principal?.id && !(req.delegationLinks?.length)) {
    account = await activePluginAccount(req);
    if (account !== req.principal.id) account = null;
  }
  if (account) return account;
  await auditService.record({
    action, actor: auditActorFromRequest(req), outcome: 'denied', resourceType: PLUGIN_AUDIT_RESOURCE_TYPE, resourceId: null,
    metadata: { refusal: 'SESSION_ONLY', authMethod: req.authMethod ?? 'unknown' },
  }).catch(() => undefined);
  res.status(403).json({
    error: 'Forbidden', code: 'SESSION_ONLY',
    message: "Turning a plugin on or off and changing your own plugin settings is an act of your own signed-in session: bearer credentials and delegated callers are refused",
  });
  return null;
}

/** The Account's own plugin, for its choice route: the file predicate and a state other than `disabled`. */
async function choosablePlugin(req: Request, account: string): Promise<LoadedPlugin | null> {
  const plugin = loader?.getPlugin(req.params.name);
  if (!plugin?.manifest || !isPluginV1(plugin.manifest) || !pluginAccountCan(plugin.config, account)) return null;
  const read = await pluginSettingsService.availability(plugin.name, account);
  return read.state === 'disabled' ? null : plugin;
}

/** PUT /plugin-host/:name/choice — the Account's own on/off, `{ enabled }`. */
router.put('/:name/choice', idempotent('plugin.choice.put'), async (req: Request, res: Response) => {
  res.set('Cache-Control','private, no-store');
  try {
    const authReq = req as AuthRequest;
    const account = await ownSessionAccount(authReq, res, 'plugin.choice.set');
    if (!account) return;
    const plugin = await choosablePlugin(req, account);
    if (!plugin) { sendPluginNotFound(res); return; }
    const expected = ifMatchRevision(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (Object.keys(body).some(key => key !== 'enabled')) {
      throw new PluginSettingsError(400, 'PLUGIN_CHOICE_INVALID', 'The only field is enabled');
    }
    const result = await pluginSettingsService.putChoice({ plugin, accountId: account, enabled: body.enabled, expected,
      actor: auditActorFromRequest(authReq) });
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendPluginSettingsError(res, err)) return;
    const errorId = logCaughtFailure('[Plugin host] choice failed', err);
    res.status(503).json({ code: 'PLUGIN_UNAVAILABLE', errorId });
  }
});

/**
 * GET /plugin-host/:name/settings — the Account's own effective settings, its
 * choice and the schema for the host-rendered form. Values of `deliver:
 * backend` keys are omitted (the key, its label and its source are shown).
 */
router.get('/:name/settings', async (req: Request, res: Response) => {
  res.set('Cache-Control','private, no-store');
  try {
    const visible = await visiblePlugin(req);
    if (!visible) { sendPluginNotFound(res); return; }
    const { plugin, account } = visible;
    const schema = pluginSettingsSchemaOf(plugin);
    const [availability, layers] = await Promise.all([
      pluginSettingsService.availability(plugin.name, account), pluginSettingsService.layers(plugin.name, account)]);
    const effective = resolveEffectiveSettings(schema, layers, { includeBackend: true });
    const values = Object.fromEntries(Object.entries(effective.values).filter(([key]) =>
      settingDelivery(schema.find(entry => entry.key === key)!) !== 'backend'));
    res.json({
      schemaVersion: 'rh.plugin.settings/1', name: plugin.name, label: pluginLabel(plugin),
      revision: layers.account?.revision ?? 0,
      availability: { state: availability.state, enabled: availability.enabled,
        userControlled: availabilityUserControlled(availability.state), revision: availability.choiceRevision },
      schema: publicSchema(schema), values, sources: effective.sources,
      stale: staleSettingKeys(schema, 'account', layers.account?.values ?? {}),
    });
  } catch (err) {
    const errorId = logCaughtFailure('[Plugin host] settings read failed', err);
    res.status(503).json({ code: 'PLUGIN_UNAVAILABLE', errorId });
  }
});

/** PUT /plugin-host/:name/settings/account — replace the Account's own values. */
router.put('/:name/settings/account', idempotent('plugin.settings.account.put'), async (req: Request, res: Response) => {
  res.set('Cache-Control','private, no-store');
  try {
    const authReq = req as AuthRequest;
    const account = await ownSessionAccount(authReq, res, 'plugin.settings.account.set');
    if (!account) return;
    const visible = await visiblePlugin(req);
    if (!visible || visible.account !== account) { sendPluginNotFound(res); return; }
    const expected = ifMatchRevision(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (Object.keys(body).some(key => key !== 'values')) {
      throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_INVALID', 'The only field is values');
    }
    const result = await pluginSettingsService.putAccountValues({ plugin: visible.plugin, accountId: account,
      values: body.values ?? {}, expected, actor: auditActorFromRequest(authReq) });
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendPluginSettingsError(res, err)) return;
    const errorId = logCaughtFailure('[Plugin host] settings write failed', err);
    res.status(503).json({ code: 'PLUGIN_UNAVAILABLE', errorId });
  }
});

export default router;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /plugin-host/:name/settings/effective — the PLUGIN BACKEND's read of one
 * Account's effective settings (card bedf50cc, design section 9, choice C8).
 *
 * It is mounted in server.ts BEFORE the protected funnel, beside the proxy,
 * and is not in routeRegistry: it authenticates by the plugin assertion in
 * `X-RelayHall-Assertion` alone and never reads `Authorization`. It verifies
 * HS256 only (algorithm pinned), issuer `relayhall`, audience = `:name`, an
 * unexpired token signed with that plugin's own key, and a `jti` this core
 * issued for that plugin, that `sub` and that capability. It then re-checks
 * that `sub` is an active Account-layer principal (a fresh read, not the
 * principal cache) and that the plugin is still available to it under the
 * PROXY's composition (N15): the Account still holds the assertion's
 * capability, ANDed with availability. Any failure answers the byte-identical
 * `404 PLUGIN_NOT_FOUND`. The answer is that Account's effective non-secret
 * values, `deliver: backend` keys included.
 */
export const PLUGIN_EFFECTIVE_SETTINGS_ROUTE_PATH = '/plugin-host/:name/settings/effective';

export async function pluginEffectiveSettingsHandler(req: Request, res: Response): Promise<void> {
  res.set('Cache-Control','private, no-store');
  try {
    const plugin = loader?.getPlugin(req.params.name);
    if (!plugin?.manifest || !isPluginV1(plugin.manifest)) { sendPluginNotFound(res); return; }
    // Only X-RelayHall-Assertion is read; Authorization never is.
    const verified = verifyIssuedPluginAssertion(plugin.config, plugin.name, req.headers['x-relayhall-assertion']);
    if (!verified || !UUID.test(verified.sub)) { sendPluginNotFound(res); return; }
    const { sub, capability } = verified;
    const principal = (await pool.query('SELECT status, kind, parent_principal_id FROM principals WHERE id = $1', [sub])).rows[0];
    if (!principal || principal.status !== 'active' || bearerLayerFor(principal.kind, principal.parent_principal_id) !== ACCOUNT_BEARER_LAYER) {
      sendPluginNotFound(res); return;
    }
    if (!pluginAccountCan(plugin.config, sub, capability)) { sendPluginNotFound(res); return; }
    if (!(await pluginSettingsService.availability(plugin.name, sub)).enabled) { sendPluginNotFound(res); return; }
    const effective = resolveEffectiveSettings(pluginSettingsSchemaOf(plugin),
      await pluginSettingsService.layers(plugin.name, sub), { includeBackend: true });
    res.json({ schemaVersion: 'rh.plugin.settings.effective/1', plugin: plugin.name, account: sub,
      values: effective.values, sources: effective.sources });
  } catch (err) {
    // Every verification failure answered the 404 above. An internal failure
    // (the store unreachable) is 503 with its correlation id: it can only arise
    // for a request the checks before it did not refuse.
    const errorId = logCaughtFailure('[Plugin host] effective settings read failed', err);
    res.status(503).json({ code: 'PLUGIN_SETTINGS_UNAVAILABLE', errorId });
  }
}
