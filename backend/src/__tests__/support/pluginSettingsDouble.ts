/**
 * Card bedf50cc: the stored-row double for the plugin suites that run with no
 * database. Every plugin site now ANDs the availability predicate into its
 * check; these suites measure the other half of each site, so the double
 * answers from an in-memory table (no row = `default_on`, as the real store
 * does) and leaves the predicate's own composition (pluginAvailableTo and
 * availabilityResolvesOn) the real code. The live suite pluginAvailabilityLive
 * measures the same sites over a real PostgreSQL.
 */
import {
  availabilityResolvesOn, pluginSettingsService, type PluginAvailabilityState,
} from '../../services/PluginSettingsService';

export const pluginAvailabilityTable: Record<string, { state: PluginAvailabilityState; choices?: Record<string, boolean> }> = {};

export function installPluginSettingsDouble(): void {
  jest.spyOn(pluginSettingsService, 'availabilityFor').mockImplementation(async (names: string[], accountId: string | null) =>
    new Map(names.map(name => {
      const entry = pluginAvailabilityTable[name];
      const state = entry?.state ?? 'default_on';
      const choice = accountId && entry?.choices && accountId in entry.choices ? entry.choices[accountId] : null;
      return [name, { state, choice, enabled: availabilityResolvesOn(state, choice), policyRevision: entry ? 1 : 0,
        choiceRevision: choice === null ? 0 : 1 }];
    })));
  jest.spyOn(pluginSettingsService, 'layers').mockImplementation(async () => ({ deployment: null, account: null }));
}
