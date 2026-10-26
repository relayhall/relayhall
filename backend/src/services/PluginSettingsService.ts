/**
 * Plugin availability and layered plugin settings, stage 1 (card bedf50cc;
 * design ratified by owner ruling E380). The database half: the availability
 * predicate, the stored layers, and the five writes, each in one transaction
 * with its audit row (and, for an administrator act, its step-up burn).
 *
 * AVAILABILITY NARROWS, NEVER WIDENS. `pluginAvailableTo` answers only "does
 * the policy state, with this Account's own choice, resolve to on?" for a v1
 * plugin. Every site ANDs it with its existing check (the installation file's
 * view grant, or the proxy's capability grant) and never substitutes it for
 * one: no state here can grant a capability.
 *
 * Audit rows name the actor, the Account (if any), the plugin, the keys
 * changed and the new revision. They never carry a setting value.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import type { LoadedPlugin } from './PluginLoader';
import { isPluginV1 } from './PluginHostContract';
import { auditService, type AuditActor } from './AuditService';
import { stepUpService, stepUpRequiredError } from './StepUpService';
import { stableJson } from '../utils/stableJson';
import {
  PluginSettingsError, backendOnlyValuesKept, staleLockedKeys, staleSettingKeys, validateLockedKeys, validateSettingsValues,
  type PluginSettingDeclaration,
} from './PluginSettingsSchema';

export const PLUGIN_AVAILABILITY_STATES = ['required', 'default_on', 'available', 'disabled'] as const;
export type PluginAvailabilityState = (typeof PLUGIN_AVAILABILITY_STATES)[number];
/** No policy row: today's behaviour, so nothing disappears on upgrade (C1). */
export const DEFAULT_PLUGIN_AVAILABILITY: PluginAvailabilityState = 'default_on';
/** The step-up binding of every administrator write: (`plugin.admin`, plugin name). */
export const PLUGIN_ADMIN_STEP_UP_ACTION = 'plugin.admin';
export const PLUGIN_AUDIT_RESOURCE_TYPE = 'plugin';
export const PLUGIN_AUDIT_ACTIONS = {
  policy: 'plugin.policy.set',
  deployment: 'plugin.settings.deployment.set',
  cleanup: 'plugin.settings.cleanup',
  choice: 'plugin.choice.set',
  account: 'plugin.settings.account.set',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an Account may switch this state itself. */
export function availabilityUserControlled(state: PluginAvailabilityState): boolean {
  return state === 'default_on' || state === 'available';
}

/** The state and the Account's own choice, resolved (design section 4). */
export function availabilityResolvesOn(state: PluginAvailabilityState, choice: boolean | null): boolean {
  switch (state) {
    case 'required': return true;
    case 'default_on': return choice !== false;
    case 'available': return choice === true;
    default: return false;
  }
}

/** The settings a plugin declares (absent: none). */
export function pluginSettingsSchemaOf(plugin: LoadedPlugin | undefined): PluginSettingDeclaration[] {
  return plugin?.manifest?.ui?.settings_schema ?? [];
}

/** A revision refusal (If-Match). */
export class PluginRevisionError extends Error {
  constructor(readonly status: 400 | 412, readonly code: 'REVISION_REQUIRED' | 'REVISION_MISMATCH', message: string,
    readonly current?: number) {
    super(message);
    this.name = 'PluginRevisionError';
  }
}
/** The plugin is not found for this caller (the byte-identical 404). */
export class PluginNotFoundError extends Error {
  constructor() { super('PLUGIN_NOT_FOUND'); this.name = 'PluginNotFoundError'; }
}

export interface AvailabilityRead {
  state: PluginAvailabilityState;
  choice: boolean | null;
  enabled: boolean;
  policyRevision: number;
  choiceRevision: number;
}

export interface StoredSettingsLayers {
  deployment: { values: Record<string, unknown>; locked: string[]; revision: number } | null;
  account: { values: Record<string, unknown>; revision: number } | null;
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

function asState(value: unknown): PluginAvailabilityState {
  return PLUGIN_AVAILABILITY_STATES.includes(value as PluginAvailabilityState)
    ? value as PluginAvailabilityState : DEFAULT_PLUGIN_AVAILABILITY;
}

/** The keys whose stored value differs between two documents (names only). */
function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(key => !(key in before) || !(key in after) || stableJson(before[key]) !== stableJson(after[key])).sort();
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function checkRevision(expected: number, current: number): void {
  if (expected !== current) {
    throw new PluginRevisionError(412, 'REVISION_MISMATCH', 'The revision you sent is not the current one', current);
  }
}

async function burnStepUp(client: PoolClient, input: { stepUpToken: unknown; principalId: string; plugin: string }):
  Promise<{ tokenId: string; method: string }> {
  if (typeof input.stepUpToken !== 'string' || input.stepUpToken.length === 0) {
    throw await stepUpRequiredError(input.principalId, PLUGIN_ADMIN_STEP_UP_ACTION, input.plugin,
      'Changing a plugin needs a single-use step-up bound to (plugin.admin, the plugin name)', client);
  }
  return stepUpService.consume(client, {
    token: input.stepUpToken, principalId: input.principalId, action: PLUGIN_ADMIN_STEP_UP_ACTION, targetId: input.plugin,
  });
}

export class PluginSettingsService {
  /** Policy state and the Account's own choice for each name, in one statement. */
  async availabilityFor(names: string[], accountId: string | null, queryable: Queryable = pool): Promise<Map<string, AvailabilityRead>> {
    const answer = new Map<string, AvailabilityRead>();
    if (names.length === 0) return answer;
    const account = accountId && UUID.test(accountId) ? accountId : null;
    const result = await queryable.query(
      `SELECT n.name, p.availability, p.version AS policy_version, c.enabled, c.version AS choice_version
         FROM unnest($1::text[]) AS n(name)
         LEFT JOIN plugin_policies p ON p.plugin_name = n.name
         LEFT JOIN plugin_account_choices c ON c.plugin_name = n.name AND c.account_principal_id = $2::uuid`,
      [names, account]);
    for (const row of result.rows) {
      const state = row.availability == null ? DEFAULT_PLUGIN_AVAILABILITY : asState(row.availability);
      const choice = account && typeof row.enabled === 'boolean' ? row.enabled : null;
      answer.set(String(row.name), {
        state, choice, enabled: availabilityResolvesOn(state, choice),
        policyRevision: row.policy_version == null ? 0 : Number(row.policy_version),
        choiceRevision: choice === null || row.choice_version == null ? 0 : Number(row.choice_version),
      });
    }
    return answer;
  }

  async availability(name: string, accountId: string | null, queryable: Queryable = pool): Promise<AvailabilityRead> {
    const read = (await this.availabilityFor([name], accountId, queryable)).get(name);
    return read ?? { state: DEFAULT_PLUGIN_AVAILABILITY, choice: null, enabled: true, policyRevision: 0, choiceRevision: 0 };
  }

  /** The stored deployment layer and (when an Account is named) that Account's layer. */
  async layers(name: string, accountId: string | null, queryable: Queryable = pool): Promise<StoredSettingsLayers> {
    const account = accountId && UUID.test(accountId) ? accountId : null;
    const result = await queryable.query(
      `SELECT layer, settings_values, locked_keys, version FROM plugin_settings
        WHERE plugin_name = $1 AND (layer = 'deployment' OR (layer = 'account' AND account_principal_id = $2::uuid))`,
      [name, account]);
    const layers: StoredSettingsLayers = { deployment: null, account: null };
    for (const row of result.rows) {
      if (row.layer === 'deployment') {
        layers.deployment = { values: row.settings_values ?? {}, locked: row.locked_keys ?? [], revision: Number(row.version) };
      } else if (account) {
        layers.account = { values: row.settings_values ?? {}, revision: Number(row.version) };
      }
    }
    return layers;
  }

  /** The Account's own on/off (`default_on` / `available` only). */
  async putChoice(input: { plugin: LoadedPlugin; accountId: string; enabled: unknown; expected: number; actor: AuditActor }):
    Promise<{ name: string; state: PluginAvailabilityState; enabled: boolean; revision: number }> {
    if (typeof input.enabled !== 'boolean') throw new PluginSettingsError(400, 'PLUGIN_CHOICE_INVALID', 'enabled must be true or false', 'enabled');
    const name = input.plugin.name;
    return inTransaction(async (client) => {
      const policy = await client.query('SELECT availability FROM plugin_policies WHERE plugin_name = $1 FOR SHARE', [name]);
      const state = policy.rows[0] ? asState(policy.rows[0].availability) : DEFAULT_PLUGIN_AVAILABILITY;
      if (state === 'disabled') throw new PluginNotFoundError();
      if (state === 'required') {
        throw new PluginSettingsError(409, 'CHOICE_NOT_ALLOWED', 'This plugin is required for every Account and cannot be switched off');
      }
      const current = await client.query(
        'SELECT version FROM plugin_account_choices WHERE plugin_name = $1 AND account_principal_id = $2 FOR UPDATE',
        [name, input.accountId]);
      checkRevision(input.expected, current.rows[0] ? Number(current.rows[0].version) : 0);
      const written = current.rows[0]
        ? await client.query(
          `UPDATE plugin_account_choices SET enabled = $3, version = version + 1, updated_at = now()
            WHERE plugin_name = $1 AND account_principal_id = $2 RETURNING version`, [name, input.accountId, input.enabled])
        : await client.query(
          `INSERT INTO plugin_account_choices (plugin_name, account_principal_id, enabled) VALUES ($1, $2, $3)
           ON CONFLICT ON CONSTRAINT plugin_account_choices_pkey DO NOTHING RETURNING version`,
          [name, input.accountId, input.enabled]);
      if (!written.rows[0]) checkRevision(input.expected, input.expected + 1);
      const revision = Number(written.rows[0].version);
      await auditService.record({
        action: PLUGIN_AUDIT_ACTIONS.choice, actor: input.actor, resourceType: PLUGIN_AUDIT_RESOURCE_TYPE, resourceId: name,
        metadata: { account: input.accountId, keys: ['enabled'], enabled: input.enabled, revision },
      }, client);
      return { name, state, enabled: availabilityResolvesOn(state, input.enabled as boolean), revision };
    });
  }

  /**
   * Replace the Account's own values. Locked keys keep their stored values,
   * unchanged; so do `deliver: backend` keys the request does not name (N13).
   */
  async putAccountValues(input: { plugin: LoadedPlugin; accountId: string; values: unknown; expected: number; actor: AuditActor }):
    Promise<{ name: string; revision: number; changedKeys: string[] }> {
    const name = input.plugin.name;
    const schema = pluginSettingsSchemaOf(input.plugin);
    return inTransaction(async (client) => {
      const deployment = await client.query(
        `SELECT locked_keys FROM plugin_settings WHERE plugin_name = $1 AND layer = 'deployment' FOR SHARE`, [name]);
      const locked: string[] = deployment.rows[0]?.locked_keys ?? [];
      const current = await client.query(
        `SELECT settings_values, version FROM plugin_settings
          WHERE plugin_name = $1 AND layer = 'account' AND account_principal_id = $2 FOR UPDATE`, [name, input.accountId]);
      checkRevision(input.expected, current.rows[0] ? Number(current.rows[0].version) : 0);
      const before: Record<string, unknown> = current.rows[0]?.settings_values ?? {};
      const values = validateSettingsValues(schema, input.values, 'account', locked);
      // A locked key ignores the user's value but keeps it, so unlocking
      // restores it: the replacement document carries it over unchanged.
      const kept = Object.fromEntries(Object.entries(before).filter(([key]) =>
        locked.includes(key) && schema.some(entry => entry.key === key && entry.scope === 'account_overridable')));
      // N13: the Account's own read never shows a `deliver: backend` value, so
      // a stored one the request does not name is carried over; a named key is
      // replaced, and a key named with null is removed (nothing is stored).
      const keptBackend = backendOnlyValuesKept(schema, before, new Set(Object.keys(values)));
      const sent = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
      const after = { ...sent, ...keptBackend, ...kept };
      const written = current.rows[0]
        ? await client.query(
          `UPDATE plugin_settings SET settings_values = $3::jsonb, version = version + 1, updated_at = now()
            WHERE plugin_name = $1 AND layer = 'account' AND account_principal_id = $2 RETURNING version`,
          [name, input.accountId, JSON.stringify(after)])
        : await client.query(
          `INSERT INTO plugin_settings (plugin_name, layer, account_principal_id, settings_values)
           VALUES ($1, 'account', $2, $3::jsonb)
           ON CONFLICT ON CONSTRAINT plugin_settings_one_row_per_owner DO NOTHING RETURNING version`,
          [name, input.accountId, JSON.stringify(after)]);
      if (!written.rows[0]) checkRevision(input.expected, input.expected + 1);
      const revision = Number(written.rows[0].version);
      const keys = changedKeys(before, after);
      await auditService.record({
        action: PLUGIN_AUDIT_ACTIONS.account, actor: input.actor, resourceType: PLUGIN_AUDIT_RESOURCE_TYPE, resourceId: name,
        metadata: { account: input.accountId, keys, revision },
      }, client);
      return { name, revision, changedKeys: keys };
    });
  }

  async policy(name: string, queryable: Queryable = pool): Promise<{ state: PluginAvailabilityState; revision: number }> {
    const result = await queryable.query('SELECT availability, version FROM plugin_policies WHERE plugin_name = $1', [name]);
    return result.rows[0]
      ? { state: asState(result.rows[0].availability), revision: Number(result.rows[0].version) }
      : { state: DEFAULT_PLUGIN_AVAILABILITY, revision: 0 };
  }

  /** Administrators: set the availability state, optionally clearing every Account's choice (N14). */
  async putPolicy(input: { plugin: LoadedPlugin; availability: unknown; clearChoices: unknown; expected: number;
    actor: AuditActor; principalId: string; stepUpToken: unknown }):
    Promise<{ name: string; state: PluginAvailabilityState; revision: number; clearedChoices: number }> {
    if (!PLUGIN_AVAILABILITY_STATES.includes(input.availability as PluginAvailabilityState)) {
      throw new PluginSettingsError(400, 'PLUGIN_POLICY_INVALID', 'availability must be required, default_on, available or disabled', 'availability');
    }
    if (input.clearChoices !== undefined && typeof input.clearChoices !== 'boolean') {
      throw new PluginSettingsError(400, 'PLUGIN_POLICY_INVALID', 'clearChoices must be true or false', 'clearChoices');
    }
    const state = input.availability as PluginAvailabilityState;
    const name = input.plugin.name;
    return inTransaction(async (client) => {
      const current = await client.query('SELECT availability, version FROM plugin_policies WHERE plugin_name = $1 FOR UPDATE', [name]);
      checkRevision(input.expected, current.rows[0] ? Number(current.rows[0].version) : 0);
      const previous = current.rows[0] ? asState(current.rows[0].availability) : DEFAULT_PLUGIN_AVAILABILITY;
      const stepUp = await burnStepUp(client, { stepUpToken: input.stepUpToken, principalId: input.principalId, plugin: name });
      const written = current.rows[0]
        ? await client.query(
          `UPDATE plugin_policies SET availability = $2, version = version + 1, updated_at = now()
            WHERE plugin_name = $1 RETURNING version`, [name, state])
        : await client.query(
          `INSERT INTO plugin_policies (plugin_name, availability) VALUES ($1, $2)
           ON CONFLICT (plugin_name) DO NOTHING RETURNING version`, [name, state]);
      if (!written.rows[0]) checkRevision(input.expected, input.expected + 1);
      const revision = Number(written.rows[0].version);
      const cleared = input.clearChoices === true
        ? (await client.query('DELETE FROM plugin_account_choices WHERE plugin_name = $1', [name])).rowCount ?? 0
        : 0;
      await auditService.record({
        action: PLUGIN_AUDIT_ACTIONS.policy, actor: input.actor, resourceType: PLUGIN_AUDIT_RESOURCE_TYPE, resourceId: name,
        metadata: {
          keys: ['availability'], previous, availability: state, revision,
          clearChoices: input.clearChoices === true, clearedChoices: cleared,
          stepUpTokenId: stepUp.tokenId, stepUpMethod: stepUp.method,
        },
      }, client);
      return { name, state, revision, clearedChoices: cleared };
    });
  }

  /** Administrators: replace the deployment values and the lock list. */
  async putDeployment(input: { plugin: LoadedPlugin; values: unknown; lockedKeys: unknown; expected: number;
    actor: AuditActor; principalId: string; stepUpToken: unknown }):
    Promise<{ name: string; revision: number; changedKeys: string[]; lockedKeys: string[] }> {
    const name = input.plugin.name;
    const schema = pluginSettingsSchemaOf(input.plugin);
    const values = validateSettingsValues(schema, input.values, 'deployment');
    const locked = validateLockedKeys(schema, input.lockedKeys);
    return inTransaction(async (client) => {
      const current = await client.query(
        `SELECT settings_values, locked_keys, version FROM plugin_settings
          WHERE plugin_name = $1 AND layer = 'deployment' FOR UPDATE`, [name]);
      checkRevision(input.expected, current.rows[0] ? Number(current.rows[0].version) : 0);
      const stepUp = await burnStepUp(client, { stepUpToken: input.stepUpToken, principalId: input.principalId, plugin: name });
      const before: Record<string, unknown> = current.rows[0]?.settings_values ?? {};
      const lockedBefore: string[] = current.rows[0]?.locked_keys ?? [];
      const written = current.rows[0]
        ? await client.query(
          `UPDATE plugin_settings SET settings_values = $2::jsonb, locked_keys = $3::text[], version = version + 1, updated_at = now()
            WHERE plugin_name = $1 AND layer = 'deployment' RETURNING version`, [name, JSON.stringify(values), locked])
        : await client.query(
          `INSERT INTO plugin_settings (plugin_name, layer, account_principal_id, settings_values, locked_keys)
           VALUES ($1, 'deployment', NULL, $2::jsonb, $3::text[])
           ON CONFLICT ON CONSTRAINT plugin_settings_one_row_per_owner DO NOTHING RETURNING version`,
          [name, JSON.stringify(values), locked]);
      if (!written.rows[0]) checkRevision(input.expected, input.expected + 1);
      const revision = Number(written.rows[0].version);
      const keys = changedKeys(before, values);
      await auditService.record({
        action: PLUGIN_AUDIT_ACTIONS.deployment, actor: input.actor, resourceType: PLUGIN_AUDIT_RESOURCE_TYPE, resourceId: name,
        metadata: {
          keys, locked: locked.filter(key => !lockedBefore.includes(key)), unlocked: lockedBefore.filter(key => !locked.includes(key)),
          revision, stepUpTokenId: stepUp.tokenId, stepUpMethod: stepUp.method,
        },
      }, client);
      return { name, revision, changedKeys: keys, lockedKeys: locked };
    });
  }

  /**
   * Administrators: the explicit clean-up (design section 5). Every stored
   * value the current schema no longer accepts is removed, from the
   * deployment row and from every Account's row, with stale locks. Nothing a
   * current schema still accepts is touched.
   */
  async cleanup(input: { plugin: LoadedPlugin; actor: AuditActor; principalId: string; stepUpToken: unknown }):
    Promise<{ name: string; rowsChanged: number; keysRemoved: string[] }> {
    const name = input.plugin.name;
    const schema = pluginSettingsSchemaOf(input.plugin);
    return inTransaction(async (client) => {
      const rows = await client.query(
        `SELECT layer, account_principal_id, settings_values, locked_keys FROM plugin_settings
          WHERE plugin_name = $1 ORDER BY layer, account_principal_id FOR UPDATE`, [name]);
      const stepUp = await burnStepUp(client, { stepUpToken: input.stepUpToken, principalId: input.principalId, plugin: name });
      const removed = new Set<string>();
      let changed = 0;
      for (const row of rows.rows) {
        const layer = row.layer === 'deployment' ? 'deployment' : 'account';
        const values: Record<string, unknown> = row.settings_values ?? {};
        const staleValues = staleSettingKeys(schema, layer, values);
        const staleLocks = layer === 'deployment' ? staleLockedKeys(schema, row.locked_keys ?? []) : [];
        if (staleValues.length === 0 && staleLocks.length === 0) continue;
        staleValues.forEach(key => removed.add(key));
        staleLocks.forEach(key => removed.add(key));
        const kept = Object.fromEntries(Object.entries(values).filter(([key]) => !staleValues.includes(key)));
        const locks = (row.locked_keys ?? []).filter((key: string) => !staleLocks.includes(key));
        await client.query(
          `UPDATE plugin_settings SET settings_values = $4::jsonb, locked_keys = $5::text[], version = version + 1, updated_at = now()
            WHERE plugin_name = $1 AND layer = $2 AND account_principal_id IS NOT DISTINCT FROM $3::uuid`,
          [name, row.layer, row.account_principal_id, JSON.stringify(kept), locks]);
        changed += 1;
      }
      const keysRemoved = [...removed].sort();
      await auditService.record({
        action: PLUGIN_AUDIT_ACTIONS.cleanup, actor: input.actor, resourceType: PLUGIN_AUDIT_RESOURCE_TYPE, resourceId: name,
        metadata: { keys: keysRemoved, rowsChanged: changed, stepUpTokenId: stepUp.tokenId, stepUpMethod: stepUp.method },
      }, client);
      return { name, rowsChanged: changed, keysRemoved };
    });
  }

  /** How many Account rows of a plugin hold values the current schema no longer accepts. */
  async staleAccountRows(plugin: LoadedPlugin, queryable: Queryable = pool): Promise<number> {
    const schema = pluginSettingsSchemaOf(plugin);
    const rows = await queryable.query(
      `SELECT settings_values FROM plugin_settings WHERE plugin_name = $1 AND layer = 'account'`, [plugin.name]);
    return rows.rows.filter(row => staleSettingKeys(schema, 'account', row.settings_values ?? {}).length > 0).length;
  }
}

export const pluginSettingsService = new PluginSettingsService();

/**
 * THE AVAILABILITY PREDICATE (design section 4): a v1 manifest, AND the policy
 * state, AND the Account's choice resolve to on. Each site ANDs it with its
 * existing check, never substitutes it for one. Legacy (non-v1) plugins are
 * outside policy (C10): the sites keep today's behaviour for them and never
 * call this for one. Whether there IS an active Account is the file
 * predicate's question (pluginAccountCan refuses a missing one), answered
 * once at each site; this predicate does not answer it a second time, so a
 * site can never come to rely on it for that.
 */
export async function pluginAvailableTo(plugin: LoadedPlugin | undefined, accountId: string | null): Promise<boolean> {
  if (!plugin?.manifest || !isPluginV1(plugin.manifest)) return false;
  return (await pluginSettingsService.availability(plugin.name, accountId)).enabled;
}
