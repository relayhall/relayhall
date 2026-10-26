/**
 * PER-LENS NAVIGATION, as data (RH-LENSES-d, card 4e159741; design 96f0bd3d
 * s8.4). The sidebar's sections are offered by the caller's lenses, and an
 * entry that IS a Settings page is offered only when the Settings shell would
 * show it as well: a lens is necessary, never sufficient.
 */
import { describe, expect, test } from 'vitest';
import {
  MEMBER_AUDIENCE,
  getHeroNavItems,
  getSidebarGroups,
  navItemOffered,
  navigationItems,
  type NavAudience,
} from './navigation';
import { readLensesBody, MEMBER_ONLY } from '../types/lenses';
import { settingsNavEntries } from './settingsNavigation';

const ADMIN_LENSES = { lenses: ['member', 'admin'], admin: true } as const;
const everySurfaceVisible = settingsNavEntries
  .filter((entry) => entry.surfaceKey !== null)
  .map((entry) => ({ key: entry.surfaceKey as string, visible: true }));

const admin = (surfaces = everySurfaceVisible): NavAudience => ({
  lenses: { lenses: [...ADMIN_LENSES.lenses], admin: true },
  settings: { surfaces, canManage: true },
});

const groupIds = (audience?: NavAudience) => getSidebarGroups(audience).map(({ group }) => group.id);
const itemIds = (audience?: NavAudience) => getSidebarGroups(audience).flatMap(({ items }) => items.map((item) => item.id));

describe('the admin lens offers the Administration sections', () => {
  test('a member is offered no Administration group at all - absent, not empty', () => {
    expect(groupIds(MEMBER_AUDIENCE)).not.toContain('administration');
    expect(groupIds()).not.toContain('administration');
  });

  test('the admin lens is offered Directory, Groups, People, Access and Advanced, in that order', () => {
    const section = getSidebarGroups(admin()).find(({ group }) => group.id === 'administration');
    expect(section?.items.map((item) => item.label)).toEqual(['Directory', 'Groups', 'People', 'Access', 'Advanced']);
  });

  test('every member section is offered to both lenses, unchanged', () => {
    const memberItems = itemIds(MEMBER_AUDIENCE);
    expect(memberItems.length).toBeGreaterThan(5);
    for (const id of memberItems) expect(itemIds(admin())).toContain(id);
  });

  test('the union is shown: the admin lens ADDS sections and removes none', () => {
    const adminOnly = itemIds(admin()).filter((id) => !itemIds(MEMBER_AUDIENCE).includes(id));
    expect(adminOnly.sort()).toEqual(['admin-access', 'admin-advanced', 'admin-directory', 'admin-groups', 'admin-people']);
  });
});

describe('a lens is necessary, never sufficient', () => {
  test('a Settings page the Access-surface arm conceals is not offered, even to the admin lens', () => {
    const concealIdentities = everySurfaceVisible.map((surface) =>
      surface.key === 'settings.identities' ? { ...surface, visible: false } : surface);
    const offered = itemIds(admin(concealIdentities));
    expect(offered).not.toContain('admin-people');
    expect(offered).toContain('admin-access');
    expect(offered).toContain('admin-directory');
  });

  test('Settings visibility alone never offers an admin section to a member', () => {
    const memberWithEverySurface: NavAudience = {
      lenses: MEMBER_ONLY,
      settings: { surfaces: everySurfaceVisible, canManage: true },
    };
    for (const item of navigationItems.filter((candidate) => candidate.lens === 'admin')) {
      expect({ id: item.id, offered: navItemOffered(item, memberWithEverySurface) }).toEqual({ id: item.id, offered: false });
    }
  });

  test('every admin entry that is a Settings page names a real Settings entry', () => {
    for (const item of navigationItems.filter((candidate) => candidate.settingsEntry)) {
      const entry = settingsNavEntries.find((candidate) => candidate.id === item.settingsEntry);
      expect({ id: item.id, path: entry?.path }).toEqual({ id: item.id, path: item.path });
    }
  });

  test('the dashboard hero never offers an admin section', () => {
    expect(getHeroNavItems().some((item) => item.lens === 'admin')).toBe(false);
  });
});

describe('the manager lens offers My team (LENSES-c c1-B, card b5c83682)', () => {
  const MANAGED = { id: 'g-1', name: 'Platform', memberCount: 4, featured: true, role: 'owner' as const };
  const manager = (admin = false): NavAudience => ({
    lenses: { lenses: admin ? ['member', 'manager', 'admin'] : ['member', 'manager'], admin, manager: { stewardedGroups: [MANAGED] } },
    settings: { surfaces: everySurfaceVisible, canManage: admin },
  });

  test('a holder of a live Group role is offered My team in the main group; a member and an admin without one are not', () => {
    expect(itemIds(manager())).toContain('team');
    expect(itemIds(manager(true))).toContain('team');
    expect(itemIds(MEMBER_AUDIENCE)).not.toContain('team');
    expect(itemIds(admin())).not.toContain('team');
    const main = getSidebarGroups(manager()).find(({ group }) => group.id === 'main');
    expect(main?.items.map((item) => item.id)).toContain('team');
  });

  test('the manager lens adds My team and nothing else, and never an Administration section', () => {
    const added = itemIds(manager()).filter((id) => !itemIds(MEMBER_AUDIENCE).includes(id));
    expect(added).toEqual(['team']);
    expect(groupIds(manager())).not.toContain('administration');
  });

  test('the manager arm is kept only with the lens AND readable rows', () => {
    const body = { lenses: ['member', 'manager'], admin: false, manager: { stewardedGroups: [MANAGED] } };
    expect(readLensesBody(body)).toStrictEqual(body);
    expect(readLensesBody({ ...body, lenses: ['member'] })).toStrictEqual(MEMBER_ONLY);
    expect(readLensesBody({ lenses: ['member', 'manager'], admin: false })).toStrictEqual(MEMBER_ONLY);
    expect(readLensesBody({ ...body, manager: { stewardedGroups: [{ id: 'g-1' }] } })).toStrictEqual(MEMBER_ONLY);
    expect(readLensesBody({ ...body, manager: { stewardedGroups: [] } })).toStrictEqual(MEMBER_ONLY);
  });

  test('the dashboard hero never offers My team', () => {
    expect(getHeroNavItems().some((item) => item.lens === 'manager')).toBe(false);
  });
});

describe('the lens answer is the server\'s, read defensively', () => {
  test('admin holds only when the body says so in both fields', () => {
    expect(readLensesBody({ lenses: ['member', 'admin'], admin: true }).admin).toBe(true);
    expect(readLensesBody({ lenses: ['member'], admin: true }).admin).toBe(false);
    expect(readLensesBody({ lenses: ['member', 'admin'], admin: false }).admin).toBe(false);
    expect(readLensesBody({ lenses: ['member', 'admin'], admin: 'true' }).admin).toBe(false);
  });

  test('anything unreadable is the member lens', () => {
    for (const body of [null, undefined, 'admin', 7, [], {}, { lenses: 'admin', admin: true }, { lenses: [], admin: true }]) {
      expect(readLensesBody(body)).toStrictEqual(MEMBER_ONLY);
    }
  });

  test('nothing is derived from scopes or roles: a body that carries them changes nothing', () => {
    expect(readLensesBody({ lenses: ['member'], admin: false, scopes: ['root'], role: 'admin' }).admin).toBe(false);
  });
});
