/**
 * connectorRegistry — the ONE predicate for "is this principal a Connector?"
 *
 * A Connector is NOT a principal kind. `principals.kind` is constrained to
 * human | agent | service; per A17.2 a Connector is BOTH the services-registry
 * object and a delegated identity — a `services` row with `kind = 'connector'`
 * whose REQUIRED `principal_id` names the acting principal (migration 097,
 * `services_connector_principal_required`). Connector-ness is therefore a
 * question for the REGISTRY, never for the kind column or the chain shape.
 *
 * Owner ruling `4ae7ce53` (RH-P5.SSO.W4 candidate A, round 4) made this the
 * ratified predicate for the SCIM client and required it to be REUSED rather
 * than re-derived: three review rounds each added a principal-column condition
 * to an approximation of this question, and the class of defect never changed.
 * `SubscriberActorService` had the predicate first (ruling ccd53781 R3); this
 * module is that predicate lifted out so every user issues the SAME SQL, and a
 * drift between two copies is impossible rather than merely tested for.
 *
 * Users, all of which compose from `connectorRegistryPredicateSql`:
 *   - `SubscriberActorService` — subscribers and work-plane assignees — and
 *     the write-time twin of that check in `routes/webhooks` (found carrying
 *     its own identical copy by the census in `scimOwnerBindingCrossLayer`,
 *     the round this module was written);
 *   - the SCIM actor rule (`ScimProvisioningService.resolveProviderForClient`)
 *     — the acting principal is a Connector BY THE REGISTRY;
 *   - `IdentityProviderService.setScimClient` — the bound Account must be
 *     paired with a registry Connector, so the act-time predicate cannot
 *     depend on registry state the binding never checked.
 */

/**
 * The SQL predicate, as a fragment: TRUE when a connector-kind registry row
 * names `principalRef` as its principal. `principalRef` is a column reference
 * or a bound parameter placeholder, never user text.
 */
export function connectorRegistryPredicateSql(principalRef: string): string {
  return `EXISTS (SELECT 1 FROM services sv WHERE sv.principal_id = ${principalRef} AND sv.kind = 'connector')`;
}

/** The slice of a `pg` pool or client these lookups need. */
export interface RegistryQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Is this principal a Connector by the registry? One lookup, on the same seam
 * `SubscriberActorService` already pays it on. Anything but a literal TRUE
 * from the database is a NO.
 */
export async function isRegistryConnector(db: RegistryQueryable, principalId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT ${connectorRegistryPredicateSql('$1')} AS is_connector`,
    [principalId],
  );
  return result.rows[0]?.is_connector === true;
}

/**
 * The registry Connectors PAIRED with an Account: parented under it AND named
 * by a connector-kind registry row. The binding surface requires at least one;
 * the act-time rule then asks `isRegistryConnector` of the acting principal —
 * two questions, one fragment.
 */
export async function registryConnectorsOf(db: RegistryQueryable, accountId: string): Promise<string[]> {
  const result = await db.query(
    `SELECT c.id FROM principals c
      WHERE c.parent_principal_id = $1 AND ${connectorRegistryPredicateSql('c.id')}`,
    [accountId],
  );
  return result.rows.map((row) => String(row.id));
}
