/**
 * The lens contract's shape on the dashboard side (RH-LENSES-d, card
 * 4e159741; design 96f0bd3d s8.3). The answer is the server's
 * (`GET /principals/me/lenses`); this module only reads it.
 *
 * `member` and `admin` came with LENSES-d. `manager` came with LENSES-c c1-B
 * (card b5c83682; design delta C.8): the server sends it, with the Groups the
 * caller LIVE-stewards, only to a holder of a live owner or manager row, and
 * it is kept here only when the body carries both the lens and a readable
 * `manager.stewardedGroups`.
 */
export type Lens = 'member' | 'manager' | 'admin';

/** One Group the caller live-stewards, owners first, as the server ordered them. */
export interface StewardedGroup {
  id: string;
  name: string;
  memberCount: number;
  featured: boolean;
  role: 'owner' | 'manager';
}

export interface MyLenses {
  lenses: Lens[];
  admin: boolean;
  /** Present exactly when `manager` is in `lenses` (c1-B). */
  manager?: { stewardedGroups: StewardedGroup[] };
}

export const MEMBER_ONLY: MyLenses = Object.freeze({ lenses: ['member'] as Lens[], admin: false }) as MyLenses;

/** One stewarded-Group row, field by field, or null. */
function readStewardedGroup(value: unknown): StewardedGroup | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id.length === 0 || typeof row.name !== 'string') return null;
  if (typeof row.memberCount !== 'number' || !Number.isFinite(row.memberCount)) return null;
  if (row.role !== 'owner' && row.role !== 'manager') return null;
  return { id: row.id, name: row.name, memberCount: row.memberCount, featured: row.featured === true, role: row.role };
}

/**
 * Read the server's answer defensively: `admin` holds only when the body says
 * so in both fields, and `manager` only when the lens is listed AND every row
 * of `manager.stewardedGroups` reads (a lens with no readable rows is dropped).
 */
export function readLensesBody(body: unknown): MyLenses {
  if (!body || typeof body !== 'object') return MEMBER_ONLY;
  const record = body as Record<string, unknown>;
  const lenses = Array.isArray(record.lenses)
    ? (record.lenses.filter((lens) => lens === 'member' || lens === 'manager' || lens === 'admin') as Lens[])
    : [];
  const admin = record.admin === true && lenses.includes('admin');
  if (!lenses.includes('member')) return MEMBER_ONLY;
  const manager = record.manager && typeof record.manager === 'object'
    ? (record.manager as Record<string, unknown>).stewardedGroups
    : undefined;
  const rows = Array.isArray(manager) ? manager.map(readStewardedGroup) : [];
  const stewardedGroups = rows.every((row): row is StewardedGroup => row !== null) ? rows : [];
  const managerLens = lenses.includes('manager') && stewardedGroups.length > 0;
  const kept = lenses.filter((lens) => (lens === 'admin' ? admin : lens === 'manager' ? managerLens : true));
  return managerLens ? { lenses: kept, admin, manager: { stewardedGroups } } : { lenses: kept, admin };
}
