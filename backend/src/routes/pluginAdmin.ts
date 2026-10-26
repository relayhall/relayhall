/**
 * Plugin administration (card bedf50cc; design ratified by owner ruling E380,
 * sections 4, 5, 7 and 10; choices C2, C5 and C11). Mounted at `/plugin-admin`
 * through routeRegistry.ts.
 *
 *   GET  /plugin-admin                          the installed v1 plugins and their states
 *   GET  /plugin-admin/:name/policy             one plugin's availability
 *   PUT  /plugin-admin/:name/policy             set it ({ availability, clearChoices?, stepUpToken })
 *   GET  /plugin-admin/:name/settings           deployment values, locks, the full schema
 *   PUT  /plugin-admin/:name/settings           replace them ({ values, lockedKeys?, stepUpToken })
 *   POST /plugin-admin/:name/settings/cleanup   remove stored values the schema no longer accepts
 *
 * THE GATE, in this order: a LOGIN SESSION (every bearer credential, a root
 * bearer included, and every API key is refused PLUGIN_ADMIN_REQUIRES_SESSION,
 * C11); a resolved principal; administratorSessionOf with PLUGIN_ADMIN_ACT; and
 * the resolved role must be one of ADMINISTRATOR_ROLES (`admin`, `operator`).
 * Each refusal is audited as denied. Reads need the session check only (C5);
 * each write also burns a single-use step-up bound to (`plugin.admin`, the
 * plugin name) in its own transaction, requires If-Match (PUT) and honours
 * Idempotency-Key. Legacy (non-v1) plugins are outside policy (C10) and, like
 * an unknown plugin, answer the byte-identical 404.
 */
import { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import { auditService } from '../services/AuditService';
import { auditActorFromRequest } from '../utils/auditActor';
import { logCaughtFailure } from '../utils/secretSafeLog';
import {
  ADMINISTRATOR_ROLES, PLUGIN_ADMIN_ACT, administratorSessionOf, isLoginSessionKind,
} from '../utils/administratorSession';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { isPluginV1 } from '../services/PluginHostContract';
import type { LoadedPlugin } from '../services/PluginLoader';
import {
  PLUGIN_AUDIT_RESOURCE_TYPE, pluginSettingsSchemaOf, pluginSettingsService,
} from '../services/PluginSettingsService';
import { PluginSettingsError, staleLockedKeys, staleSettingKeys } from '../services/PluginSettingsSchema';
import { ifMatchRevision, pluginHostLoader, sendPluginNotFound, sendPluginSettingsError } from './pluginHost';

const router = Router();

type Refusal = { ok: false; status: number; code: string; message: string };

/** The administrator standing for this request, or the refusal (design section 7). */
export function pluginAdministratorStanding(req: AuthRequest): { ok: true } | Refusal {
  if (!isLoginSessionKind(req.authMethod)) {
    return { ok: false, status: 403, code: PLUGIN_ADMIN_ACT.requiresSession,
      message: "Changing a plugin's availability or settings is a login-session act: bearer credentials, root bearers included, never perform it" };
  }
  if (!req.principal?.id) {
    return { ok: false, status: 403, code: 'PRINCIPAL_REQUIRED', message: 'This act requires a resolved principal identity' };
  }
  const outcome = administratorSessionOf({
    authMethod: req.authMethod, handle: req.userId, principalRole: req.principal?.role ?? null, sessionRole: req.sessionRole ?? null,
  }, resolveActorRole, PLUGIN_ADMIN_ACT);
  if (!outcome.ok) return outcome;
  if (!ADMINISTRATOR_ROLES.includes(outcome.issuerRole)) {
    return { ok: false, status: 403, code: PLUGIN_ADMIN_ACT.requiresAdministrator,
      message: `${PLUGIN_ADMIN_ACT.description} requires an admin or operator session; this session resolves to '${outcome.issuerRole}'.` };
  }
  return { ok: true };
}

async function admitted(req: AuthRequest, res: Response, action: string): Promise<boolean> {
  const standing = pluginAdministratorStanding(req);
  if (standing.ok) return true;
  await auditService.record({
    action, actor: auditActorFromRequest(req), outcome: 'denied', resourceType: PLUGIN_AUDIT_RESOURCE_TYPE,
    resourceId: typeof req.params?.name === 'string' && /^[a-z][a-z0-9-]{1,63}$/.test(req.params.name) ? req.params.name : null,
    metadata: { refusal: standing.code, authMethod: req.authMethod ?? 'unknown' },
  }).catch(() => undefined);
  res.status(standing.status).json({ success: false, error: 'Refused', code: standing.code, message: standing.message });
  return false;
}

/** An installed v1 plugin with a manifest, or nothing (legacy plugins are outside policy, C10). */
function administeredPlugin(name: unknown): LoadedPlugin | null {
  const plugin = typeof name === 'string' ? pluginHostLoader()?.getPlugin(name) : undefined;
  return plugin?.manifest && isPluginV1(plugin.manifest) ? plugin : null;
}

router.get('/', async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    if (!(await admitted(req, res, 'plugin.admin.read'))) return;
    const plugins = (pluginHostLoader()?.getAllPlugins() ?? []).filter(plugin => plugin.manifest && isPluginV1(plugin.manifest));
    const reads = await pluginSettingsService.availabilityFor(plugins.map(plugin => plugin.name), null);
    res.json({ schemaVersion: 'rh.plugin.admin/1', plugins: plugins.map(plugin => ({
      name: plugin.name,
      label: plugin.manifest.ui?.sidebar?.[0]?.label ?? plugin.name,
      description: plugin.manifest.description,
      state: reads.get(plugin.name)?.state ?? 'default_on',
      revision: reads.get(plugin.name)?.policyRevision ?? 0,
      settings: pluginSettingsSchemaOf(plugin).length,
    })).sort((a, b) => a.name.localeCompare(b.name)) });
  } catch (err) {
    if (sendPluginSettingsError(res, err)) return;
    const errorId = logCaughtFailure('[Plugin admin] list failed', err);
    res.status(503).json({ code: 'PLUGIN_UNAVAILABLE', errorId });
  }
});

router.get('/:name/policy', async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    if (!(await admitted(req, res, 'plugin.admin.read'))) return;
    const plugin = administeredPlugin(req.params.name);
    if (!plugin) { sendPluginNotFound(res); return; }
    const policy = await pluginSettingsService.policy(plugin.name);
    res.json({ name: plugin.name, availability: policy.state, revision: policy.revision });
  } catch (err) {
    if (sendPluginSettingsError(res, err)) return;
    const errorId = logCaughtFailure('[Plugin admin] policy read failed', err);
    res.status(503).json({ code: 'PLUGIN_UNAVAILABLE', errorId });
  }
});

router.put('/:name/policy', idempotent('plugin.policy.put'), async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    if (!(await admitted(req, res, 'plugin.policy.set'))) return;
    const plugin = administeredPlugin(req.params.name);
    if (!plugin) { sendPluginNotFound(res); return; }
    const expected = ifMatchRevision(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const extra = Object.keys(body).find(key => !['availability', 'clearChoices', 'stepUpToken'].includes(key));
    if (extra) throw new PluginSettingsError(400, 'PLUGIN_POLICY_INVALID', 'Unknown field', extra);
    const result = await pluginSettingsService.putPolicy({
      plugin, availability: body.availability, clearChoices: body.clearChoices, expected,
      actor: auditActorFromRequest(req), principalId: String(req.principal!.id), stepUpToken: body.stepUpToken,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendPluginSettingsError(res, err)) return;
    const errorId = logCaughtFailure('[Plugin admin] policy write failed', err);
    res.status(503).json({ code: 'PLUGIN_UNAVAILABLE', errorId });
  }
});

router.get('/:name/settings', async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    if (!(await admitted(req, res, 'plugin.admin.read'))) return;
    const plugin = administeredPlugin(req.params.name);
    if (!plugin) { sendPluginNotFound(res); return; }
    const schema = pluginSettingsSchemaOf(plugin);
    const layers = await pluginSettingsService.layers(plugin.name, null);
    const values = layers.deployment?.values ?? {};
    const locked = layers.deployment?.locked ?? [];
    res.json({
      schemaVersion: 'rh.plugin.admin.settings/1', name: plugin.name, revision: layers.deployment?.revision ?? 0,
      schema: schema.map(entry => ({ ...entry, deliver: entry.deliver ?? 'frame_and_backend' })),
      values, lockedKeys: locked,
      stale: { keys: staleSettingKeys(schema, 'deployment', values), lockedKeys: staleLockedKeys(schema, locked),
        accountRows: await pluginSettingsService.staleAccountRows(plugin) },
    });
  } catch (err) {
    if (sendPluginSettingsError(res, err)) return;
    const errorId = logCaughtFailure('[Plugin admin] settings read failed', err);
    res.status(503).json({ code: 'PLUGIN_UNAVAILABLE', errorId });
  }
});

router.put('/:name/settings', idempotent('plugin.settings.deployment.put'), async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    if (!(await admitted(req, res, 'plugin.settings.deployment.set'))) return;
    const plugin = administeredPlugin(req.params.name);
    if (!plugin) { sendPluginNotFound(res); return; }
    const expected = ifMatchRevision(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const extra = Object.keys(body).find(key => !['values', 'lockedKeys', 'stepUpToken'].includes(key));
    if (extra) throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_INVALID', 'Unknown field', extra);
    const result = await pluginSettingsService.putDeployment({
      plugin, values: body.values ?? {}, lockedKeys: body.lockedKeys, expected,
      actor: auditActorFromRequest(req), principalId: String(req.principal!.id), stepUpToken: body.stepUpToken,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendPluginSettingsError(res, err)) return;
    const errorId = logCaughtFailure('[Plugin admin] settings write failed', err);
    res.status(503).json({ code: 'PLUGIN_UNAVAILABLE', errorId });
  }
});

router.post('/:name/settings/cleanup', idempotent('plugin.settings.cleanup'), async (req: AuthRequest, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    if (!(await admitted(req, res, 'plugin.settings.cleanup'))) return;
    const plugin = administeredPlugin(req.params.name);
    if (!plugin) { sendPluginNotFound(res); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const extra = Object.keys(body).find(key => key !== 'stepUpToken');
    if (extra) throw new PluginSettingsError(400, 'PLUGIN_SETTINGS_INVALID', 'Unknown field', extra);
    const result = await pluginSettingsService.cleanup({
      plugin, actor: auditActorFromRequest(req), principalId: String(req.principal!.id), stepUpToken: body.stepUpToken,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendPluginSettingsError(res, err)) return;
    const errorId = logCaughtFailure('[Plugin admin] cleanup failed', err);
    res.status(503).json({ code: 'PLUGIN_UNAVAILABLE', errorId });
  }
});

export default router;
