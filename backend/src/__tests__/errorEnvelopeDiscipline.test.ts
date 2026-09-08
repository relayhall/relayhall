/**
 * errorEnvelopeDiscipline.test.ts — card 49399562, hardened per review
 * 3db17273 (B3/B4): the product refused to write a caught value's message to
 * its own operator log (secretSafeLog, a reviewed non-disclosure decision)
 * while dozens of error responses handed the same message to any
 * authenticated HTTP caller. The sweep resolved the asymmetry in the log's
 * favor, and review 3db17273 replaced message-substring dispatch with typed
 * RequestFaultError classes thrown at the service boundary.
 *
 * The regression gate here is an AST taint scan over every catch clause in
 * production source: the caught binding (and every local alias derived from
 * it) may reach a response sink — res.json(...), res.send(...),
 * sendApiError(...) — ONLY inside a branch guarded by `instanceof` of an
 * approved in-house error class. The secret-safe log sinks are recognized
 * sanitizers, so `const errorId = logCaughtFailure(...)` stays usable in
 * envelopes. Red-capability fixtures prove the scanner catches the ordinary
 * regression shapes review 3db17273 demonstrated bypassing the old regex
 * gate: direct member access, aliases, reordered/multiline properties,
 * spreads, helper calls, String(err), and sendApiError details.
 *
 * Known scope limit (documented, reviewed): the scan covers catch clauses.
 * Helper functions that RECEIVE a caught value as a parameter
 * (sendSkillError, sendContractError, apiErrorHandler, ...) are ordinary
 * reviewed code paths; their bodies still fall under the literal gates
 * below ('Unknown error' ban, non-empty-fallback ternary allowlist).
 */
import express from 'express';
import type { AddressInfo } from 'net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() },
}));
jest.mock('../services/AuthorizationRepository', () => ({
  authorizationRepository: {
    authorizedIds: jest.fn(async (_actor: unknown, _type: string, _ids: string[]) => new Set<string>()),
    authorizePoint: jest.fn(async (actor: { principalId?: string }, type: string, id: string, verb: string) => ({
      allowed: actor.principalId === '99999999-9999-4999-8999-999999999999'
        && type === 'task' && id === '00000000-0000-4000-8000-000000000000' && verb === 'verify',
    })),
  },
}));
jest.mock('../services/NotificationManager', () => ({
  notificationManager: {
    getUnreadNotifications: jest.fn(async () => { throw new Error('SECRET-DB-DETAIL row=(a,b,c)'); }),
    getNotifications: jest.fn(async () => []),
    markAsRead: jest.fn(async () => true),
    markAllAsRead: jest.fn(async () => 0),
  },
}));
const taskManagerBehavior: {
  createTask: (() => Promise<unknown>) | null;
  archiveTask: (() => Promise<unknown>) | null;
} = { createTask: null, archiveTask: null };
jest.mock('../services/TaskManagerDB', () => {
  const actual = jest.requireActual('../services/TaskManagerDB');
  return {
    ...actual,
    taskManagerDB: {
      getTask: jest.fn(async (id: string) => reviewerBehavior.runReview
        ? { id, ownerPrincipalId: null, verifierPrincipalId: '99999999-9999-4999-8999-999999999999' }
        : undefined),
      queryLinkedReports: jest.fn(async () => []),
      getBlockingTasks: jest.fn(async () => []),
      createTask: jest.fn(async () => {
        if (taskManagerBehavior.createTask) return taskManagerBehavior.createTask();
        throw new Error('createTask fixture not armed');
      }),
      archiveTask: jest.fn(async () => {
        if (taskManagerBehavior.archiveTask) return taskManagerBehavior.archiveTask();
        throw new Error('archiveTask fixture not armed');
      }),
    },
  };
});
jest.mock('../services/ReportManager', () => ({ reportManager: { getBriefProjections: jest.fn(async () => []) } }));
jest.mock('../services/taskAnalyzer', () => ({ taskAnalyzer: {} }));
jest.mock('../services/NotificationEndpointService', () => ({ notificationEndpointService: { dispatchException: jest.fn() } }));
jest.mock('../services/TelemetryService', () => ({ telemetryService: { livenessForTask: jest.fn(async () => null) } }));
jest.mock('../services/CanonicalRuntimeSignalService', () => ({ canonicalRuntimeSignalService: { listTaskSignals: jest.fn(async () => []) } }));
const reviewerBehavior: { runReview: (() => Promise<unknown>) | null } = { runReview: null };
jest.mock('../services/TaskReviewerService', () => ({
  taskReviewerService: {
    runReview: jest.fn(async () => {
      if (reviewerBehavior.runReview) return reviewerBehavior.runReview();
      return { verdict: 'noop' };
    }),
  },
}));
jest.mock('../services/TaskOrchestrationService', () => ({
  taskOrchestrationService: {},
  OrchestrationConflictError: class extends Error { },
}));
jest.mock('../services/DiscordThreadService', () => ({ discordThreadService: {} }));
jest.mock('../services/TaskHistoryService', () => ({ taskHistoryService: { recordChange: jest.fn() } }));
jest.mock('../services/TaskNotificationService', () => ({ taskNotificationService: {} }));
jest.mock('../services/PrincipalService', () => ({ principalService: {} }));
jest.mock('../services/UnifiedTaskTimeline', () => ({ unifiedTaskTimeline: {}, decodeCursor: jest.fn() }));

import tasksRouter from '../routes/tasks';
import { healthHandler } from '../routes/health';
import { NotFoundFault } from '../utils/httpErrors';
import { pool } from '../db/connection';

const SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      walk(full, out);
    } else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The AST taint scan
// ---------------------------------------------------------------------------

/** In-house error classes whose messages are developer-authored by
 * construction; an instanceof guard on one of these authorizes returning its
 * message/code/status. Adding a class here is a reviewed decision. */
const APPROVED_CLASSES = new Set([
  'RequestFaultError', 'NotFoundFault', 'ForbiddenFault', 'ConflictFault', 'InvalidRequestFault',
  'OrchestrationConflictError', 'ProfileValidationError', 'DependencyValidationError',
  'SkillContractError', 'TaskNotFoundError', 'TaskNotArchivedError',
  'CharterError', 'PhaseError', 'ResourceContractError',
  'NotificationEndpointValidationError', 'ReportReferenceLookupError',
  'ReportHandoverValidationError', 'PreferencesValidationError', 'GrantError',
  'CredentialPolicyError', 'CredentialLifecycleError', 'StepUpError',
  // Card 27322abb (owner ruling 60307311 §1.1). The first-run act's refusals
  // are CONTRACT ANSWERS: a person setting up a deployment has to learn that
  // the step is closed, that the handle is reserved, or that the password is
  // too short — "something went wrong" on the only door into a fresh
  // deployment is a support ticket. Status, code and message are
  // developer-authored in `services/FirstRunService` by construction, and no
  // arm of it ever quotes a caught value.
  'FirstRunError',
  // AZ-S4 (design 4d961e37 §6): warrant/approval/mint refusals carry
  // developer-authored codes and messages by construction.
  'WarrantError', 'ApprovalError', 'AgentMintError',
  // AZ-S7 (ruling 7440b579): the assignment-access coupling's refusals are
  // contract answers — a caller must learn WHICH rule blocked its
  // assignment (no live vehicle, an own() expression that excludes the
  // task, a ceiling that cannot be materialized). Codes and messages are
  // developer-authored in AccessVehicleService by construction.
  'AssignmentAccessError',
  // RH-P5.SSO.W2: the relying-party refusals are contract answers. A caller
  // must learn that its state was unknown, its invitation invalid, or its
  // logout token replayed — "something went wrong" would make the surface
  // undebuggable. Codes are developer-authored enums, and every message sent
  // is a FIXED sentence looked up by code, never the error's own text.
  'SsoAuthenticationError', 'SsoLogoutError', 'IdTokenError',
  'SsoDiscoveryError', 'SsoOutboundError', 'IdentityProviderError',
  // RH-P3.C6: the authorization server's refusals ARE its protocol answers —
  // RFC 6749 §5.2 requires the client to be told `invalid_grant` rather than
  // "something went wrong", and RFC 9728 discovery is unusable if a client
  // cannot learn that its metadata document was, say, redirected. Both
  // classes carry developer-authored codes and messages by construction
  // (services/OAuthAuthorizationService, services/OAuthClientMetadataService).
  'OAuthError', 'ClientMetadataError',
  // Card 9c177e6a. `ProjectTargetNotFoundFault` takes NO constructor
  // arguments: its status, code and message are the three compile-time
  // constants written in utils/httpErrors, it never quotes a caught value, and
  // it is thrown from exactly one place. It is approved here rather than
  // re-spelled at each route because a second copy of 'Project not found'
  // could drift from the one the concealment rule depends on.
  'ProjectTargetNotFoundFault',
  // RH-LENSES-b (card 4287af8a). The home-group refusals are CONTRACT
  // ANSWERS: a person choosing a home group has to learn that the Group is
  // not featured, or that they are not a member of it - `GROUP_NOT_FEATURED`
  // and `NOT_A_GROUP_MEMBER` are the acceptance row A-L19's named codes, and
  // "something went wrong" would make the choice undebuggable. Status, code
  // and message are developer-authored in `services/HomeGroupService` by
  // construction and no arm of it quotes a caught value.
  'HomeGroupError',
]);

/** Calls whose return value is safe even though a caught value went in:
 * the secret-safe log sinks return an opaque correlation id.
 * logProjectSkillFailure is the routes/projects.ts wrapper around
 * logCaughtFailure (review 3db17273 B1). */
const SANITIZERS = new Set([
  'logCaughtFailure', 'logCaughtWarning', 'identifyCaughtFailure',
  // Route-local wrappers that forward to logCaughtFailure and return its
  // opaque correlation id (reviews 3db17273 B1 and r2 B2).
  'logProjectSkillFailure', 'logGrantRouteFailure', 'logGroupRouteFailure', 'logAccessProfileRouteFailure', 'logPhaseRouteFailure',
  'logServiceRouteFailure', 'logPreferencesFailure', 'logFailure',
  // RH-LENSES-a (card 74e02a05): the catalog route module's wrapper, the
  // same shape as `logGroupRouteFailure` one family over -- it forwards to
  // logCaughtFailure and returns its opaque correlation id.
  'logDirectoryGroupReferenceFailure',
]);

/** Helpers a catch may hand the caught value together with `res`: each one
 * is a reviewed response-sending path whose own body falls under the
 * envelope-shape rules below (review 3db17273 r2 B3). Passing a caught
 * value to any OTHER res-taking callee is flagged as an unapproved sink. */
const APPROVED_RESPONSE_HELPERS = new Set([
  'sendLifecyclePolicyError', 'sendContractError', 'sendPhaseBindingRefusal',
  'sendStringTooLongError', 'sendSkillError', 'sendError', 'next',
  'respondFailure', 'sendGrantError', 'sendGroupError', 'sendAccessProfileError', 'sendCredentialLifecycleError', 'sendPhaseError', 'sendCharterError',
  'sendServiceError', 'sendTaskElementError',
  // RH-LENSES-a (card 74e02a05): forwards ONLY typed DirectoryCarriageError
  // refusals (instanceof-guarded) and returns false for anything else,
  // which then rides logCaughtFailure and the generic 500 envelope.
  'sendCarriageError',
  // Cards 9c3a1aa4 / 7d38a6e0: the shared Task write-field refusal, shaped
  // exactly like sendPhaseBindingRefusal beside it. It forwards ONLY a
  // typed TaskFieldError (instanceof-guarded) whose code, field and message
  // are developer-authored in utils/taskWriteFields, and returns false for
  // anything else, which then rides logCaughtFailure and the generic
  // envelope. The value the caller sent is never echoed back.
  'sendTaskFieldRefusal',
  // RH-LENSES-b: forwards only `HomeGroupError` (instanceof-guarded) and
  // returns false for anything else, which then rides logCaughtFailure and
  // the generic 500 envelope.
  'sendHomeGroupError',
  // AZ-S4: the warrants/approvals/delegation route-local senders — each
  // forwards only typed in-house refusals (instanceof-guarded) and returns
  // false for anything else, which then rides logCaughtFailure + the
  // generic envelope.
  'sendWarrantError', 'sendApprovalError', 'sendMintError',
  // RH-P5.SSO.W2: forwards only the typed relying-party refusals above
  // (instanceof-guarded) and returns false for anything else, which then rides
  // logCaughtFailure and the generic 500 envelope.
  'sendSsoRefusal',
  // RH-P5.SSO.W2: the Identity provider owner-plane sender — same shape, and
  // its named refusals (SS-21, SS-14a, SS-22) are answers an operator must
  // read to know which configuration rule stopped them.
  'sendIdentityProviderError',
  // RH-P3.C6: forwards only `OAuthError` (instanceof-guarded, RFC 6749 §5.2
  // shape); anything else rides logCaughtFailure and the generic 500 envelope,
  // whose own shape the gate below checks.
  'sendOAuthError',
  // RH-P5.SSO.W4: the SCIM sender — the same instanceof-guarded shape.
  // It forwards ONLY `ScimError`, whose status/scimType/detail are
  // developer-authored, and everything else rides logCaughtFailure and a
  // generic 500 that carries the correlation id and nothing of the caught
  // value. The SCIM error object is a protocol contract a conforming
  // client branches on, which is why this family answers in it at all.
  'sendScimError',
]);

function calleeName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function scanSource(fileName: string, sourceText: string): string[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2020, true);
  const violations: string[] = [];

  function conditionApproves(expr: ts.Node): boolean {
    let ok = false;
    const look = (e: ts.Node): void => {
      if (ts.isBinaryExpression(e)
        && e.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
        && ts.isIdentifier(e.right)
        && APPROVED_CLASSES.has(e.right.text)) ok = true;
      ts.forEachChild(e, look);
    };
    look(expr);
    return ok;
  }

  function handleCatch(clause: ts.CatchClause): void {
    const decl = clause.variableDeclaration;
    if (!decl || !ts.isIdentifier(decl.name)) return;
    const tainted = new Set<string>([decl.name.text]);

    const referencesTainted = (node: ts.Node): boolean => {
      if (ts.isIdentifier(node) && tainted.has(node.text)) {
        const parent = node.parent;
        if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
        if (parent && ts.isPropertyAssignment(parent) && parent.name === node) return false;
        return true;
      }
      let found = false;
      ts.forEachChild(node, (child) => { if (!found && referencesTainted(child)) found = true; });
      return found;
    };

    const isSanitizerCall = (node: ts.Node): boolean =>
      ts.isCallExpression(node) && SANITIZERS.has(calleeName(node) ?? '');

    // Alias propagation runs to a FIXED POINT and covers declarations,
    // plain assignment expressions, and destructuring (review 3db17273 r4
    // B1: `let detail; detail = \`${err}\`` is an ordinary alias).
    const bindingNames = (name: ts.BindingName): string[] => {
      if (ts.isIdentifier(name)) return [name.text];
      const out: string[] = [];
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) out.push(...bindingNames(element.name));
      }
      return out;
    };
    // Assignment targets include destructuring-ASSIGNMENT forms, whose left
    // side is an object/array literal, not a BindingName (review 3db17273
    // r5 B1: `({ message } = err)` is an ordinary alias). Nested patterns,
    // defaults, and rest elements all resolve to their target identifiers.
    const assignmentTargetNames = (expr: ts.Expression): string[] => {
      if (ts.isIdentifier(expr)) return [expr.text];
      if (ts.isObjectLiteralExpression(expr)) {
        const out: string[] = [];
        for (const prop of expr.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) out.push(prop.name.text);
          else if (ts.isPropertyAssignment(prop)) out.push(...assignmentTargetNames(prop.initializer));
          else if (ts.isSpreadAssignment(prop)) out.push(...assignmentTargetNames(prop.expression));
        }
        return out;
      }
      if (ts.isArrayLiteralExpression(expr)) {
        const out: string[] = [];
        for (const element of expr.elements) {
          if (ts.isSpreadElement(element)) out.push(...assignmentTargetNames(element.expression));
          else if (ts.isOmittedExpression(element)) continue;
          else out.push(...assignmentTargetNames(element));
        }
        return out;
      }
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return assignmentTargetNames(expr.left); // default value form
      }
      if (ts.isParenthesizedExpression(expr)) return assignmentTargetNames(expr.expression);
      return [];
    };
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer
        && !isSanitizerCall(node.initializer) && referencesTainted(node.initializer)) {
        for (const alias of bindingNames(node.name)) tainted.add(alias);
      }
      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && !isSanitizerCall(node.right) && referencesTainted(node.right)) {
        for (const alias of assignmentTargetNames(node.left)) tainted.add(alias);
      }
      ts.forEachChild(node, collect);
    };
    let taintedSize = -1;
    while (taintedSize !== tainted.size) {
      taintedSize = tainted.size;
      collect(clause.block);
    }

    const isGuarded = (use: ts.Node): boolean => {
      let node: ts.Node = use;
      while (node && node !== clause) {
        const parent = node.parent;
        if (parent && ts.isIfStatement(parent) && node === parent.thenStatement && conditionApproves(parent.expression)) return true;
        if (parent && ts.isConditionalExpression(parent) && node === parent.whenTrue && conditionApproves(parent.condition)) return true;
        node = parent;
      }
      return false;
    };

    const flagUses = (node: ts.Node, sinkLabel: string): void => {
      if (ts.isIdentifier(node) && tainted.has(node.text)) {
        const parent = node.parent;
        const isPropertyName =
          (parent && ts.isPropertyAccessExpression(parent) && parent.name === node)
          || (parent && ts.isPropertyAssignment(parent) && parent.name === node);
        // The left operand of `x instanceof C` is a type test, not a
        // disclosure — the guarded branch it selects is checked on its own.
        const isInstanceofOperand = parent && ts.isBinaryExpression(parent)
          && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
          && parent.left === node;
        if (!isPropertyName && !isInstanceofOperand && !isGuarded(node)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          violations.push(`${fileName}:${line + 1} caught value '${node.text}' reaches ${sinkLabel} unguarded`);
        }
        return;
      }
      if (isSanitizerCall(node)) return; // its return is safe wherever it appears
      ts.forEachChild(node, (child) => flagUses(child, sinkLabel));
    };

    const findSinks = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name === 'json' || name === 'send') {
          for (const arg of node.arguments) flagUses(arg, `res.${name}()`);
        } else if (name === 'sendApiError') {
          for (const arg of node.arguments.slice(1)) flagUses(arg, 'sendApiError()');
        } else if (name && !SANITIZERS.has(name) && !APPROVED_RESPONSE_HELPERS.has(name)) {
          // A call handed BOTH `res` and a caught value is a response
          // helper in disguise (review 3db17273 r2 B3, litellmAdmin shape).
          const takesRes = node.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === 'res');
          if (takesRes) {
            for (const arg of node.arguments) {
              if (referencesTainted(arg)) {
                const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
                violations.push(`${fileName}:${line + 1} caught value passed with res to unapproved helper '${name}'`);
                break;
              }
            }
          }
        }
      }
      ts.forEachChild(node, findSinks);
    };
    findSinks(clause.block);

    // Order rule (review 3db17273 r2 B2/B3 fixture 4): the sanitizer call
    // must come AFTER every approved-instanceof guarded branch in the catch,
    // so no correlation id is minted and then dropped by a typed arm.
    // Only a TOP-LEVEL sanitizer statement counts: a sanitizer nested inside
    // a typed arm logs for that arm alone and drops no id.
    const statements = clause.block.statements;
    let sanitizerIndex = -1;
    statements.forEach((statement, index) => {
      if (sanitizerIndex !== -1) return;
      if (ts.isExpressionStatement(statement) && isSanitizerCall(statement.expression)) sanitizerIndex = index;
      if (ts.isVariableStatement(statement)
        && statement.declarationList.declarations.some((d) => d.initializer && isSanitizerCall(d.initializer))) {
        sanitizerIndex = index;
      }
    });
    if (sanitizerIndex >= 0) {
      statements.forEach((statement, index) => {
        if (index > sanitizerIndex && ts.isIfStatement(statement) && conditionApproves(statement.expression)) {
          const { line } = sf.getLineAndCharacterOfPosition(statement.getStart());
          violations.push(`${fileName}:${line + 1} typed guard after the sanitizer call - the minted errorId is dropped by this arm`);
        }
        // Once an id is minted, every subsequent response send in the catch
        // must carry it - a send without it drops the correlation, and a
        // self-minting helper (sendStringTooLongError) would mint a SECOND
        // id for the same failure (review 3db17273 r3 B2/B3).
        if (index > sanitizerIndex) {
          const findSends = (n: ts.Node): void => {
            if (ts.isCallExpression(n)) {
              const name = calleeName(n) ?? '';
              const isSend = name === 'json' || name === 'send' || name === 'sendApiError'
                || APPROVED_RESPONSE_HELPERS.has(name);
              if (isSend && name !== 'next') {
                const mentionsId = /\berrorId\b/.test(n.getText());
                if (!mentionsId) {
                  const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
                  violations.push(`${fileName}:${line + 1} response send after the sanitizer call without the minted errorId ('${name}')`);
                }
              }
            }
            ts.forEachChild(n, findSends);
          };
          findSends(statement);
        }
      });
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) handleCatch(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Request-path files (routes/, middleware/) may not DISCARD the failure
  // sink's correlation id: every logCaughtFailure call must be
  // value-consumed so the corresponding envelope can carry the id
  // (review 3db17273 r3 B2/B3).
  const requestPath = fileName.startsWith('routes' + sep) || fileName.startsWith('middleware' + sep)
    || fileName.startsWith('routes/') || fileName.startsWith('middleware/');
  if (requestPath) {
    const findDiscards = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)
        && ts.isCallExpression(node.expression)
        && calleeName(node.expression) === 'logCaughtFailure') {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        violations.push(`${fileName}:${line + 1} logCaughtFailure id discarded in a request path`);
      }
      ts.forEachChild(node, findDiscards);
    };
    findDiscards(sf);
  }
  return violations;
}

/**
 * Envelope-shape rule (review 3db17273 r2 B2/B3): every literal 500 sent
 * anywhere in production source — res.status(500).json({...}) and
 * sendApiError(res, 500, ...) — must carry a SCREAMING_SNAKE code, a fixed
 * string-literal message, and a correlating errorId identifier.
 */
const SCREAMING = /^[A-Z][A-Z0-9_]*$/;

function scanEnvelopeShapes(fileName: string, sourceText: string): string[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2020, true);
  const violations: string[] = [];

  const mentions = (node: ts.Node, name: string): boolean => {
    if (ts.isIdentifier(node) && node.text === name) return true;
    let found = false;
    ts.forEachChild(node, (child) => { if (!found && mentions(child, name)) found = true; });
    return found;
  };

  const flag = (node: ts.Node, message: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    violations.push(`${fileName}:${line + 1} ${message}`);
  };

  const isLiteral500 = (call: ts.CallExpression): boolean =>
    ts.isPropertyAccessExpression(call.expression)
    && call.expression.name.text === 'status'
    && call.arguments.length === 1
    && ts.isNumericLiteral(call.arguments[0])
    && call.arguments[0].text === '500';

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node) === 'json'
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isCallExpression(node.expression.expression)
      && isLiteral500(node.expression.expression)) {
      const arg = node.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) {
        flag(node, 'status(500).json without an inspectable object literal');
      } else {
        const props = new Map<string, ts.Node | null>();
        for (const prop of arg.properties) {
          if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
            props.set(prop.name.text, prop.initializer);
          } else if (ts.isShorthandPropertyAssignment(prop)) {
            props.set(prop.name.text, null);
          }
        }
        const code = props.get('code');
        if (code === undefined || code === null || !ts.isStringLiteral(code) || !SCREAMING.test(code.text)) {
          flag(node, '500 envelope without a SCREAMING_SNAKE string-literal code');
        }
        const fixedMessage = ['error', 'message'].some((key) => {
          const value = props.get(key);
          return value !== undefined && value !== null && ts.isStringLiteral(value);
        });
        if (!fixedMessage) flag(node, '500 envelope without a fixed string-literal error/message');
        if (!mentions(arg, 'errorId')) flag(node, '500 envelope without a correlating errorId');
      }
    }
    if (ts.isCallExpression(node) && calleeName(node) === 'sendApiError'
      && node.arguments.length >= 2
      && ts.isNumericLiteral(node.arguments[1]) && node.arguments[1].text === '500') {
      const code = node.arguments[2];
      if (!code || !ts.isStringLiteral(code) || !SCREAMING.test(code.text)) {
        flag(node, 'sendApiError 500 without a SCREAMING_SNAKE string-literal code');
      }
      const message = node.arguments[3];
      if (!message || !ts.isStringLiteral(message)) {
        flag(node, 'sendApiError 500 without a fixed string-literal message');
      }
      if (!node.arguments.some((arg) => mentions(arg, 'errorId'))) {
        flag(node, 'sendApiError 500 without a correlating errorId');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

// ---------------------------------------------------------------------------

describe('AST taint gate: caught values never reach a response sink unguarded', () => {
  const files = walk(SRC);

  test('production source has zero violations', () => {
    const violations: string[] = [];
    for (const file of files) {
      violations.push(...scanSource(relative(SRC, file), readFileSync(file, 'utf8')));
    }
    expect(violations).toEqual([]);
  });

  // Red-capability fixtures: each of these is an ORDINARY regression shape
  // (review 3db17273 B3 demonstrated the first three bypassing the old
  // regex gate). The scanner must flag every one.
  const RED: Array<[string, string]> = [
    ['direct member access',
      "try { f(); } catch (err) { res.status(500).json({ success: false, error: err.message }); }"],
    ['alias through an empty-fallback ternary',
      "try { f(); } catch (err) { const detail = err instanceof Error ? err.message : ''; res.status(500).json({ success: false, error: detail }); }"],
    ['spread of a derived object',
      "try { f(); } catch (err) { const body = { error: err.message }; res.status(500).json({ ...body }); }"],
    ['reordered multiline properties',
      "try { f(); } catch (err) { res.status(500).json({\n  code: 'X',\n  error: err.message,\n}); }"],
    ['helper call fed the caught value',
      "try { f(); } catch (err) { res.status(500).json({ success: false, error: fmt(err) }); }"],
    ['String() coercion',
      "try { f(); } catch (err) { res.status(500).json({ success: false, error: String(err) }); }"],
    ['sendApiError detail argument',
      "try { f(); } catch (err) { sendApiError(res, 400, 'X', 'msg', undefined, err.message); }"],
    ['res.send of a template literal',
      "try { f(); } catch (err) { res.send(`failed: ${err}`); }"],
    ['guard on a NON-approved class',
      "try { f(); } catch (err) { if (err instanceof Error) { res.status(500).json({ error: err.message }); } }"],
    ['alias of an alias',
      "try { f(); } catch (err) { const a = err.message; const b = a; res.status(500).json({ error: b }); }"],
    ['assignment-expression alias (review 3db17273 r4 B1)',
      "try { f(); } catch (err) { let detail; detail = `${err}`; const errorId = 'fixed-id'; res.status(500).json({ success: false, code: 'X_FAILED', error: 'fixed', details: detail, errorId }); }"],
    ['destructuring alias',
      "try { f(); } catch (err) { const { message } = err as Error; res.status(500).json({ success: false, code: 'X_FAILED', error: message, errorId }); }"],
    ['assignment alias of an assignment alias',
      "try { f(); } catch (err) { let a; let b; a = String(err); b = a; res.status(500).json({ success: false, code: 'X_FAILED', error: 'fixed', details: b, errorId }); }"],
    ['destructuring-ASSIGNMENT alias (review 3db17273 r5 B1)',
      "try { f(); } catch (err) { let message; ({ message } = err as Error); res.status(500).json({ success: false, code: 'X_FAILED', error: 'fixed', details: message, errorId }); }"],
    ['array destructuring-assignment alias',
      "try { f(); } catch (err) { let first; [first] = [String(err)]; res.status(500).json({ success: false, code: 'X_FAILED', error: 'fixed', details: first, errorId }); }"],
    ['nested destructuring assignment with rest and default',
      "try { f(); } catch (err) { let inner; let rest; ({ a: { inner = 'd' } = {}, ...rest } = err as any); res.status(500).json({ success: false, code: 'X_FAILED', error: 'fixed', details: rest, errorId }); }"],
  ];
  test.each(RED)('flags: %s', (_label, code) => {
    expect(scanSource('fixture.ts', code).length).toBeGreaterThan(0);
  });

  const RED_HELPERS_AND_ORDER: Array<[string, string]> = [
    ['catch handing the caught value to an unapproved res-taking helper',
      "try { f(); } catch (err) { sendFancyError(res, err); }"],
    ['typed guard AFTER the sanitizer call drops the minted id',
      "try { f(); } catch (err) { const errorId = logCaughtFailure('[x]:', err); if (err instanceof RequestFaultError) { res.status(err.status).json({ success: false, code: err.code, error: err.message }); return; } res.status(500).json({ success: false, code: 'X_FAILED', error: 'It failed', errorId }); }"],
  ];
  test.each(RED_HELPERS_AND_ORDER)('flags: %s', (_label, code) => {
    expect(scanSource('fixture.ts', code).length).toBeGreaterThan(0);
  });

  // review 3db17273 r3 B3: discarded and double-minted correlation ids.
  const RED_ID_DISCARDS: Array<[string, string]> = [
    ['arm-local typed 4xx that discards the minted id',
      "try { f(); } catch (err) { if (weird(err)) { logCaughtFailure('[x]:', err); res.status(400).json({ success: false, code: 'X_BAD', error: 'fixed' }); return; } const errorId = logCaughtFailure('[x]:', err); res.status(500).json({ success: false, code: 'X_FAILED', error: 'It failed', errorId }); }"],
    ['fixed 503 that discards the minted id',
      "try { f(); } catch (err) { logCaughtFailure('[x]:', err); res.status(503).json({ success: false, code: 'X_UNAVAILABLE', error: 'fixed' }); }"],
    ['generic mint before a self-minting helper doubles the id',
      "try { f(); } catch (err) { const errorId = logCaughtFailure('[x]:', err); if (isStringTooLongError(err)) { sendStringTooLongError(res, 'x', err); return; } res.status(500).json({ success: false, code: 'X_FAILED', error: 'It failed', errorId }); }"],
    ['send after the mint without the id',
      "try { f(); } catch (err) { const errorId = logCaughtFailure('[x]:', err); if (weird(err)) { res.status(422).json({ success: false, code: 'X_SHAPE', error: 'fixed' }); return; } res.status(500).json({ success: false, code: 'X_FAILED', error: 'It failed', errorId }); }"],
  ];
  test.each(RED_ID_DISCARDS)('flags: %s', (_label, code) => {
    expect(scanSource('routes/fixture.ts', code).length).toBeGreaterThan(0);
  });

  test('accepts: arm-local mint whose envelope carries the id, then the fixed 500', () => {
    const code = "try { f(); } catch (err) { if (err instanceof ProfileValidationError) { const errorId = logCaughtFailure('[x] refused:', err); res.status(err.status).json({ success: false, code: err.code, error: err.message, errorId }); return; } const errorId = logCaughtFailure('[x]:', err); res.status(500).json({ success: false, code: 'X_FAILED', error: 'It failed', errorId }); }";
    expect(scanSource('routes/fixture.ts', code)).toEqual([]);
  });

  const GREEN: Array<[string, string]> = [
    ['typed fault arm BEFORE the sanitizer, then the fixed 500 envelope',
      "try { f(); } catch (err) { if (err instanceof RequestFaultError) { res.status(err.status).json({ success: false, code: err.code, error: err.message }); return; } const errorId = logCaughtFailure('[x] failed:', err); res.status(500).json({ success: false, code: 'X_FAILED', error: 'It failed', errorId }); }"],
    ['catch handing the caught value to an APPROVED response helper',
      "try { f(); } catch (err) { if (sendLifecyclePolicyError(res, err)) return; const errorId = logCaughtFailure('[x]:', err); res.status(500).json({ success: false, code: 'X_FAILED', error: 'It failed', errorId }); }"],
    ['ternary guarded by an approved class',
      "try { f(); } catch (err) { res.status(409).json({ success: false, code: err instanceof OrchestrationConflictError ? err.code : 'X', error: 'fixed' }); }"],
    ['sanitizer id in the envelope and status from the caught value ignored',
      "try { f(); } catch (err) { const errorId = logCaughtFailure('[x]:', err); sendApiError(res, 500, 'X', 'fixed message', undefined, { errorId }); }"],
  ];
  test.each(GREEN)('accepts: %s', (_label, code) => {
    expect(scanSource('fixture.ts', code)).toEqual([]);
  });
});

describe('envelope-shape gate: every literal 500 carries code + fixed message + errorId (review 3db17273 r2 B2/B3)', () => {
  const files = walk(SRC);

  test('production source has zero violations', () => {
    const violations: string[] = [];
    for (const file of files) {
      violations.push(...scanEnvelopeShapes(relative(SRC, file), readFileSync(file, 'utf8')));
    }
    expect(violations).toEqual([]);
  });

  const RED: Array<[string, string]> = [
    ['fixed 500 with no code',
      "res.status(500).json({ success: false, error: 'It failed', errorId });"],
    ['500 with a lower-case code',
      "res.status(500).json({ success: false, code: 'internal_error', error: 'It failed', errorId });"],
    ['500 whose message is interpolated, not fixed',
      "res.status(500).json({ success: false, code: 'X_FAILED', error: `failed: ${detail}`, errorId });"],
    ['500 that discards the correlation id',
      "res.status(500).json({ success: false, code: 'X_FAILED', error: 'It failed' });"],
    ['500 sent as an opaque variable',
      "const body = makeBody(); res.status(500).json(body);"],
    ['sendApiError 500 with no errorId anywhere',
      "sendApiError(res, 500, 'INTERNAL_ERROR', 'Unexpected server error');"],
    ['sendApiError 500 with a non-literal code',
      "sendApiError(res, 500, someCode, 'Unexpected server error', undefined, { errorId });"],
  ];
  test.each(RED)('flags: %s', (_label, code) => {
    expect(scanEnvelopeShapes('fixture.ts', code).length).toBeGreaterThan(0);
  });

  const GREEN: Array<[string, string]> = [
    ['conforming 500 json',
      "res.status(500).json({ success: false, code: 'X_FAILED', error: 'It failed', errorId });"],
    ['conforming sendApiError 500 with details.errorId',
      "sendApiError(res, 500, 'INTERNAL_ERROR', 'Unexpected server error', undefined, { errorId });"],
    ['non-500 envelopes are out of scope for this rule',
      "res.status(404).json({ success: false, error: message });"],
  ];
  test.each(GREEN)('accepts: %s', (_label, code) => {
    expect(scanEnvelopeShapes('fixture.ts', code)).toEqual([]);
  });
});

describe('literal gates (belt to the AST scan)', () => {
  const files = walk(SRC);

  test("the 'Unknown error' fallback literal is gone from production source", () => {
    const hits: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (source.includes("'Unknown error'") || source.includes('"Unknown error"')) {
        hits.push(relative(SRC, file));
      }
    }
    expect(hits).toEqual([]);
  });

  test('a caught message with a substituted fallback appears only on the enumerated allowlist', () => {
    // WebhookService stores its own outbound-delivery failure text into a
    // root-plane self-configuration diagnostic column (the operator reading
    // their own webhook's delivery error about their own URL) — the one
    // deliberate retention (not a response sink; the AST gate confirms).
    const ALLOWED = new Set([join('services', 'WebhookService.ts')]);
    const patterns = [
      /(\w+) instanceof Error \? \1\.message : '[^']/,
      /(\w+) instanceof Error \? \1\.message : "[^"]/,
      /(\w+) instanceof Error \? \1\.message : String\(/,
    ];
    const hits: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (patterns.some((pattern) => pattern.test(source))) hits.push(relative(SRC, file));
    }
    expect(hits.filter((hit) => !ALLOWED.has(hit))).toEqual([]);
    expect(hits.length).toBeGreaterThanOrEqual(1); // the allowlist is real, not vacuous
  });

  test('message-substring dispatch is extinct in routes', () => {
    const routesDir = join(SRC, 'routes');
    const hits: string[] = [];
    for (const file of files.filter((f) => f.startsWith(routesDir + sep))) {
      const source = readFileSync(file, 'utf8');
      if (/\.message\.includes\(/.test(source) || /test\(message\)/.test(source)) {
        hits.push(relative(SRC, file));
      }
    }
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Behavioral proofs
// ---------------------------------------------------------------------------

describe('behavioral proof: thrown text never reaches the caller', () => {
  let server: ReturnType<typeof express.application.listen>;
  let base = '';
  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).principal = { id: '99999999-9999-4999-8999-999999999999', handle: 'qa', role: 'qa' };
      (req as any).scopes = ['tasks:read'];
      (req as any).userId = 'qa';
      (req as any).sessionRole = 'qa';
      next();
    });
    app.use('/tasks', tasksRouter);
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });
  afterAll((done) => { server.close(() => done()); });
  afterEach(() => { reviewerBehavior.runReview = null; });

  test('a failing read answers 500 with the fixed message, typed code, and errorId — and no caught detail', async () => {
    const response = await fetch(`${base}/tasks/notifications?unread=true`);
    const body = (await response.json()) as any;
    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      code: 'NOTIFICATIONS_READ_FAILED',
      error: 'Notifications could not be read',
    });
    expect(typeof body.errorId).toBe('string');
    expect(body.errorId.length).toBeGreaterThan(8);
    expect(JSON.stringify(body)).not.toContain('SECRET-DB-DETAIL');
  });

  test('a FOREIGN error carrying every dispatch phrase takes the fixed 500, never a sniffed status (review 3db17273 B4)', async () => {
    reviewerBehavior.runReview = async () => {
      throw new Error('driver secret: relation not found, cannot connect, already exists, execution profile');
    };
    const response = await fetch(`${base}/tasks/reviewer/00000000-0000-4000-8000-000000000000/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const body = (await response.json()) as any;
    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      code: 'VERIFIER_RUN_FAILED',
      error: 'The Verifier could not be run',
    });
    expect(typeof body.errorId).toBe('string');
    expect(JSON.stringify(body)).not.toContain('driver secret');
    expect(JSON.stringify(body)).not.toContain('relation');
  });

  test('POST /tasks keeps its base statuses: typed create-time faults take the fixed 500 (review 3db17273 r2 B1)', async () => {
    const { ForbiddenFault, ConflictFault } = jest.requireActual('../utils/httpErrors');
    const arms = [
      new ForbiddenFault('Only an independent Verifier identity can create a completed subtask'),
      new ForbiddenFault("Implementation agents cannot create a subtask with status 'completed'"),
      new ForbiddenFault('Only an independent Verifier identity can create a completed task'),
      new ConflictFault('A task can be completed only when every subtask is completed or skipped'),
    ];
    for (const fault of arms) {
      taskManagerBehavior.createTask = async () => { throw fault; };
      const response = await fetch(`${base}/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'parity probe' }),
      });
      const body = (await response.json()) as any;
      expect(response.status).toBe(500);
      expect(body).toMatchObject({
        success: false,
        code: 'TASK_CREATE_FAILED',
        error: 'The task could not be created',
      });
      expect(typeof body.errorId).toBe('string');
      expect(JSON.stringify(body)).not.toContain(fault.message);
    }
    taskManagerBehavior.createTask = null;
  });

  test('POST /tasks/:id/archive keeps its base 400 for a typed agent-role refusal, 404 for typed not-found (review 3db17273 r3 B1)', async () => {
    const { ForbiddenFault: FF, NotFoundFault: NF } = jest.requireActual('../utils/httpErrors');
    taskManagerBehavior.archiveTask = async () => { throw new FF("Implementation agents cannot move tasks to 'archived'"); };
    let response = await fetch(`${base}/tasks/00000000-0000-4000-8000-000000000000/archive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    let body = (await response.json()) as any;
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, code: 'TASK_ARCHIVE_FAILED', error: 'The task could not be archived' });
    expect(typeof body.errorId).toBe('string');
    expect(JSON.stringify(body)).not.toContain('Implementation agents');

    taskManagerBehavior.archiveTask = async () => { throw new NF('Task not found: 00000000-0000-4000-8000-000000000000', 'TASK_NOT_FOUND'); };
    response = await fetch(`${base}/tasks/00000000-0000-4000-8000-000000000000/archive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    body = (await response.json()) as any;
    expect(response.status).toBe(404);
    expect(body).toMatchObject({ success: false, code: 'TASK_NOT_FOUND' });
    taskManagerBehavior.archiveTask = null;
  });

  test('a typed NotFoundFault still answers 404 with its developer-authored message and code', async () => {
    reviewerBehavior.runReview = async () => {
      throw new NotFoundFault('Task not found: 00000000-0000-4000-8000-000000000000', 'TASK_NOT_FOUND');
    };
    const response = await fetch(`${base}/tasks/reviewer/00000000-0000-4000-8000-000000000000/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const body = (await response.json()) as any;
    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      success: false,
      code: 'TASK_NOT_FOUND',
      error: 'Task not found: 00000000-0000-4000-8000-000000000000',
    });
  });
});

describe('behavioral proof: /health failure envelope (review 3db17273 B2)', () => {
  test('a DB failure answers 500 with the fixed message, typed code, and errorId — no driver text', async () => {
    (pool.query as jest.Mock).mockRejectedValueOnce(new Error('ECONNREFUSED db-host:5432 secret-dsn'));
    const statusCapture: { code?: number; body?: any } = {};
    const res = {
      status(code: number) { statusCapture.code = code; return this; },
      json(body: unknown) { statusCapture.body = body; return this; },
    };
    await healthHandler({} as any, res as any);
    expect(statusCapture.code).toBe(500);
    expect(statusCapture.body).toMatchObject({
      status: 'unhealthy',
      database: 'disconnected',
      code: 'HEALTH_DATABASE_CHECK_FAILED',
      error: 'The database health check failed',
    });
    expect(typeof statusCapture.body.errorId).toBe('string');
    expect(JSON.stringify(statusCapture.body)).not.toContain('secret-dsn');
    expect(JSON.stringify(statusCapture.body)).not.toContain('ECONNREFUSED');
  });

  test('environment reflects NODE_ENV at CALL time, so dotenv-supplied values are honored (review 3db17273 r2 B4)', async () => {
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'dotenv-supplied-env';
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ now: '2026-08-22T00:00:00Z' }] });
      const statusCapture: { body?: any } = {};
      const res = {
        status() { return this; },
        json(body: unknown) { statusCapture.body = body; return this; },
      };
      await healthHandler({} as any, res as any);
      expect(statusCapture.body.environment).toBe('dotenv-supplied-env');
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});
