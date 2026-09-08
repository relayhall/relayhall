import { DatabaseError } from 'pg';

/**
 * Identification of a caught failure for the secret-safe log sink.
 *
 * Owner ruling R17 (plan report 80119869, defect 590e88cc) asked for the
 * intermittent 500s to become identifiable to an operator without breaking the
 * non-disclosure contract in ./secretSafeLog.ts: error class, a stable code,
 * and a correlation id. This module supplies the first two.
 *
 * THE PROPERTY THAT MAKES IT SAFE. Every value returned here is one of the
 * constants written in this file. Nothing read from the caught value is ever
 * returned. Both dimensions are decided the same way: a string read from the
 * caught value is used ONLY as a lookup key, and the lookup's RESULT — our own
 * stored constant — is what is emitted. An unrecognised SQLSTATE reports
 * DB_OTHER and an unrecognised class reports UNKNOWN, rather than reporting
 * themselves. The strongest statement about the output is therefore that it is
 * drawn from a closed set written here, and that statement holds for hostile
 * input as much as ordinary input.
 *
 * NO CALLER CODE RUNS DURING IDENTIFICATION. Every property read goes through
 * ownDataProperty, which takes a property descriptor and accepts it only if it
 * is a data property. A getter is never invoked. Review d89f50d8 (B1) rejected
 * an earlier version of this file for reading `caught.code` directly after an
 * instanceof check: prototype membership does not prove that `code` is still
 * the driver's inert own property, and the reviewer demonstrated a getter
 * running inside the sink and attaching its own private marker to the emitted
 * line. That reasoning was already applied to `constructor.name` in the first
 * version and should have been applied here; it now is, uniformly.
 *
 * IDENTIFICATION NEVER THROWS. A caught value can be a Proxy whose traps throw,
 * and a sink that throws would replace the failure a handler is trying to
 * report with a new one. identifyCaughtFailure catches everything and answers
 * INSPECTION_REFUSED.
 *
 * THE RESIDUAL, STATED PLAINLY. A Proxy can observe inspection through its
 * getPrototypeOf and getOwnPropertyDescriptor traps and act on it. Nothing that
 * classifies a value at all can prevent that, and the pre-existing sink already
 * exposed it through its own `caught instanceof Error`. This module does not
 * widen that exposure; it only stops accessors on ordinary objects from firing.
 *
 * WHY MESSAGE TEXT IS NEVER MATCHED. Classifying on message text is substring
 * classification, a standing rejection class in this repository, and it would
 * read the field most likely to carry estate content. A failure with no typed
 * marker is reported honestly as ERROR_UNCLASSIFIED rather than guessed at.
 */

export const FAILURE_CODES = [
  // Postgres, by SQLSTATE.
  'DB_STATEMENT_TIMEOUT',
  'DB_SERIALIZATION_FAILURE',
  'DB_DEADLOCK',
  'DB_ADMIN_SHUTDOWN',
  'DB_TOO_MANY_CONNECTIONS',
  'DB_INSUFFICIENT_RESOURCES',
  'DB_CONNECTION_EXCEPTION',
  'DB_UNIQUE_VIOLATION',
  'DB_FOREIGN_KEY_VIOLATION',
  'DB_CHECK_VIOLATION',
  'DB_NOT_NULL_VIOLATION',
  'DB_UNDEFINED_COLUMN',
  'DB_UNDEFINED_TABLE',
  'DB_SYNTAX_ERROR',
  'DB_INSUFFICIENT_PRIVILEGE',
  'DB_OTHER',
  // Everything else.
  'ERROR_UNCLASSIFIED',
  'NON_ERROR',
  'INSPECTION_REFUSED',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * Error classes this product can actually raise, plus the platform and driver
 * classes it propagates. A class absent from this table identifies as UNKNOWN,
 * so a stale entry costs diagnostic detail and never disclosure.
 *
 * failureClassification.test.ts asserts that every `class X extends …Error`
 * declared under backend/src appears here, so adding an error class without
 * registering it fails the suite rather than silently degrading the logs.
 */
export const ERROR_CLASS_NAMES = [
  // Platform and driver.
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'DatabaseError',
  // This product.
  'AccessProfileError',
  'AssignmentAccessError',
  'AgentMintError',
  'ApprovalError',
  'BlueprintError',
  'WarrantError',
  'CredentialCryptoError',
  'CredentialLifecycleError',
  'CredentialPolicyError',
  'DelegationEvaluatorError',
  // Card 27322abb (owner ruling 60307311 §1.1): the first-run act's refusals.
  // Its status, code and message are developer-authored in FirstRunService by
  // construction; it never carries a driver's text.
  'FirstRunError',
  'StepUpError',
  'AppearanceValidationError',
  'AssetRejected',
  // Card 837fe75b: refuses a malformed RELAYHALL_IPV4_CARRIER_PREFIXES at
  // module load, so the process does not start half-configured. Its message
  // is developer-authored and quotes only the operator's own entry.
  'CarrierPrefixConfigError',
  'CharterError',
  'CharterLookupError',
  'DependencyValidationError',
  'DescriptorError',
  'GrantError',
  'GroupError',
  // RH-LENSES-a (card 74e02a05): the directory-carriage refusals.
  'DirectoryCarriageError',
  'LifecyclePolicyConfigurationError',
  'LifecyclePolicyDeniedError',
  'LifecyclePolicyEvaluationError',
  'LiteLLMAdminError',
  'McpToolError',
  'NotificationEndpointValidationError',
  // RH-P3.C6: the OAuth 2.1 authorization server's two refusal classes.
  // `OAuthError` carries an RFC 6749 §5.2 error code and a developer-authored
  // description; `ClientMetadataError` names which bound of the outbound
  // Client ID Metadata Document policy a caller's URL crossed.
  'ClientMetadataError',
  'OAuthError',
  'OrchestrationConflictError',
  'PhaseError',
  'PhaseFieldError',
  'PhaseLookupError',
  'ConflictFault',
  'ForbiddenFault',
  'InvalidRequestFault',
  'NotFoundFault',
  'PreferencesValidationError',
  'ProfileValidationError',
  'ReportHandoverValidationError',
  'ReportReferenceLookupError',
  'RequestFaultError',
  'ResourceContractError',
  'ServiceRegistryError',
  // RH-KW1 — the knowledge source plane's policy refusals (design
  // 94747de9 §4.2). They are re-raised as ServiceRegistryError at the
  // owner-plane act, but the dial client raises them directly.
  'KnowledgePolicyError',
  // RH-KW1 candidate B — the §5.2 signer and the §8.1 handle sealer. Both
  // raise NAMED refusals an operator has to be able to tell apart (a
  // rotated key from a forged handle, a stale arm evaluation from a jti
  // collision), so neither may classify as `unknown`.
  'KnowledgeAssertionError',
  'KnowledgeHandleError',
  // RH-KW1 candidate C — the coverage builder. It is raised only when a
  // CALLER of the builder tried to encode a state §7.5's partition forbids
  // (two outcomes for one source, a modifier on a source that did not answer,
  // a skipped source that was also consulted). That is an internal invariant
  // breach, never a caller's request, so it must classify as itself rather
  // than as `unknown` — an operator reading the log has to be able to tell it
  // from an ordinary failure.
  'KnowledgeCoverageError',
  // The knowledge fan-out's own clock, when a phase of a request runs out of
  // time on core's side rather than a source's. It is NOT one of item 8's
  // per-source buckets: a source that misses its budget is `timedOut` in
  // coverage, while this names core being unable to decide who may be asked
  // at all, and an operator has to be able to tell those two apart in a log.
  'KnowledgeRequestTimeoutError',
  // RH-LENSES-b (card 4287af8a) - the home-group refusals. Status, code and
  // message are developer-authored in `services/HomeGroupService` by
  // construction; no arm of it quotes a caught value.
  'HomeGroupError',
  'SkillContractError',
  'SkillDocumentError',
  'TaskElementError',
  // Cards 9c3a1aa4 / 7d38a6e0: the refusal of a Task body field that the
  // create and update surfaces share. Its code, field and message are
  // developer-authored in utils/taskWriteFields by construction; the value
  // the caller sent is never quoted back into it. ONE message interpolates a
  // timezone NAME, and that name is the row `pg_timezone_names` returned, not
  // the caller's string - a value from a server-owned closed set. A zone the
  // server does NOT know is refused without naming it at all.
  'TaskFieldError',
  'TaskNotArchivedError',
  'TaskNotFoundError',
  // RH-P5.SSO.W2 — the relying-party leg (design d95136d7, annex e6dcadb9).
  'IdentityProviderError',
  'IdTokenError',
  'SsoAuthenticationError',
  'SsoDiscoveryError',
  // RH-P5.SSO.W4 — the inbound SCIM rung. Carries the RFC 7644 §3.12
  // triple (status, scimType, detail); its messages are this file's own
  // sentences, never a caught value.
  'ScimError',
  'SsoLogoutError',
  'SsoOutboundError',
  'SsoPublicOriginError',
  // RH-TW1a — the telemetry envelope plane (design 7d5c0cdc). Both carry a
  // stable `code` and this file's own sentences; neither ever quotes a
  // reporter-supplied value, which is what lets them be logged at all.
  'TelemetryPepperError',
  'TelemetryPolicyError',
  'TelemetryQuarantineInputError',
  // Answers that are not class names.
  'UNKNOWN',
  'NonError',
] as const;

export type ErrorClassName = (typeof ERROR_CLASS_NAMES)[number];

export interface FailureIdentity {
  /** The bounded category the sink has always published. */
  category: 'Error' | 'NonError';
  /** A registered class name, or UNKNOWN / NonError. Never a caught string. */
  errorClass: ErrorClassName;
  /** A closed-set operational code. Never a caught string. */
  code: FailureCode;
}

const FAILURE_CODE_SET: ReadonlySet<string> = new Set<string>(FAILURE_CODES);
const ERROR_CLASS_NAME_SET: ReadonlySet<string> = new Set<string>(ERROR_CLASS_NAMES);

export function isFailureCode(value: string): value is FailureCode {
  return FAILURE_CODE_SET.has(value);
}

export function isErrorClassName(value: string): value is ErrorClassName {
  return ERROR_CLASS_NAME_SET.has(value);
}

/**
 * Canonical class names, keyed by themselves. The lookup exists so the emitted
 * value is the constant stored in this map rather than the string read from the
 * caught value, which is the same discipline the SQLSTATE table below uses.
 */
const CANONICAL_ERROR_CLASS_NAMES: ReadonlyMap<string, ErrorClassName> = new Map(
  ERROR_CLASS_NAMES.filter(name => name !== 'UNKNOWN' && name !== 'NonError')
    .map(name => [name as string, name] as const),
);

/**
 * Enumerated SQLSTATE table. Membership only — the key is never emitted, and a
 * code absent from this table classifies as DB_OTHER.
 */
const SQLSTATE_FAILURE_CODES: ReadonlyMap<string, FailureCode> = new Map<string, FailureCode>([
  ['57014', 'DB_STATEMENT_TIMEOUT'],
  ['40001', 'DB_SERIALIZATION_FAILURE'],
  ['40P01', 'DB_DEADLOCK'],
  ['57P01', 'DB_ADMIN_SHUTDOWN'],
  ['57P02', 'DB_ADMIN_SHUTDOWN'],
  ['57P03', 'DB_ADMIN_SHUTDOWN'],
  ['53300', 'DB_TOO_MANY_CONNECTIONS'],
  ['53000', 'DB_INSUFFICIENT_RESOURCES'],
  ['53100', 'DB_INSUFFICIENT_RESOURCES'],
  ['53200', 'DB_INSUFFICIENT_RESOURCES'],
  ['08000', 'DB_CONNECTION_EXCEPTION'],
  ['08001', 'DB_CONNECTION_EXCEPTION'],
  ['08003', 'DB_CONNECTION_EXCEPTION'],
  ['08004', 'DB_CONNECTION_EXCEPTION'],
  ['08006', 'DB_CONNECTION_EXCEPTION'],
  ['23505', 'DB_UNIQUE_VIOLATION'],
  ['23503', 'DB_FOREIGN_KEY_VIOLATION'],
  ['23514', 'DB_CHECK_VIOLATION'],
  ['23502', 'DB_NOT_NULL_VIOLATION'],
  ['42703', 'DB_UNDEFINED_COLUMN'],
  ['42P01', 'DB_UNDEFINED_TABLE'],
  ['42601', 'DB_SYNTAX_ERROR'],
  ['42501', 'DB_INSUFFICIENT_PRIVILEGE'],
]);

/**
 * Read a property only if it is an own DATA property. Returns undefined for an
 * accessor, so no caller-supplied getter is ever invoked.
 */
function ownDataProperty(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

/** The caught value's class name, by data-property reads only. */
function registeredClassName(caught: object): ErrorClassName {
  const prototype = Object.getPrototypeOf(caught);
  if (prototype === null || typeof prototype !== 'object') return 'UNKNOWN';
  const constructor = ownDataProperty(prototype, 'constructor');
  if (typeof constructor !== 'function') return 'UNKNOWN';
  const name = ownDataProperty(constructor, 'name');
  if (typeof name !== 'string') return 'UNKNOWN';
  return CANONICAL_ERROR_CLASS_NAMES.get(name) ?? 'UNKNOWN';
}

/**
 * The operational code. Membership in the driver's class is proven with
 * instanceof, so a driver subclass still classifies, but the SQLSTATE itself is
 * read as a data property only — that read is what review d89f50d8 B1 broke.
 */
function operationalCode(caught: object): FailureCode {
  if (!(caught instanceof DatabaseError)) return 'ERROR_UNCLASSIFIED';
  const sqlstate = ownDataProperty(caught, 'code');
  if (typeof sqlstate !== 'string') return 'DB_OTHER';
  return SQLSTATE_FAILURE_CODES.get(sqlstate) ?? 'DB_OTHER';
}

/**
 * Identify a caught failure. Total: any hostile trap that throws is answered
 * with INSPECTION_REFUSED rather than propagated into the caller's catch block.
 */
export function identifyCaughtFailure(caught: unknown): FailureIdentity {
  try {
    if (!(caught instanceof Error)) {
      return { category: 'NonError', errorClass: 'NonError', code: 'NON_ERROR' };
    }
    const errorClass = registeredClassName(caught);
    return { category: 'Error', errorClass, code: operationalCode(caught) };
  } catch {
    return { category: 'NonError', errorClass: 'UNKNOWN', code: 'INSPECTION_REFUSED' };
  }
}
