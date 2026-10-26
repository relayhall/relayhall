/**
 * RH-LENSES-d (card 4e159741): THE LENS CONTRACT.
 *
 * Design record v7.1 `96f0bd3d` §8 with ANNEX `d6637a92` §A7.5 and §A8.3.
 *
 * ── WHAT A LENS IS (invariant I-L2) ─────────────────────────────────────
 *
 * A lens is a DERIVED NAVIGATIONAL FACT about a caller's own standing. It
 * decides which sections the dashboard OFFERS, and nothing else. It confers
 * no authority, it is never stored, never cached, never embedded in a token,
 * and it is never an input to any authorization predicate: every route a lens
 * leads to enforces exactly the ceiling it enforced before the lens existed.
 * It is recomputed on every request from two facts the request already
 * carries. Control R-8-v1 (`__tests__/lensesContractLive.test.ts`) keeps that
 * falsifiable: it records every outcome and every body of the route families
 * the lens touches, removes the lens surface, records again, and requires the
 * two to be identical.
 *
 * ── THE DERIVATION, v1 (two arms) ───────────────────────────────────────
 *
 *   member  always, for an authenticated principal.
 *   admin   a ROOT LOGIN SESSION: the route stage would admit `root` for this
 *           request AND the request arrived on a person's login session.
 *
 * The login-session half is `isLoginSessionKind` from `./administratorSession`,
 * CALLED and never re-implemented: that module is the tree's only copy of
 * "this request is a person's login session, not a bearer credential", and
 * `__tests__/administratorSessionSeam.test.ts` registers this file as an
 * importer of it (control R-14). It is what keeps a bearer credential that
 * HOLDS `root` out of the admin lens (AZ-18: a bearer never reaches the owner
 * plane), and what lets the break-glass dashboard token in (acceptance A-L30,
 * both directions).
 *
 * The root half is the caller's question to `authorizeRoute(actor, 'root')`,
 * the SAME decision the route stage takes for every root-ceilinged route the
 * admin sections lead to. It is passed in, not re-derived here, and it never
 * reads `principals.role`: the role-to-scope mapping already lives in one
 * place, and a second reading of it would drift.
 *
 * ── THE MANAGER ARM (LENSES-c build c1-B, card b5c83682) ──────────────────
 *
 *   manager the caller holds at least one LIVE Group role row, owner or
 *           manager (design delta C.8; "an owner is a manager for the lens").
 *
 * The route reads the rows (the shared live-steward fragment, per request)
 * and hands them in; this derivation only decides the arm from them. With at
 * least one row the payload carries `manager` in `lenses` (between `member`
 * and `admin`) and `manager.stewardedGroups`, the rows as given, owners first.
 * With none it carries NO `manager` key at all (acceptance A-L53): an empty
 * `manager.stewardedGroups` array would assert a projection nobody holds. The
 * arm is an OPTIONAL member of the v1 type, so it changed no field the v1
 * payload returns (obligation B-L21). It reads no session kind and no role: an
 * administrator who stewards no Group gets no arm (A-L51's admin negative).
 */
import { isLoginSessionKind } from './administratorSession';

/** The lens names. `manager` is the additive c1-B arm. */
export type Lens = 'member' | 'manager' | 'admin';

/** One Group the caller LIVE-stewards, as the c1-B manager arm carries it. */
export interface StewardedGroupLensRow {
  id: string;
  name: string;
  memberCount: number;
  featured: boolean;
  role: 'owner' | 'manager';
}

/**
 * The `GET /principals/me/lenses` payload. `manager` is OPTIONAL: present
 * exactly when the caller holds a live Group role (c1-B), absent otherwise.
 */
export interface LensesPayload {
  lenses: Lens[];
  admin: boolean;
  manager?: { stewardedGroups: StewardedGroupLensRow[] };
}

/** The request facts the derivation reads, and nothing else. */
export interface LensRequestFacts {
  /** `req.authMethod`: server-derived, never a header. */
  authMethod: string | undefined;
  /** The route stage's own answer to "would this request pass a `root` ceiling?". */
  rootAuthorized: boolean;
  /** The caller's LIVE Group role rows, owners first, as the route read them (c1-B). */
  stewardedGroups?: StewardedGroupLensRow[];
}

/** Derive the caller's lenses. Pure: the same facts always give the same answer. */
export function lensesFor(input: LensRequestFacts): LensesPayload {
  const admin = input.rootAuthorized && isLoginSessionKind(input.authMethod);
  const lenses: Lens[] = ['member'];
  const stewardedGroups = input.stewardedGroups ?? [];
  if (stewardedGroups.length > 0) {
    lenses.push('manager');
  }
  if (admin) lenses.push('admin');
  if (stewardedGroups.length > 0) return { lenses, admin, manager: { stewardedGroups } };
  return { lenses, admin };
}
