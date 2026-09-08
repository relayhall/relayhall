/**
 * Deployment Appearance: singleton configuration, append-only versions and
 * the bounded asset store (RH-DESIGN.6 §5.1/§7).
 */
import { createHash } from 'crypto';
import { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { canonicalAccent, BuiltInTheme, BUILT_IN_THEMES } from './pluginTheme';
import { AssetRejected, inspectAsset } from '../utils/imageSafety';

export type AssetKind = 'logo' | 'favicon' | 'mark';
export const ASSET_KINDS: AssetKind[] = ['logo', 'favicon', 'mark'];
export const APPEARANCE_LINK_KINDS = ['support', 'contact', 'privacy', 'status', 'custom'] as const;
export type AppearanceLinkKind = typeof APPEARANCE_LINK_KINDS[number];

export function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as string[]).includes(value);
}

export interface AppearanceLink {
  kind: AppearanceLinkKind;
  label: string;
  url: string;
}

export interface AppearanceOverrides {
  displayName: string | null;
  loginTitle: string | null;
  loginSubtitle: string | null;
  defaultTheme: BuiltInTheme | null;
  accentColor: string | null;
  description: string | null;
  links: AppearanceLink[];
  teamMarkdown: string | null;
}

export interface EffectiveAppearance {
  displayName: string;
  loginTitle: string;
  loginSubtitle: string;
  defaultTheme: BuiltInTheme;
  accentColor: string;
  description: string;
  links: AppearanceLink[];
  teamMarkdown: string;
}

export const BUILT_IN_APPEARANCE: EffectiveAppearance = Object.freeze({
  displayName: 'RelayHall',
  loginTitle: 'Welcome to RelayHall',
  loginSubtitle: 'Your governed work hub',
  defaultTheme: 'relay-dark',
  accentColor: '#14b8a6',
  description: '',
  links: [],
  teamMarkdown: '',
});

export interface StoredAsset {
  id: string;
  kind: AssetKind;
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  active: boolean;
  uploadedBy: string | null;
  createdAt: string;
}

export interface AppearanceAssetReference {
  id: string;
  kind: AssetKind;
  mime: string;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  url: string;
}

export interface AppearanceView {
  overrides: AppearanceOverrides;
  effective: EffectiveAppearance;
  assets: Partial<Record<AssetKind, AppearanceAssetReference>>;
  updatedAt: string | null;
}

export interface AppearanceVersion {
  id: string;
  versionNo: number;
  snapshot: AppearanceOverrides;
  assetRefs: Partial<Record<AssetKind, string>>;
  reason: 'save' | 'revert' | 'reset';
  createdAt: string;
  createdBy: string | null;
}

export class AppearanceValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AppearanceValidationError';
  }
}

const EMPTY_OVERRIDES: AppearanceOverrides = {
  displayName: null,
  loginTitle: null,
  loginSubtitle: null,
  defaultTheme: null,
  accentColor: null,
  description: null,
  links: [],
  teamMarkdown: null,
};

const STRING_LIMITS: Record<Exclude<keyof AppearanceOverrides, 'defaultTheme' | 'accentColor' | 'links'>, number> = {
  displayName: 100,
  loginTitle: 120,
  loginSubtitle: 240,
  description: 1000,
  teamMarkdown: 20000,
};

const SURFACES = [
  { name: 'dark surface', value: '#161a20' },
  { name: 'light surface', value: '#f7f9fb' },
];

/** 68b1e12f: per-theme --text-on-fill inks (styles/variables.css). A legal
 *  3:1 UI accent can still carry 4.5:1-failing label ink on text-bearing
 *  accent fills (buttons), so an explicit accent must clear the AA body tier
 *  against the ink of every Theme it can appear in. High-contrast is exempt
 *  by design: the override never applies there (theme.ts scoping). */
const ON_FILL_INKS = [
  { name: 'relay-dark on-fill ink (slate-900)', value: '#0f1216' },
  { name: 'relay-light on-fill ink (white)', value: '#ffffff' },
];

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function nullableText(value: unknown, field: keyof typeof STRING_LIMITS): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new AppearanceValidationError('INVALID_FIELD', `${field} must be a string or null`);
  }
  const canonical = value.trim();
  if (!canonical) return null;
  if (/\u0000/.test(canonical)) {
    throw new AppearanceValidationError('INVALID_FIELD', `${field} contains a forbidden null character`);
  }
  if (canonical.length > STRING_LIMITS[field]) {
    throw new AppearanceValidationError('FIELD_TOO_LONG', `${field} must be ${STRING_LIMITS[field]} characters or fewer`);
  }
  return canonical;
}

function parseLinks(value: unknown): AppearanceLink[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new AppearanceValidationError('INVALID_LINKS', 'links must be an array of at most 20 links');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AppearanceValidationError('INVALID_LINK', `links[${index}] must contain label and url`);
    }
    const raw = item as Record<string, unknown>;
    // Rows written before RH-UI.5 had no kind. Their durable meaning is a
    // custom deployment link; new writes must remain inside the closed enum.
    const kind = raw.kind === undefined ? 'custom' : raw.kind;
    if (typeof kind !== 'string' || !(APPEARANCE_LINK_KINDS as readonly string[]).includes(kind)) {
      throw new AppearanceValidationError(
        'INVALID_LINK',
        `links[${index}].kind must be one of: ${APPEARANCE_LINK_KINDS.join(', ')}`
      );
    }
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!label || label.length > 80) {
      throw new AppearanceValidationError('INVALID_LINK', `links[${index}].label must be 1-80 characters`);
    }
    if (!url || url.length > 2048) {
      throw new AppearanceValidationError('INVALID_LINK', `links[${index}].url must be 1-2048 characters`);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppearanceValidationError('INVALID_LINK', `links[${index}].url must be an absolute http(s) URL`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new AppearanceValidationError('INVALID_LINK', `links[${index}].url must be an absolute http(s) URL`);
    }
    return { kind: kind as AppearanceLinkKind, label, url: parsed.toString() };
  });
}

/** Closed parser used by every write surface (REST, CLI and import). */
export function parseAppearanceOverrides(value: unknown): AppearanceOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppearanceValidationError('INVALID_APPEARANCE', 'appearance must be an object');
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    'displayName', 'loginTitle', 'loginSubtitle', 'defaultTheme', 'accentColor',
    'description', 'links', 'teamMarkdown',
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new AppearanceValidationError('UNKNOWN_FIELD', `Unknown appearance field(s): ${unknown.join(', ')}`);
  }

  let defaultTheme: BuiltInTheme | null = null;
  if (input.defaultTheme !== undefined && input.defaultTheme !== null && input.defaultTheme !== '') {
    if (typeof input.defaultTheme !== 'string' ||
        !(BUILT_IN_THEMES as readonly string[]).includes(input.defaultTheme)) {
      throw new AppearanceValidationError(
        'INVALID_THEME',
        `defaultTheme must be null or one of: ${BUILT_IN_THEMES.join(', ')}`
      );
    }
    defaultTheme = input.defaultTheme as BuiltInTheme;
  }

  let accentColor: string | null = null;
  if (input.accentColor !== undefined && input.accentColor !== null && input.accentColor !== '') {
    if (typeof input.accentColor !== 'string') {
      throw new AppearanceValidationError('INVALID_ACCENT', 'accentColor must be a hex colour or null');
    }
    accentColor = canonicalAccent(input.accentColor);
    if (!accentColor) {
      throw new AppearanceValidationError('INVALID_ACCENT', 'accentColor must be #rgb or #rrggbb');
    }
    for (const surface of SURFACES) {
      const ratio = contrastRatio(accentColor, surface.value);
      if (ratio < 3) {
        throw new AppearanceValidationError(
          'ACCENT_CONTRAST',
          `accentColor ${accentColor} has ${ratio.toFixed(2)}:1 contrast on the ${surface.name}; 3.00:1 is required`
        );
      }
    }
    // 68b1e12f floor: at least ONE theme ink must clear 4.5:1 on the accent
    // fill — the client picks the passing ink per theme; an accent that fails
    // BOTH inks has no legal text-bearing fill anywhere and is rejected.
    const inkRatios = ON_FILL_INKS.map((ink) => ({ ink, ratio: contrastRatio(accentColor as string, ink.value) }));
    if (!inkRatios.some(({ ratio }) => ratio >= 4.5)) {
      throw new AppearanceValidationError(
        'ACCENT_TEXT_CONTRAST',
        `accentColor ${accentColor} carries no 4.50:1 label ink on text-bearing fills (${inkRatios.map(({ ink, ratio }) => `${ratio.toFixed(2)}:1 vs ${ink.name}`).join('; ')})`
      );
    }
  }

  return {
    displayName: nullableText(input.displayName, 'displayName'),
    loginTitle: nullableText(input.loginTitle, 'loginTitle'),
    loginSubtitle: nullableText(input.loginSubtitle, 'loginSubtitle'),
    defaultTheme,
    accentColor,
    description: nullableText(input.description, 'description'),
    links: parseLinks(input.links),
    teamMarkdown: nullableText(input.teamMarkdown, 'teamMarkdown'),
  };
}

function rowToOverrides(row?: any): AppearanceOverrides {
  if (!row) return { ...EMPTY_OVERRIDES, links: [] };
  return {
    displayName: row.display_name ?? null,
    loginTitle: row.login_title ?? null,
    loginSubtitle: row.login_subtitle ?? null,
    defaultTheme: row.default_theme ?? null,
    accentColor: row.accent_color ?? null,
    description: row.description ?? null,
    links: parseLinks(row.links),
    teamMarkdown: row.team_markdown ?? null,
  };
}

function effectiveAppearance(overrides: AppearanceOverrides): EffectiveAppearance {
  return {
    displayName: overrides.displayName ?? BUILT_IN_APPEARANCE.displayName,
    loginTitle: overrides.loginTitle ?? BUILT_IN_APPEARANCE.loginTitle,
    loginSubtitle: overrides.loginSubtitle ?? BUILT_IN_APPEARANCE.loginSubtitle,
    defaultTheme: overrides.defaultTheme ?? BUILT_IN_APPEARANCE.defaultTheme,
    accentColor: overrides.accentColor ?? BUILT_IN_APPEARANCE.accentColor,
    description: overrides.description ?? BUILT_IN_APPEARANCE.description,
    links: overrides.links,
    teamMarkdown: overrides.teamMarkdown ?? BUILT_IN_APPEARANCE.teamMarkdown,
  };
}

function rowToAsset(row: any): StoredAsset {
  return {
    id: row.id,
    kind: row.kind,
    bytes: row.bytes,
    mime: row.mime,
    width: row.width,
    height: row.height,
    byteSize: row.byte_size,
    sha256: row.sha256,
    active: row.active,
    uploadedBy: row.uploaded_by ?? null,
    createdAt: row.created_at,
  };
}

function assetReference(asset: StoredAsset): AppearanceAssetReference {
  return {
    id: asset.id,
    kind: asset.kind,
    mime: asset.mime,
    width: asset.width,
    height: asset.height,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
    url: `/api/appearance/assets/${asset.kind}/${asset.sha256}`,
  };
}

function rowToVersion(row: any): AppearanceVersion {
  return {
    id: row.id,
    versionNo: row.version_no,
    snapshot: row.snapshot as AppearanceOverrides,
    assetRefs: row.asset_refs ?? {},
    reason: row.reason,
    createdAt: row.created_at,
    createdBy: row.created_by ?? null,
  };
}

export class AppearanceService {
  private pool = pool;

  async get(): Promise<AppearanceView> {
    const [appearanceResult, assetResult] = await Promise.all([
      this.pool.query('SELECT * FROM appearances WHERE singleton = TRUE LIMIT 1'),
      this.pool.query('SELECT * FROM appearance_assets WHERE active ORDER BY kind'),
    ]);
    const row = appearanceResult.rows[0];
    const overrides = rowToOverrides(row);
    const assets: Partial<Record<AssetKind, AppearanceAssetReference>> = {};
    for (const assetRow of assetResult.rows) {
      const asset = rowToAsset(assetRow);
      assets[asset.kind] = assetReference(asset);
    }
    return { overrides, effective: effectiveAppearance(overrides), assets, updatedAt: row?.updated_at ?? null };
  }

  /** One-time compatibility import. A pre-existing Appearance row always wins. */
  async importLegacyDisplayName(displayName: string | null): Promise<boolean> {
    if (!displayName) return false;
    const overrides = parseAppearanceOverrides({ displayName });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client);
      const existing = await client.query('SELECT id FROM appearances WHERE singleton = TRUE LIMIT 1');
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return false;
      }
      await this.storeOverrides(client, overrides, null);
      const version = await this.appendVersion(client, 'save', overrides, {}, null);
      await client.query('COMMIT');
      return Boolean(version.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async save(input: unknown, updatedBy: string | null): Promise<{ appearance: AppearanceView; version: AppearanceVersion }> {
    const overrides = parseAppearanceOverrides(input);
    return this.writeVersion('save', overrides, updatedBy);
  }

  async reset(updatedBy: string | null): Promise<{ appearance: AppearanceView; version: AppearanceVersion }> {
    return this.writeVersion('reset', { ...EMPTY_OVERRIDES, links: [] }, updatedBy, {});
  }

  async revert(versionNo: number, updatedBy: string | null): Promise<{ appearance: AppearanceView; version: AppearanceVersion }> {
    if (!Number.isSafeInteger(versionNo) || versionNo < 1) {
      throw new AppearanceValidationError('INVALID_VERSION', 'version number must be a positive integer');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client);
      const found = await client.query(
        'SELECT * FROM appearance_versions WHERE version_no = $1 LIMIT 1',
        [versionNo]
      );
      if (!found.rows[0]) {
        throw new AppearanceValidationError('VERSION_NOT_FOUND', `Appearance version ${versionNo} was not found`);
      }
      const source = rowToVersion(found.rows[0]);
      const overrides = parseAppearanceOverrides(source.snapshot);
      await this.storeOverrides(client, overrides, updatedBy);
      await this.restoreAssetRefs(client, source.assetRefs);
      const appended = await this.appendVersion(client, 'revert', overrides, source.assetRefs, updatedBy);
      await client.query('COMMIT');
      return { appearance: await this.get(), version: appended };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listVersions(limit = 100): Promise<AppearanceVersion[]> {
    const bounded = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 100, 500));
    const result = await this.pool.query(
      'SELECT * FROM appearance_versions ORDER BY version_no DESC LIMIT $1',
      [bounded]
    );
    return result.rows.map(rowToVersion);
  }

  private async writeVersion(
    reason: 'save' | 'reset',
    overrides: AppearanceOverrides,
    updatedBy: string | null,
    forcedAssetRefs?: Partial<Record<AssetKind, string>>
  ): Promise<{ appearance: AppearanceView; version: AppearanceVersion }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client);
      await this.storeOverrides(client, overrides, updatedBy);
      if (forcedAssetRefs) await this.restoreAssetRefs(client, forcedAssetRefs);
      const refs = forcedAssetRefs ?? await this.captureAssetRefs(client);
      const version = await this.appendVersion(client, reason, overrides, refs, updatedBy);
      await client.query('COMMIT');
      return { appearance: await this.get(), version };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lock(client: PoolClient): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('relayhall:appearance'))");
  }

  private async storeOverrides(
    client: PoolClient,
    overrides: AppearanceOverrides,
    updatedBy: string | null
  ): Promise<void> {
    await client.query(
      `INSERT INTO appearances
         (singleton, display_name, login_title, login_subtitle, default_theme,
          accent_color, description, links, team_markdown, updated_by)
       VALUES (TRUE, $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       ON CONFLICT (singleton) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         login_title = EXCLUDED.login_title,
         login_subtitle = EXCLUDED.login_subtitle,
         default_theme = EXCLUDED.default_theme,
         accent_color = EXCLUDED.accent_color,
         description = EXCLUDED.description,
         links = EXCLUDED.links,
         team_markdown = EXCLUDED.team_markdown,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [
        overrides.displayName, overrides.loginTitle, overrides.loginSubtitle,
        overrides.defaultTheme, overrides.accentColor, overrides.description,
        JSON.stringify(overrides.links), overrides.teamMarkdown, updatedBy,
      ]
    );
  }

  private async captureAssetRefs(client: PoolClient): Promise<Partial<Record<AssetKind, string>>> {
    const result = await client.query('SELECT id, kind FROM appearance_assets WHERE active ORDER BY kind');
    const refs: Partial<Record<AssetKind, string>> = {};
    for (const row of result.rows) refs[row.kind as AssetKind] = row.id;
    return refs;
  }

  private async restoreAssetRefs(
    client: PoolClient,
    refs: Partial<Record<AssetKind, string>>
  ): Promise<void> {
    const entries = Object.entries(refs).filter((entry): entry is [AssetKind, string] =>
      isAssetKind(entry[0]) && typeof entry[1] === 'string'
    );
    if (entries.length !== Object.keys(refs).length) {
      throw new AppearanceValidationError('INVALID_VERSION', 'Appearance version has invalid asset references');
    }
    await client.query('UPDATE appearance_assets SET active = FALSE WHERE active');
    for (const [kind, id] of entries) {
      const restored = await client.query(
        'UPDATE appearance_assets SET active = TRUE WHERE id = $1 AND kind = $2 RETURNING id',
        [id, kind]
      );
      if (!restored.rows[0]) {
        throw new AppearanceValidationError('VERSION_ASSET_MISSING', `Appearance version references a missing ${kind} asset`);
      }
    }
  }

  private async appendVersion(
    client: PoolClient,
    reason: 'save' | 'revert' | 'reset',
    snapshot: AppearanceOverrides,
    refs: Partial<Record<AssetKind, string>>,
    createdBy: string | null
  ): Promise<AppearanceVersion> {
    const inserted = await client.query(
      `INSERT INTO appearance_versions (version_no, snapshot, asset_refs, reason, created_by)
       VALUES ((SELECT COALESCE(MAX(version_no), 0) + 1 FROM appearance_versions),
               $1::jsonb, $2::jsonb, $3, $4)
       RETURNING *`,
      [JSON.stringify(snapshot), JSON.stringify(refs), reason, createdBy]
    );
    return rowToVersion(inserted.rows[0]);
  }

  async putAsset(kind: AssetKind, uploaded: Buffer, uploadedBy: string | null): Promise<StoredAsset> {
    const inspected = inspectAsset(uploaded, { kind });
    const sha256 = createHash('sha256').update(inspected.bytes).digest('hex');
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('relayhall:appearance'))");
      await client.query('UPDATE appearance_assets SET active = FALSE WHERE kind = $1 AND active', [kind]);
      const inserted = await client.query(
        `INSERT INTO appearance_assets
           (kind, bytes, mime, width, height, byte_size, sha256, active, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)
         RETURNING *`,
        [kind, inspected.bytes, inspected.mime, inspected.width, inspected.height,
          inspected.bytes.length, sha256, uploadedBy]
      );
      const overridesResult = await client.query('SELECT * FROM appearances WHERE singleton = TRUE LIMIT 1');
      const snapshot = rowToOverrides(overridesResult.rows[0]);
      const refs = await this.captureAssetRefs(client);
      await this.appendVersion(client, 'save', snapshot, refs, uploadedBy);
      await client.query('COMMIT');
      return rowToAsset(inserted.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getActiveAsset(kind: AssetKind): Promise<StoredAsset | null> {
    const result = await this.pool.query(
      'SELECT * FROM appearance_assets WHERE kind = $1 AND active LIMIT 1',
      [kind]
    );
    return result.rows.length ? rowToAsset(result.rows[0]) : null;
  }

  async getAssetByIdForRoot(id: string): Promise<StoredAsset | null> {
    const result = await this.pool.query('SELECT * FROM appearance_assets WHERE id = $1', [id]);
    return result.rows.length ? rowToAsset(result.rows[0]) : null;
  }

  async listAssetHistoryForRoot(kind: AssetKind): Promise<StoredAsset[]> {
    const result = await this.pool.query(
      'SELECT * FROM appearance_assets WHERE kind = $1 ORDER BY created_at DESC',
      [kind]
    );
    return result.rows.map(rowToAsset);
  }
}

export const appearanceService = new AppearanceService();
export { AssetRejected };
