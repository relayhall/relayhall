/**
 * RH-P3.C4 — THE POSTURE GATE (Amendment S-A6; MCP design `de73f9f8` §1.3 as
 * amended; strategy `4e40f06f` §2.11 as amended).
 *
 * Asserts posture items **1–6**, and item **7** by pointing at the vehicle that
 * discharges it. Item 7 has two halves. The POSITIVE half — an exact mutating
 * retry converges — is card `fb06c930`'s: it needs a real PostgreSQL and the
 * production handler, so it lives in `idempotencyContract.test.ts` and this
 * file asserts that suite exists, cannot skip, and is wired to a script. The
 * PROHIBITION half binds here as it always did: no unqualified retry-safety
 * claim in any model-facing text, linted and pinned below. Nothing in this
 * file may be read as a retry-safety claim of its own.
 *
 * ── What round 2 taught this file (REJECT `7c2d4dbb`) ──
 *
 * Round 2 rejected the first version of this gate on five findings, four of
 * which were one mistake wearing different hats: **it asserted SYNTAX where
 * BEHAVIOUR was available, and syntax can be spelled around.** The reviewer
 * kept `sessionIdGenerator: undefined` exactly as expected, added
 * `['session' + 'IdGenerator']: () => 'review-minted-session'` beside it, and
 * this gate reported 25/25 green while the wire really did mint an
 * `Mcp-Session-Id`. It memoised the server behind a helper, cached the
 * transport on the router, put a dead `if (false) acceptPrincipalKey(…)`
 * ahead of the real call to satisfy an ordering check, and passed a literal
 * `'any'` to `acceptPrincipalKey` while the stamp declaration stayed the
 * expected literal. All green. None of that is a subtle defect in the tree;
 * all of it is a gate reading names instead of values.
 *
 * So this version does three things the first did not:
 *
 * 1. **It folds constants.** Every string the surface can produce statically —
 *    concatenations, template substitutions, both arms of a conditional — is
 *    evaluated before it is matched, and a property key computed from
 *    fragments is resolved to the key it actually is.
 * 2. **It censuses EFFECTIVE structure, not spellings.** The transport's
 *    option keys are resolved through spreads and conditionals to the exact
 *    set the transport really receives; a spread or computed key it cannot
 *    resolve is itself a violation, because an unreviewable option is not a
 *    reviewed one.
 * 3. **It runs the server.** Items 3 and 4 are now proven by driving two real
 *    requests through the real route and reading what actually happened:
 *    distinct server and transport objects per request, the real
 *    `acceptPrincipalKey` call ordered before construction by invocation
 *    order rather than by source order, and the transport class that was
 *    really passed to it. Dead code does not register an invocation, and a
 *    memoised server cannot produce two distinct objects.
 *
 * The static census stays, because behaviour proves what one path did on one
 * request and cannot prove the ABSENCE of state somewhere it never runs. The
 * two halves answer different questions and the gate needs both.
 *
 * ── Scope, stated so the boundary is reviewable ──
 *
 * The census covers `src/mcp/**`. It does NOT cover `PrincipalService`'s
 * caches and throttles, the Express-app memo, or the §4.2 rate limiter: S-A6
 * §10 names those as the class item 2 permits. What item 2 forbids is
 * caller-correlated state in the MCP transport. Because round 2 showed that
 * such state can be parked OUTSIDE this directory and written from inside it,
 * writes through imported bindings and through `globalThis` / `process` /
 * `require.cache` are censused here even though their storage is elsewhere.
 */
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import ts from 'typescript';
import { AddressInfo } from 'net';
import { Server } from '@modelcontextprotocol/server';

import {
  foldStrings, isFoldableNode, nestedInFoldable, readSurface, unwrap,
} from './support/astStrings';
import * as authModule from '../middleware/auth';
import * as serverModule from '../mcp/server';
import mcpRoutes from '../mcp/httpRoute';
import { MCP_ROUTE_PATH } from '../mcp/httpRoute';
import { MCP_TRANSPORT_STAMP } from '../mcp/provenance';
import { principalService, type Principal, type PrincipalCredential } from '../services/PrincipalService';

const mcpDir = path.join(__dirname, '..', 'mcp');

/** Every `.ts` under the surface, including subdirectories. */
const surfaceSources = (): Array<{ file: string; source: string }> => readSurface(mcpDir);

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.ES2020, /* setParentNodes */ true);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

// Constant folding lives in `support/astStrings`, shared with the revision
// gate. Round 2's B1 and B4 were the same trick in two files — write the value
// you want as an expression rather than as a literal — so both gates resolve
// strings the same way, from one source that cannot drift.

/** A stable, reviewable name for one expression's shape. */
function shapeOf(node: ts.Node): string {
  const target = unwrap(node);
  if (ts.isNewExpression(target)) return `new ${target.expression.getText()}()`;
  if (ts.isObjectLiteralExpression(target)) return '{}';
  if (ts.isArrayLiteralExpression(target)) return '[]';
  if (ts.isSpreadElement(target)) return '...<spread>';
  if (ts.isCallExpression(target)) {
    const callee = unwrap(target.expression);
    if (ts.isIdentifier(callee)) return `${callee.text}()`;
    if (ts.isPropertyAccessExpression(callee)) return `${shapeOf(callee.expression)}.${callee.name.text}()`;
    // An IIFE is a container factory wearing a disguise: `(() => { … })()`
    // returns whatever it closed over, and that closure lives as long as the
    // module does. Naming it makes it state-bearing like any other call.
    if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) return '<iife>()';
    return '<call>';
  }
  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) return '<function>';
  if (ts.isIdentifier(target)) return target.text;
  if (foldStrings(target).length > 0) return '<literal>';
  if (target.kind === ts.SyntaxKind.TrueKeyword || target.kind === ts.SyntaxKind.FalseKeyword
    || target.kind === ts.SyntaxKind.NullKeyword) return '<literal>';
  return ts.SyntaxKind[target.kind];
}

/** The nearest named enclosing function, or `<module>` for top-level code. */
function enclosingFunction(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text ?? '<anonymous>';
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      return '<anonymous>';
    }
    current = current.parent;
  }
  return '<module>';
}

/** True when this function is invoked where it is written: `(() => …)()`. */
function isImmediatelyInvoked(fn: ts.Node): boolean {
  let candidate: ts.Node = fn;
  while (candidate.parent && ts.isParenthesizedExpression(candidate.parent)) candidate = candidate.parent;
  const parent = candidate.parent;
  return !!parent && ts.isCallExpression(parent) && unwrap(parent.expression) === unwrap(fn);
}

/**
 * The scope whose LIFETIME this node inherits.
 *
 * Round-2 verdict `f14da2c1` B2: a `Map` built inside a module-level IIFE is
 * `<anonymous>` to `enclosingFunction`, so a check keyed on names read it as
 * per-call state. It is not — an IIFE runs at module load and what it closes
 * over lives as long as the module. Anything reached only through immediately
 * invoked functions therefore has module lifetime, whatever it is called.
 */
function lifetimeScope(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)
      || ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (!isImmediatelyInvoked(current)) return enclosingFunction(node);
    }
    current = current.parent;
  }
  return '<module>';
}

// ══════════════════════════════ the census ══════════════════════════════

export interface StateBinding { file: string; name: string; kind: 'let' | 'var' | 'const'; shape: string }
export interface Sited { file: string; form: string; enclosing: string }
export interface ConstructionSite { file: string; what: string; enclosing: string }
export interface OptionEntry { key: string; value: string }

export interface PostureCensus {
  /** Item 2: module-level bindings that can hold something between requests. */
  state: StateBinding[];
  /** Item 2: writes to module-level, imported, or ambient state. */
  writes: Sited[];
  /** Item 2: keyed containers, at every scope, with the scope that builds them. */
  containers: Sited[];
  /** Item 1: anything in the surface that resolves to an MCP session identifier. */
  sessionTouches: Sited[];
  /** Items 1/6: the option keys the transport EFFECTIVELY receives. */
  transportOptions: OptionEntry[];
  /** Item 3: where a protocol server or transport is constructed. */
  construction: ConstructionSite[];
  /** Item 5: the JSON-RPC methods the surface handles itself. */
  requestHandlers: string[];
  /** Item 6: the capabilities the protocol server declares. */
  serverCapabilities: string[];
  /**
   * Item 5: what the per-call context carries, KEY AND VALUE.
   *
   * Round-2 verdict `f14da2c1` B4: checking key names alone accepts
   * `authorization: req.body?.params?.clientInfo?.authorization ?? authorization`
   * — the key set is identical and caller-supplied handshake metadata is now
   * the credential. Item 5 is about where authority comes FROM, so the value
   * is the half that matters.
   */
  callContextKeys: Array<{ file: string; entries: OptionEntry[] }>;
  /** Item 4: the guard chain the in-process ingress puts on every route. */
  ingressRegistrations: string[][];
  /** Item 4: how the transport stamp is produced. */
  stampShape: string;
  /** Item 4: every transport-class argument passed to acceptPrincipalKey. */
  stampArguments: Sited[];
  /** Item 6: calls implying a server-initiated or held-open exchange. */
  streamCalls: Sited[];
  /** Any property access the gate cannot resolve to a name. */
  unresolvedAccess: Sited[];
  /**
   * Functions reachable ONLY from a once-per-server scope, and therefore once
   * per server themselves. Round-3 verdict `5cb6ff8a` B2 moved a `new Map()`
   * one helper call away from `buildMcpServer` and the lifetime rule, which
   * read a hand-written list of scope names, lost sight of it.
   */
  serverLifetimeFunctions: Array<{ file: string; name: string }>;
}

const SESSION_NAME = /session[\s_-]*id/i;
const STATE_BEARING = /^(\{\}|\[\]|new .+\(\)|<uninitialized>|.+\(\))$/;
const CONSTRUCTED = new Set([
  'buildMcpServer', 'Server', 'WebStandardStreamableHTTPServerTransport', 'StdioServerTransport',
]);
const STREAM_CALLS = new Set([
  'setInterval', 'setImmediate', 'sendLoggingMessage', 'createMessage',
  'elicitInput', 'sendNotification', 'notification', 'sendResourceUpdated',
]);
const MUTATING_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin',
  'set', 'add', 'delete', 'clear', 'assign', 'defineProperty', 'setPrototypeOf',
]);
/**
 * Roots that are ambient process state: a write here escapes any directory.
 * `Object` and `Reflect` are here for the prototype route — round-3 verdict
 * `5cb6ff8a` B2 put cross-caller state on `Object.prototype`.
 */
const AMBIENT_ROOTS = new Set([
  'globalThis', 'global', 'process', 'require', 'module', 'Object', 'Reflect',
]);
/** Calls that read a property by a computed name, the way an index access does. */
const REFLECTIVE_READS = new Set(['get', 'has', 'getOwnPropertyDescriptor', 'getOwnPropertyNames']);
const KEYED_CONTAINER_CLASSES = ['Map', 'Set', 'WeakMap', 'WeakSet'];

/** Property key names this element resolves to; `<computed>` when it cannot. */
function keyNames(property: ts.ObjectLiteralElementLike): string[] {
  const name = property.name;
  if (!name) return [];
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return [name.text];
  if (ts.isComputedPropertyName(name)) {
    const folded = foldStrings(name.expression);
    return folded.length > 0 ? folded : ['<computed:unresolved>'];
  }
  return ['<computed:unresolved>'];
}

/**
 * The keys and values an object literal EFFECTIVELY carries, resolved through
 * spreads and conditionals. A spread it cannot resolve yields one
 * `<spread:unresolved>` entry — an option set the gate cannot read is not a
 * reviewed option set, and saying so is the point.
 */
export function effectiveEntries(node: ts.Node): OptionEntry[] {
  const target = unwrap(node);
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property) => {
      if (ts.isSpreadAssignment(property)) return effectiveEntries(property.expression);
      const value = ts.isPropertyAssignment(property) ? shapeOf(property.initializer)
        : ts.isShorthandPropertyAssignment(property) ? property.name.text
          : '<function>';
      return keyNames(property).map((key) => ({ key, value }));
    });
  }
  if (ts.isConditionalExpression(target)) {
    return [...effectiveEntries(target.whenTrue), ...effectiveEntries(target.whenFalse)];
  }
  return [{ key: '<spread:unresolved>', value: shapeOf(target) }];
}

export function censusPosture(sources: Array<{ file: string; source: string }>): PostureCensus {
  const census: PostureCensus = {
    state: [], writes: [], containers: [], sessionTouches: [], transportOptions: [],
    construction: [], requestHandlers: [], serverCapabilities: [], callContextKeys: [],
    ingressRegistrations: [], stampShape: '<absent>', stampArguments: [], streamCalls: [],
    unresolvedAccess: [], serverLifetimeFunctions: [],
  };

  for (const { file, source } of sources) {
    const sourceFile = parse(file, source);

    // Names a write has to target to be a write to state that outlives a call:
    // module-level declarations AND anything imported, because round 2 parked
    // the store in another module and wrote to it from here.
    const reachable = new Set<string>();
    for (const statement of sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        const flags = statement.declarationList.flags;
        // eslint-disable-next-line no-bitwise
        const kind: StateBinding['kind'] = flags & ts.NodeFlags.Let ? 'let'
          // eslint-disable-next-line no-bitwise
          : flags & ts.NodeFlags.Const ? 'const' : 'var';
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          reachable.add(declaration.name.text);
          const shape = declaration.initializer ? shapeOf(declaration.initializer) : '<uninitialized>';
          if (kind === 'const' && !STATE_BEARING.test(shape)) continue;
          census.state.push({ file, name: declaration.name.text, kind, shape });
        }
      }
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause;
        if (clause.name) reachable.add(clause.name.text);
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) reachable.add(clause.namedBindings.name.text);
          else for (const element of clause.namedBindings.elements) reachable.add(element.name.text);
        }
      }
    }

    // Round-3 verdict `5cb6ff8a` B2: `const g = globalThis; g.x = caller;`
    // writes to ambient state through a name the census had never heard of.
    // So a LOCAL binding initialised from something already reachable is
    // itself reachable — one pass is enough for the aliasing that matters,
    // and aliasing an alias is caught by the same rule on the next pass.
    for (let pass = 0; pass < 3; pass += 1) {
      walk(sourceFile, (node) => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
        if (!node.initializer) return;
        const source0 = unwrap(node.initializer);
        const base = ts.isIdentifier(source0) ? source0.text
          : ts.isPropertyAccessExpression(source0) || ts.isElementAccessExpression(source0)
            ? (() => {
              let current: ts.Node = source0;
              while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
                current = unwrap(current.expression);
              }
              return ts.isIdentifier(current) ? current.text : undefined;
            })()
            : undefined;
        if (base && (reachable.has(base) || AMBIENT_ROOTS.has(base))) reachable.add(node.name.text);
      });
    }

    // ── which local functions run once per SERVER, transitively ──
    const callsFrom = new Map<string, Set<string>>();
    const localFunctions = new Set<string>();
    walk(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name) localFunctions.add(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && (ts.isArrowFunction(unwrap(node.initializer)) || ts.isFunctionExpression(unwrap(node.initializer)))) {
        localFunctions.add(node.name.text);
      }
    });
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(unwrap(node.expression))) return;
      const callee = (unwrap(node.expression) as ts.Identifier).text;
      if (!localFunctions.has(callee)) return;
      const caller = enclosingFunction(node);
      if (!callsFrom.has(caller)) callsFrom.set(caller, new Set());
      callsFrom.get(caller)!.add(callee);
    });
    const serverLifetime = new Set<string>(SERVER_LIFETIME_SCOPES[file] ?? []);
    for (let pass = 0; pass < 8; pass += 1) {
      for (const root of [...serverLifetime]) {
        for (const callee of callsFrom.get(root) ?? []) serverLifetime.add(callee);
      }
    }
    for (const name of serverLifetime) {
      if (!(SERVER_LIFETIME_SCOPES[file] ?? []).includes(name)) {
        census.serverLifetimeFunctions.push({ file, name });
      }
    }

    const rootOf = (node: ts.Node): string | undefined => {
      let current: ts.Node = unwrap(node);
      while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        current = unwrap(current.expression);
      }
      return ts.isIdentifier(current) ? current.text : undefined;
    };
    const noteWrite = (target: ts.Node, form: string, at: ts.Node): void => {
      const root = rootOf(target);
      if (!root) return;
      if (!reachable.has(root) && !AMBIENT_ROOTS.has(root)) return;
      census.writes.push({ file, form, enclosing: lifetimeScope(at) });
    };

    walk(sourceFile, (node) => {
      // ── item 2: writes to reachable or ambient state ──
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && MUTATING_METHODS.has(node.expression.name.text)) {
        const receiver = unwrap(node.expression.expression);
        const method = node.expression.name.text;
        if (ts.isIdentifier(receiver) && (receiver.text === 'Object' || receiver.text === 'Reflect')) {
          // `Object.assign(target, …)` writes to its FIRST ARGUMENT.
          const first = node.arguments[0];
          if (first) noteWrite(first, `${receiver.text}.${method}(${shapeOf(first)}, …)`, node);
        } else {
          noteWrite(receiver, `${shapeOf(receiver)}.${method}()`, node);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = unwrap(node.left);
        if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
          noteWrite(left, `${left.getText().replace(/\s+/g, ' ')} = …`, node);
        } else if (ts.isIdentifier(left) && reachable.has(left.text)) {
          census.writes.push({
            file, form: `${left.text} = ${shapeOf(node.right)}`, enclosing: lifetimeScope(node),
          });
        }
      }

      // ── item 2: keyed containers, at every scope ──
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
        && KEYED_CONTAINER_CLASSES.includes(node.expression.text)) {
        census.containers.push({
          file, form: `new ${node.expression.text}()`, enclosing: lifetimeScope(node),
        });
      }

      // ── item 1: anything that RESOLVES to an MCP session identifier ──
      const noteSession = (form: string): void => {
        census.sessionTouches.push({ file, form, enclosing: enclosingFunction(node) });
      };
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        for (const key of keyNames(node)) {
          if (SESSION_NAME.test(key)) {
            const value = ts.isPropertyAssignment(node) ? shapeOf(node.initializer) : node.name.text;
            noteSession(`${key}: ${value}`);
          }
        }
      } else if (ts.isPropertyAccessExpression(node) && SESSION_NAME.test(node.name.text)) {
        noteSession(node.getText().replace(/\s+/g, ' '));
      } else if (ts.isIdentifier(node) && SESSION_NAME.test(node.text)
        && !(node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node)
        && !(node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
        && !(node.parent && ts.isComputedPropertyName(node.parent))) {
        noteSession(node.text);
      } else if (isFoldableNode(node)) {
        // Folded, so `'mcp-' + 'session' + '-id'` is the same as writing it
        // out. Only at the OUTERMOST foldable node, or every sub-expression
        // reports the same value again.
        if (!nestedInFoldable(node)) {
          for (const value of foldStrings(node)) {
            if (SESSION_NAME.test(value)) noteSession(`'${value}'`);
          }
        }
      }

      // Round-3 verdict `5cb6ff8a` B1: `Reflect.get(req.headers, key)` is an
      // index access wearing a call's clothes.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && REFLECTIVE_READS.has(node.expression.name.text)
        && ts.isIdentifier(unwrap(node.expression.expression))
        && AMBIENT_ROOTS.has((unwrap(node.expression.expression) as ts.Identifier).text)) {
        const key = node.arguments[1];
        const folded = key ? foldStrings(key) : [];
        for (const value of folded) {
          if (SESSION_NAME.test(value)) noteSession(`${node.expression.name.text}(…, ${JSON.stringify(value)})`);
        }
        if (key && folded.length === 0) {
          census.unresolvedAccess.push({
            file, form: node.getText().replace(/\s+/g, ' ').slice(0, 100), enclosing: enclosingFunction(node),
          });
        }
      }

      // ── a property access the gate cannot resolve is not reviewable ──
      if (ts.isElementAccessExpression(node)) {
        const root = rootOf(node);
        const argument = node.argumentExpression;
        const folded = argument ? foldStrings(argument) : [];
        const isIndexed = argument !== undefined && ts.isNumericLiteral(unwrap(argument));
        if (folded.length === 0 && !isIndexed && root && (reachable.has(root) || AMBIENT_ROOTS.has(root)
          || /header|req|request/i.test(root))) {
          census.unresolvedAccess.push({
            file, form: node.getText().replace(/\s+/g, ' '), enclosing: enclosingFunction(node),
          });
        }
        for (const value of folded) {
          if (SESSION_NAME.test(value)) noteSession(`[${JSON.stringify(value)}]`);
        }
      }

      // ── item 3: construction sites, and where they sit ──
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
        && CONSTRUCTED.has(node.expression.text)) {
        census.construction.push({
          file, what: `new ${node.expression.text}()`, enclosing: enclosingFunction(node),
        });
        if (node.expression.text === 'WebStandardStreamableHTTPServerTransport') {
          const options = node.arguments?.[0];
          if (options) census.transportOptions = effectiveEntries(options);
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        if (CONSTRUCTED.has(callee)) {
          census.construction.push({ file, what: `${callee}()`, enclosing: enclosingFunction(node) });
          const factory = node.arguments[0];
          const literal = factory && returnedObject(factory);
          if (literal) census.callContextKeys.push({ file, entries: effectiveEntries(literal) });
        }
        if (STREAM_CALLS.has(callee)) {
          census.streamCalls.push({ file, form: `${callee}()`, enclosing: enclosingFunction(node) });
        }
        // ── item 4: every transport class handed to the shared acceptance ──
        if (callee === 'acceptPrincipalKey') {
          const stamp = node.arguments[3];
          census.stampArguments.push({
            file, form: stamp ? shapeOf(stamp) : '<missing>', enclosing: enclosingFunction(node),
          });
        }
        if (callee === 'registerProtectedRoutes') {
          const callback = node.arguments[0];
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            walk(callback, (inner) => {
              if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)
                && inner.expression.name.text === 'use') {
                census.ingressRegistrations.push(inner.arguments.map(shapeOf));
              }
            });
          }
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && STREAM_CALLS.has(node.expression.name.text)) {
        census.streamCalls.push({
          file,
          form: `${shapeOf(node.expression.expression)}.${node.expression.name.text}()`,
          enclosing: enclosingFunction(node),
        });
      }
      // Round-2 verdict `f14da2c1` B5: `const heartbeat = setInterval;` then
      // `heartbeat(…)` evades a check that only looks at callee names. So the
      // census records every REFERENCE to a forbidden primitive, in any
      // position — naming one at all is the reviewable event.
      if (ts.isIdentifier(node) && STREAM_CALLS.has(node.text)
        && !(node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
        && !(node.parent && (ts.isPropertyAssignment(node.parent) || ts.isShorthandPropertyAssignment(node.parent))
          && node.parent.name === node)
        && !(node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        census.streamCalls.push({
          file, form: `${node.text} (referenced, not called here)`, enclosing: enclosingFunction(node),
        });
      }

      // ── item 5: the JSON-RPC methods the surface answers itself ──
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'setRequestHandler') {
        // SDK v2 registers by METHOD NAME; the name is folded so a handler
        // registered as `'tools/' + 'list'` or `'initialize'` reads the same.
        const method = node.arguments[0];
        const folded = method ? foldStrings(method) : [];
        census.requestHandlers.push(folded.length === 1 ? folded[0] : method ? shapeOf(method) : '<none>');
      }

      // ── item 6: declared capabilities ──
      if (file === 'server.ts' && ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)
        && node.name.text === 'capabilities' && ts.isObjectLiteralExpression(node.initializer)) {
        census.serverCapabilities = effectiveEntries(node.initializer).map((entry) => entry.key);
      }

      // ── item 4: the stamp declaration ──
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.name.text === 'MCP_TRANSPORT_STAMP') {
        census.stampShape = node.initializer
          ? `${ts.SyntaxKind[unwrap(node.initializer).kind]} ${shapeOf(node.initializer)}`
          : '<uninitialized>';
      }
    });
  }

  return census;
}

/** Unwrap `(x) => ({ … })` / `(x) => { return { … } }` to the object literal. */
function returnedObject(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  const target = unwrap(node);
  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
    const body = unwrap(target.body);
    if (ts.isObjectLiteralExpression(body)) return body;
    if (ts.isBlock(body)) {
      for (const statement of body.statements) {
        if (ts.isReturnStatement(statement) && statement.expression) {
          const value = unwrap(statement.expression);
          if (ts.isObjectLiteralExpression(value)) return value;
        }
      }
    }
  }
  return undefined;
}

// ═══════════════════════════ the expected surface ═══════════════════════════

/**
 * EVERY module-level binding in the surface that can hold something between
 * requests, in file order. Spelled out rather than derived: adding state to a
 * surface ratified as stateless is a review event, and this is where a
 * reviewer sees it happen.
 */
const EXPECTED_STATE: StateBinding[] = [
  // RH-P3.C4 (ii): the fail-closed gate exempt planes. A two-element array of
  // string literals with no caller input anywhere near it — deliberately not a
  // Set, because a keyed container at module scope is what item 2 forbids and
  // this gate should not need a carve-out to exist. (`readonly` is a
  // compile-time constraint, not Object.freeze — review c4409291 corrected an
  // earlier comment here that said "frozen" and overstated that.)
  { file: 'bootstrapGate.ts', name: 'BOOTSTRAP_EXEMPT_PLANES', kind: 'const', shape: '[]' },
  { file: 'httpRoute.ts', name: 'router', kind: 'const', shape: 'Router()' },
  { file: 'inProcess.ts', name: 'internalApp', kind: 'let', shape: '<uninitialized>' },
  { file: 'provenance.ts', name: 'UNAUTHORIZED', kind: 'const', shape: '{}' },
  { file: 'registry.ts', name: 'RESOURCE_KINDS', kind: 'const', shape: '[]' },
  { file: 'registry.ts', name: 'RESOURCE_DETAIL_VARIANTS', kind: 'const', shape: '{}' },
  { file: 'registry.ts', name: 'RESOURCE_BODY_KEYS', kind: 'const', shape: '[]' },
  { file: 'registry.ts', name: 'REPORT_HANDOVER_SCHEMA', kind: 'const', shape: '{}' },
  { file: 'registry.ts', name: 'TASK_DUE_AT_SCHEMA', kind: 'const', shape: '{}' },
  { file: 'registry.ts', name: 'PROJECT_REVISION_SCHEMA', kind: 'const', shape: '{}' },
  // Card fb06c930: the retry-token schema fragment and the per-tool retry
  // sentences, in source order. Both are `const` tables with no caller input
  // anywhere near them — the same shape as every other schema constant here.
  { file: 'registry.ts', name: 'IDEMPOTENCY_KEY_SCHEMA', kind: 'const', shape: '{}' },
  // Card 510cd72c: the execution-profile and Warrant schema fragments,
  // shared by `relayhall_task_create` and `relayhall_task_recover` so one
  // contract is described once. Same shape as every other schema constant
  // here — a `const` object literal with no caller input near it.
  { file: 'registry.ts', name: 'EXECUTION_PROFILE_SCHEMA', kind: 'const', shape: '{}' },
  { file: 'registry.ts', name: 'EXECUTION_WARRANT_SCHEMA', kind: 'const', shape: '{}' },
  { file: 'registry.ts', name: 'BLUEPRINT_TARGET_SCHEMA', kind: 'const', shape: '{}' },
  { file: 'registry.ts', name: 'BLUEPRINT_REQUEST_PROPERTIES', kind: 'const', shape: '{}' },
  { file: 'registry.ts', name: 'BLUEPRINT_UUID_SCHEMA', kind: 'const', shape: '{}' },
  { file: 'registry.ts', name: 'BLUEPRINT_SETUP_TASKS_SCHEMA', kind: 'const', shape: '{}' },
  { file: 'registry.ts', name: 'BLUEPRINT_SETUP_PROPERTIES', kind: 'const', shape: '{}' },
  { file: 'registry.ts', name: 'MCP_TOOLS', kind: 'const', shape: '[]' },
  { file: 'registry.ts', name: 'RETRY_CONTRACT_SENTENCES', kind: 'const', shape: '{}' },
  { file: 'registry.ts', name: 'REMOVED_V1_TOOLS', kind: 'const', shape: '[]' },
  { file: 'server.ts', name: 'MCP_SERVER_INFO', kind: 'const', shape: '{}' },
  { file: 'server.ts', name: 'INSTRUCTIONS', kind: 'const', shape: '[].join()' },
  { file: 'shape.ts', name: 'READ_TOOL_PROPERTIES', kind: 'const', shape: '{}' },
  { file: 'shape.ts', name: 'CONTINUE_FROM_PROPERTY', kind: 'const', shape: '{}' },
];

/** The only module-level bindings allowed to be mutable, and why. */
const DECLARED_PROCESS_STATE: Record<string, string> = {
  'inProcess.ts:internalApp':
    'the memoised internal Express app — built from the immutable route registry with no caller input (item 2 carve-out; S-A6 §10)',
};

/**
 * DURABLE state the surface is permitted under posture item 2's carve-out —
 * database TABLES, not module state, so it is a separate register from
 * DECLARED_PROCESS_STATE (card fb06c930, design record bf8928ee v5 §3.13).
 * Each entry states why the table cannot bypass current authorization and
 * cross-contaminates nothing.
 */
const DECLARED_DURABLE_STATE: Record<string, string> = {
  mcp_bootstrap_records:
    'credential-keyed bootstrap TTL records (C4 ii) — expire, cannot bypass authorization, one row per credential',
  operation_idempotency_records:
    'operation retry records (fb06c930) — scope-keyed, expire, served only behind the same guard chain, and refuse-policy rows store no response at all',
};

/**
 * The enumerated writers of each declared table. Asserted in BOTH directions
 * against a SINK-ANCHORED census: the scan finds every module under
 * `backend/src` whose SQL text writes the table, so a new writer in a new
 * module is a violation rather than an omission a curated list would miss.
 */
const DECLARED_DURABLE_WRITERS: Record<string, string[]> = {
  mcp_bootstrap_records: ['services/McpBootstrapService.ts'],
  operation_idempotency_records: ['middleware/idempotency.ts'],
};

/**
 * The ONLY writes to reachable state the surface may make, keyed by the scope
 * that makes them. The scope is part of the key on purpose: the same call from
 * inside a request is a different key, and a violation.
 */
const DECLARED_WRITES: Record<string, string> = {
  'httpRoute.ts:<module>:router.delete()':
    "Express route registration for the spec's DELETE, made once at module load — the SDK answers it and there is no MCP session to tear down",
  'inProcess.ts:getInternalApp:internalApp = app':
    'the memo being filled once, from an app built with no caller input',
  'inProcess.ts:resetInternalApp:internalApp = undefined':
    'the test seam that drops the memo',
  'stdio.ts:main:process.exitCode = …':
    'the stdio entry setting its own process exit code on a bad credential — process lifecycle, not caller state',
  'stdio.ts:<anonymous>:process.exitCode = …':
    'the same, from the top-level failure handler',
};

/**
 * The dynamic property reads the surface is allowed to make. Round 2 read an
 * MCP session header through a name assembled from fragments, so a read the
 * gate cannot resolve is a violation by default — but a lookup into an
 * immutable schema table by its own discriminator is not that, and saying
 * which is which explicitly beats weakening the rule until it stops noticing.
 */
const DECLARED_DYNAMIC_READS: Record<string, string> = {
  'registry.ts:<anonymous>:RESOURCE_DETAIL_VARIANTS[kind]':
    'the per-kind branch of the Resource write schema, selected by its own discriminator — an immutable table, no caller identity involved',
};

/**
 * Scopes that run ONCE PER SERVER rather than once per call. A container built
 * in one of these outlives every request that server serves — over stdio, the
 * whole process. `<module>` is implicitly one of them.
 */
const SERVER_LIFETIME_SCOPES: Record<string, string[]> = {
  'server.ts': ['buildMcpServer'],
  'inProcess.ts': ['getInternalApp'],
  'stdio.ts': ['main'],
};

const CALLER_CORRELATED_NAME = /(credential|principal|caller|client|token|session|subject|tenant|cache|scratch|pending|inflight|store|state)/i;
const KEYED_CONTAINER = /^new (Map|Set|WeakMap|WeakSet)\(\)$/;

const EXPECTED_SESSION_TOUCHES: Sited[] = [
  // The ONE permitted mention: the property that switches session ids OFF.
  { file: 'httpRoute.ts', form: 'sessionIdGenerator: undefined', enclosing: 'handle' },
];

/**
 * The exact option set the Streamable HTTP transport receives, resolved
 * through every spread and conditional. An option the gate cannot resolve is
 * itself a violation — round 2 hid a session generator inside a spread.
 */
const EXPECTED_TRANSPORT_OPTIONS: OptionEntry[] = [
  { key: 'sessionIdGenerator', value: 'undefined' },
  { key: 'enableJsonResponse', value: '<literal>' },
  { key: 'enableDnsRebindingProtection', value: '<literal>' },
  { key: 'allowedOrigins', value: 'allowedOrigins()' },
  { key: 'allowedHosts', value: 'allowedHosts()' },
];

/**
 * The read plane, driven in full by the isolation probe. Spelled out rather
 * than derived so the probe's SCOPE is a reviewed list, and asserted against
 * the live registry so it cannot silently fall behind it.
 */
const READ_PLANE_TOOLS = [
  'relayhall_principal_whoami', 'relayhall_access_preview', 'relayhall_warrant_list',
  'relayhall_principal_list', 'relayhall_task_list', 'relayhall_task_get',
  'relayhall_task_reference_list', 'relayhall_brief_compile', 'relayhall_report_search',
  'relayhall_report_get', 'relayhall_project_list', 'relayhall_project_get',
  'relayhall_project_resource_list', 'relayhall_project_resource_get',
  'relayhall_project_context_get', 'relayhall_charter_get', 'relayhall_phase_list',
  'relayhall_phase_get', 'relayhall_skill_list', 'relayhall_skill_get',
  'relayhall_personality_list', 'relayhall_service_list', 'relayhall_service_get',
];

/**
 * The mutating plane, which the probe does NOT drive: a unit-scope probe must
 * not write to the board to find out whether reads are isolated. Excluded for
 * that reason and no other, and listed so the exclusion is reviewable and the
 * partition above is exhaustive.
 */
const MUTATING_TOOLS_NOT_PROBED = [
  // Ratified companion5.3 classifies all four Blueprint tools as work.
  // Their caller forwarding/read isolation is asserted in mcpBlueprintContract.
  'relayhall_blueprint_list', 'relayhall_blueprint_get',
  'relayhall_blueprint_preview', 'relayhall_blueprint_instantiate',
  // Owner decision9fc7fad4 adds the separate, explicitly confirmed setup pair.
  'relayhall_blueprint_setup_preview', 'relayhall_blueprint_setup',
  'relayhall_task_create', 'relayhall_task_update', 'relayhall_task_move',
  'relayhall_subtask_set', 'relayhall_task_stream_append', 'relayhall_task_finish',
  'relayhall_task_reference_create', 'relayhall_review_run', 'relayhall_review_reject',
  'relayhall_task_claim', 'relayhall_task_release', 'relayhall_task_recover',
  'relayhall_lease_claim', 'relayhall_lease_renew', 'relayhall_lease_release',
  'relayhall_report_create', 'relayhall_report_update', 'relayhall_project_create',
  'relayhall_project_update', 'relayhall_project_archive', 'relayhall_project_restore',
  'relayhall_project_resource_create', 'relayhall_project_resource_update',
  'relayhall_project_resource_archive', 'relayhall_project_resource_restore',
  'relayhall_project_resource_replace', 'relayhall_agent_mint', 'relayhall_agent_reveal',
  'relayhall_agent_revoke',
];

/**
 * A digest over ALL model-facing text this surface ships: the server
 * INSTRUCTIONS (the one thing a harness reads before its first call — review
 * `39f1ca2d` B2 put a retry promise exactly there) and every tool description,
 * exactly as the registry exposes them. Pinned so ANY wording change — retry-
 * safety promise or not, trigger word or none — turns the gate red and reaches
 * a human diff. Update it only alongside the wording change it covers.
 */
// Moved at RH-P3.C4 integration (ii): the INSTRUCTIONS now open with the
// bootstrap call, and relayhall_brief_compile's description gained its
// fourth altitude. Both are text a harness acts on before its first call,
// which is exactly why they are pinned rather than merely reviewed once.
//
// Moved again at card fb06c930: every mutating tool's description gained its
// RETRY CONTRACT sentence, and eight create-shaped tools gained the retry-token
// parameter. That is the largest single change to model-facing text since the
// surface was written — a model reading it now decides whether to repeat a
// mutation on the strength of these sentences — so the digest bump is the
// review event this pin exists to create. It is not a number edited to make a
// test pass: the property behind it is asserted directly below (every sentence
// present, none of them making a prohibited claim), and the sentences
// themselves are measured against a real database by
// `idempotencyContract.test.ts`.
//
// Moved again at SETGOV candidate A (card `bbec04de`), for ONE description:
// `relayhall_access_preview`. That tool declares no scope of its own and
// proxies `GET /principals/me/effective-access`, whose ceiling `D-5` moves from
// `principals:read` to `authenticated` (AZ-A5 clause 9b, accepted by owner
// ruling `dda2cdcc` §1) — so the tool became reachable to bearer callers that
// received 403 before. That widening is DECLARED (design §11 / candidate A's
// evidence report) and the description now says so.
//
// …and again at card fb06c930's REBASE onto that work: this candidate's own
// sentences and SETGOV's are in the manifest together for the first time, so
// the pin is re-derived from a live run rather than arithmetic on two numbers.
//
// Moved again at card `510cd72c`, for ONE description: `relayhall_task_recover`.
// That tool could not perform a recovery — it advertised `task`, `reason` and
// `assignTo` while the route REQUIRES `executionProfile` and never reads
// `assignTo`, so every schema-valid call was refused before it began. The
// description now says the profile is required and what omitting it answers,
// which is a change to what a model believes it can do — exactly the class
// this pin exists to put in front of a person. The behaviour behind the new
// sentence is drilled through the tool against the real route in
// `mcpTaskRecoverContract.test.ts`, so the digest is not the only evidence
// that it is true. Re-derived from a live run.
const MODEL_FACING_TEXT_DIGEST = 'sha256-7cdf86fdf59b6ff9f27d0f8c676d37bbe1edca4192198055551216f4bee43d62';

const EXPECTED_REQUEST_HANDLERS = ['tools/list', 'tools/call'];
/**
 * Key AND value. `authorization` must be the request's own `authorization`
 * binding and nothing else — not a value derived from it, not a fallback, and
 * certainly not something read out of the JSON-RPC body.
 */
const EXPECTED_CALL_CONTEXT: OptionEntry[] = [
  { key: 'authorization', value: 'authorization' },
  { key: 'toolName', value: 'toolName' },
];
const describeEntries = (entries: OptionEntry[]): string =>
  entries.map((entry) => `${entry.key}=${entry.value}`).join(', ');
const EXPECTED_INGRESS_GUARDS = ['path', 'mcpAuthMiddleware', 'sharedAuthorizationMiddleware', '...<spread>'];

// ═════════════════════════════ the classifier ═════════════════════════════

/** The keyed containers whose scope outlives a request. */
export function serverLifetimeContainers(census: PostureCensus): Sited[] {
  const transitive = new Set(census.serverLifetimeFunctions.map((fn) => `${fn.file}:${fn.name}`));
  return census.containers.filter((container) => container.enclosing === '<module>'
    || (SERVER_LIFETIME_SCOPES[container.file] ?? []).includes(container.enclosing)
    || transitive.has(`${container.file}:${container.enclosing}`));
}

export function classifyPosture(census: PostureCensus): string[] {
  const violations: string[] = [];

  // ── item 1 — no MCP session identifier is minted, read or branched on ──
  const permitted = new Set(EXPECTED_SESSION_TOUCHES.map((t) => `${t.file}:${t.enclosing}:${t.form}`));
  for (const touch of census.sessionTouches) {
    if (permitted.has(`${touch.file}:${touch.enclosing}:${touch.form}`)) continue;
    violations.push(`[item 1] ${touch.file} resolves an MCP session identifier in \`${touch.enclosing}\`: ${touch.form}`);
  }
  for (const expected of EXPECTED_SESSION_TOUCHES) {
    if (!census.sessionTouches.some((touch) => touch.form === expected.form)) {
      violations.push(`[item 1] ${expected.file} no longer disables session ids with \`${expected.form}\` — statelessness is not the default`);
    }
  }
  const optionKey = (entry: OptionEntry): string => `${entry.key}=${entry.value}`;
  if (census.transportOptions.map(optionKey).sort().join('|')
    !== EXPECTED_TRANSPORT_OPTIONS.map(optionKey).sort().join('|')) {
    violations.push(`[item 1] the transport's EFFECTIVE options changed: expected [${EXPECTED_TRANSPORT_OPTIONS.map(optionKey).join(', ')}], found [${census.transportOptions.map(optionKey).join(', ')}]`);
  }
  for (const access of census.unresolvedAccess) {
    if (`${access.file}:${access.enclosing}:${access.form}` in DECLARED_DYNAMIC_READS) continue;
    violations.push(`[item 1] ${access.file} reads a property the gate cannot resolve in \`${access.enclosing}\`: ${access.form} — an unreviewable access is not a reviewed one`);
  }

  // ── item 2 — no caller-correlated transport state survives a request ──
  for (const binding of census.state) {
    const key = `${binding.file}:${binding.name}`;
    if (binding.kind !== 'const' && !(key in DECLARED_PROCESS_STATE)) {
      violations.push(`[item 2] ${key} is a mutable module-level binding (\`${binding.kind}\`) that no carve-out declares`);
    }
    if (KEYED_CONTAINER.test(binding.shape) && !(key in DECLARED_PROCESS_STATE)) {
      violations.push(`[item 2] ${key} is a keyed container at module scope (\`${binding.shape}\`)`);
    }
    if (CALLER_CORRELATED_NAME.test(binding.name) && !(key in DECLARED_PROCESS_STATE)) {
      violations.push(`[item 2] ${key} names a caller-correlated or accumulating value (\`${binding.shape}\`) at module scope — declare it in DECLARED_PROCESS_STATE with a reason, or it does not belong in a stateless surface`);
    }
  }
  for (const write of census.writes) {
    const key = `${write.file}:${write.enclosing}:${write.form}`;
    if (key in DECLARED_WRITES) continue;
    violations.push(`[item 2] ${write.file} writes to state that outlives the call, in \`${write.enclosing}\`: ${write.form} — declaring no new state does not help if a request can write into state that is already there, wherever it is stored`);
  }
  for (const container of serverLifetimeContainers(census)) {
    violations.push(`[item 2] ${container.file} builds ${container.form} in \`${container.enclosing}\`, which runs once per SERVER — it survives every stdio call even where it looks per-request over HTTP`);
  }

  // ── item 3 — server and transport are constructed PER REQUEST ──
  for (const site of census.construction) {
    if (site.enclosing === '<module>') {
      violations.push(`[item 3] ${site.file} constructs ${site.what} at module scope — it would then be shared across requests`);
    }
  }
  for (const required of ['buildMcpServer()', 'new WebStandardStreamableHTTPServerTransport()']) {
    const site = census.construction.find((entry) => entry.file === 'httpRoute.ts' && entry.what === required);
    if (!site) violations.push(`[item 3] httpRoute.ts no longer constructs ${required}`);
    else if (site.enclosing !== 'handle') {
      violations.push(`[item 3] httpRoute.ts constructs ${required} in \`${site.enclosing}\`, not in the per-request handler`);
    }
  }

  // ── item 4 — authenticate before every backend operation; server-derived stamp ──
  if (census.ingressRegistrations.length !== 1) {
    violations.push(`[item 4] expected exactly ONE in-process route registration, found ${census.ingressRegistrations.length}`);
  }
  for (const guards of census.ingressRegistrations) {
    if (guards.join('|') !== EXPECTED_INGRESS_GUARDS.join('|')) {
      violations.push(`[item 4] the in-process guard chain changed: expected [${EXPECTED_INGRESS_GUARDS.join(', ')}], found [${guards.join(', ')}]`);
    }
  }
  if (census.stampShape !== 'StringLiteral <literal>') {
    violations.push(`[item 4] MCP_TRANSPORT_STAMP is ${census.stampShape} — the stamp must be a constant in provenance.ts, never derived from anything a caller supplies`);
  }
  if (census.stampArguments.length === 0) {
    violations.push('[item 4] no acceptPrincipalKey call was censused — the gate could not see what transport class the surface claims');
  }
  for (const stamp of census.stampArguments) {
    // Round 2 passed a literal 'any' here while the DECLARATION stayed the
    // expected literal. The declaration is not the value that travels.
    if (stamp.form !== 'MCP_TRANSPORT_STAMP') {
      violations.push(`[item 4] ${stamp.file} passes \`${stamp.form}\` as the transport class in \`${stamp.enclosing}\` — every call must pass MCP_TRANSPORT_STAMP itself, not a value that happens to equal it today`);
    }
  }

  // ── item 5 — no authority from initialize, handshake or client metadata ──
  if (census.requestHandlers.join('|') !== EXPECTED_REQUEST_HANDLERS.join('|')) {
    violations.push(`[item 5] the surface handles [${census.requestHandlers.join(', ')}]; expected exactly [${EXPECTED_REQUEST_HANDLERS.join(', ')}] — handling initialize itself is how handshake-derived authority gets in`);
  }
  if (census.callContextKeys.length === 0) {
    violations.push('[item 5] no per-call context was censused — the gate could not see what a tool is handed');
  }
  for (const context of census.callContextKeys) {
    if (describeEntries(context.entries) !== describeEntries(EXPECTED_CALL_CONTEXT)) {
      violations.push(`[item 5] ${context.file} hands tools [${describeEntries(context.entries)}]; expected exactly [${describeEntries(EXPECTED_CALL_CONTEXT)}] — effective authority is the credential the TRANSPORT carried, so the value matters as much as the key`);
    }
  }

  // ── item 6 — bounded request/response, no held-open stream ──
  if (census.serverCapabilities.join('|') !== 'tools') {
    violations.push(`[item 6] the server declares capabilities [${census.serverCapabilities.join(', ')}]; v1 declares \`tools\` and nothing else`);
  }
  if (!census.transportOptions.some((entry) => entry.key === 'enableJsonResponse')) {
    violations.push('[item 6] the Streamable HTTP transport no longer sets enableJsonResponse — the answer would be a held-open event stream');
  }
  for (const call of census.streamCalls) {
    violations.push(`[item 6] ${call.file} calls ${call.form}, which implies a server-initiated or held-open exchange`);
  }

  return violations;
}

// ════════════════════════════════ the gate ════════════════════════════════

describe('the MCP stateless posture gate (S-A6 / de73f9f8 §1.3, items 1–6)', () => {
  const sources = surfaceSources();
  const census = censusPosture(sources);

  it('is not vacuous: the surface it censuses is actually there', () => {
    expect(sources.map((entry) => entry.file)).toEqual([
      'bootstrapGate.ts', 'contract/protocolRevision.ts', 'httpRoute.ts', 'inProcess.ts',
      'provenance.ts', 'registry.ts', 'rest.ts', 'server.ts', 'shape.ts', 'stdio.ts',
      'webBridge.ts',
    ]);
    expect(census.state.length).toBeGreaterThanOrEqual(10);
  });

  it('censuses the module-level state the surface actually declares', () => {
    expect(census.state).toEqual(EXPECTED_STATE);
  });

  it('classifies the whole surface against posture items 1–6', () => {
    expect(classifyPosture(census)).toEqual([]);
  });

  it('item 1 — the only session identifier is the one being switched off', () => {
    expect(census.sessionTouches).toEqual(EXPECTED_SESSION_TOUCHES);
  });

  it("item 1 — the transport's EFFECTIVE options are exactly the reviewed set", () => {
    expect([...census.transportOptions].sort((a, b) => a.key.localeCompare(b.key)))
      .toEqual([...EXPECTED_TRANSPORT_OPTIONS].sort((a, b) => a.key.localeCompare(b.key)));
    expect(census.transportOptions.filter((entry) => entry.key === 'sessionIdGenerator'))
      .toEqual([{ key: 'sessionIdGenerator', value: 'undefined' }]);
  });

  it('item 2 — the only writes to surviving state are the declared ones', () => {
    expect(census.writes.map((write) => `${write.file}:${write.enclosing}:${write.form}`))
      .toEqual(Object.keys(DECLARED_WRITES));
  });

  it('item 2 — no keyed container is built in a scope that outlives a request', () => {
    expect(serverLifetimeContainers(census)).toEqual([]);
    // Non-empty overall, so a zero above means "none long-lived", not "none found".
    expect(census.containers.length).toBeGreaterThan(0);
  });

  it('item 4 — every acceptPrincipalKey call passes MCP_TRANSPORT_STAMP itself', () => {
    expect(census.stampShape).toBe('StringLiteral <literal>');
    // Three ingress-side credential resolutions now: the `/mcp` door, the
    // per-route check inside the in-process dispatch, and the fail-closed
    // bootstrap gate — which resolves the credential itself rather than
    // trusting one handed down a transport (RH-P3.C4 (ii), subtask [1]).
    expect(census.stampArguments.map((stamp) => stamp.form))
      .toEqual(['MCP_TRANSPORT_STAMP', 'MCP_TRANSPORT_STAMP', 'MCP_TRANSPORT_STAMP']);
    expect(census.ingressRegistrations).toEqual([EXPECTED_INGRESS_GUARDS]);
  });

  it('item 5 — the surface answers no handshake, and hands tools only the credential', () => {
    expect(census.requestHandlers).toEqual(EXPECTED_REQUEST_HANDLERS);
    expect(census.callContextKeys).toEqual([
      { file: 'httpRoute.ts', entries: EXPECTED_CALL_CONTEXT },
      { file: 'stdio.ts', entries: EXPECTED_CALL_CONTEXT },
    ]);
  });

  it('item 6 — bounded request/response only', () => {
    expect(census.serverCapabilities).toEqual(['tools']);
    expect(census.streamCalls).toEqual([]);
  });

  it('asserts item 7 through the retry-contract suite', () => {
    // The POSITIVE half of item 7 is discharged by card fb06c930, and it is
    // not discharged HERE: proving that an exact mutating retry converges
    // needs a real PostgreSQL and the production handler, which this gate
    // deliberately does not have. What this gate can assert is that the suite
    // which does it exists, is wired to run, and is not allowed to skip.
    const suite = path.join(__dirname, 'idempotencyContract.test.ts');
    expect(fs.existsSync(suite)).toBe(true);
    const source = fs.readFileSync(suite, 'utf8');
    // Never skips when the database is missing — a skipping gate is vacuous.
    expect(source).toContain('RELAYHALL_TEST_DB_URL');
    expect(source).toContain('a skipping gate is a vacuous gate');
    // …and it is a real-PostgreSQL suite, not a mocked one.
    expect(source).not.toContain("jest.mock('pg')");
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.scripts['test:idempotency']).toContain('idempotencyContract');
  });

  it('declares the durable state item 2 permits, with an enumerated writer census in BOTH directions', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { writersOf } = require('./support/moduleClosure');
    // (a) every declared table is created exactly once by the migrations.
    const migrations = path.join(__dirname, '..', 'migrations');
    for (const table of Object.keys(DECLARED_DURABLE_STATE)) {
      const creating = fs.readdirSync(migrations)
        .filter((name: string) => name.endsWith('.sql'))
        .filter((name: string) => new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table}\\b`, 'i')
          .test(fs.readFileSync(path.join(migrations, name), 'utf8')));
      expect({ table, creating }).toEqual({ table, creating: [creating[0]] });
    }
    // (b) the sink-anchored census equals the declaration — every declared
    // writer really writes, and no module outside the declaration does.
    for (const [table, declared] of Object.entries(DECLARED_DURABLE_WRITERS)) {
      expect({ table, writers: writersOf(table) }).toEqual({ table, writers: declared });
      expect(declared.length).toBeGreaterThan(0);
    }
    // …and the two registers cover the same tables, so a table can be neither
    // declared without a writer nor given a writer without being declared.
    expect(Object.keys(DECLARED_DURABLE_WRITERS).sort())
      .toEqual(Object.keys(DECLARED_DURABLE_STATE).sort());
    // Not vacuous: the scanner finds a writer that IS there, and none that is not.
    expect(writersOf('operation_idempotency_records')).toContain('middleware/idempotency.ts');
    expect(writersOf('a_table_that_does_not_exist')).toEqual([]);
  });

  // ═══ item 7's positive half rides the retry-contract suite; its
  // ═══ PROHIBITION on unqualified claims is enforced here, unchanged
  //
  // Item 7 has two halves. The positive one — proving that an exact mutating
  // retry converges — is discharged by card `fb06c930`'s real-PostgreSQL
  // suite, asserted above. The other half binds regardless: no claim that an
  // exact mutating retry converges may be made in unqualified terms, and the
  // per-tool sentences this candidate ships say what a retry DOES rather than
  // that it is safe.
  //
  // Round-2 verdict `f14da2c1` B7 found the claim in `mcp/server.ts`. Looking
  // for others found three more the review had not reached: a blanket "every
  // tool handler is idempotent" in the public `docs/mcp.md`, and the word on
  // two live MCP tool descriptions — `relayhall_task_claim` and the credential
  // revoke verb — where a model reads it and decides whether to repeat a
  // mutation. Those are the ones that actually matter.

  // Named for what it does, not for what no lint can do (rulings of
  // 2026-08-27, reports b0b63bd5/39f1ca2d): the TERM checks are lints — cheap
  // early warnings that cannot read English — and the SNAPSHOT is the control
  // that holds: every model-facing wording change becomes a review event.
  describe('item 7 prohibition — prohibited terms linted, model-facing text pinned', () => {
    /**
     * The claim as it is actually written when someone makes it. Deliberately
     * narrow: a wider net matched "the authorization decision happens exactly
     * once" and — worse — this candidate's own sentences WITHDRAWING the claim.
     * A gate that cannot tell an assertion from its negation is not a gate, and
     * tuning one until it stops crying wolf is how a control becomes furniture.
     */
    const CLAIM_WORD = /\b(idempotent|idempotency)\b/i;
    /**
     * Applied to TOOL DESCRIPTIONS only. Those are terse, controlled, and the
     * one text a model actually reads before deciding whether to repeat a
     * mutation, so the bar there is higher than for human prose.
     */
    const REPEAT_PHRASE = /\b(safe to (?:repeat|retry|re-?run)|retry[- ]safe|retries converge)\b/i;
    /**
     * `idempotencyKey` / `Idempotency-Key` is an INPUT the caller supplies, and
     * item 7 itself contemplates a tool that "requires an idempotency key
     * forwarded to the canonical backend operation". Naming that parameter is
     * a statement about the input, not a promise about calls without one.
     */
    const PARAMETER_MENTION = /idempotency[-]?key/gi;

    const strip = (text: string): string => text.replace(PARAMETER_MENTION, '');

    const claimsIn = (label: string, text: string, pattern = CLAIM_WORD): string[] =>
      text.split('\n')
        .map((line, index) => ({ line: strip(line), number: index + 1 }))
        .filter((entry) => pattern.test(entry.line))
        .map((entry) => `${label}:${entry.number}: ${entry.line.trim().slice(0, 120)}`);

    it('contains none of the PROHIBITED TERMS in any MCP surface module', () => {
      expect(surfaceSources().flatMap(({ file, source }) => claimsIn(file, source))).toEqual([]);
    });

    it('contains none of the PROHIBITED TERMS in any tool description', () => {
      // Named honestly: this catches the terms it lists, not every way English
      // can promise that repeating a call is safe. Round-4 verdict `b0b63bd5`
      // B2 walked past it with "repeating the same request preserves the same
      // outcome", and was right to. The control that actually holds the line
      // is the snapshot below; this is the cheap early warning beside it.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { MCP_TOOLS } = require('../mcp/registry');
      const offending = (MCP_TOOLS as Array<{ name: string; description: string }>)
        .filter((tool) => CLAIM_WORD.test(strip(tool.description))
          || REPEAT_PHRASE.test(strip(tool.description)))
        .map((tool) => `${tool.name}: ${tool.description.slice(0, 100)}`);
      expect(offending).toEqual([]);
      expect(MCP_TOOLS.length).toBeGreaterThan(40);
    });

    it('pins ALL model-facing text — server instructions and every tool description — to a reviewed snapshot', () => {
      // No pattern can decide whether a sentence promises retry safety — the
      // reviewer proved that twice, with two plain-English lines (`b0b63bd5`
      // B2, then `39f1ca2d` B2 in the server INSTRUCTIONS, a surface the
      // first digest did not cover). What CAN be enforced is that nobody
      // changes what a model reads without someone looking. So every piece of
      // model-facing text is digested and pinned: any edit, in any wording,
      // turns this red and lands in a diff a human reads.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { MCP_TOOLS } = require('../mcp/registry');
      const manifest = [
        `INSTRUCTIONS\n${serverModule.INSTRUCTIONS}`,
        ...(MCP_TOOLS as Array<{ name: string; description: string }>)
          .map((tool) => `${tool.name}\n${tool.description}`),
      ].join('\n---\n');
      const digest = `sha256-${crypto.createHash('sha256').update(manifest, 'utf8').digest('hex')}`;
      expect(digest).toBe(MODEL_FACING_TEXT_DIGEST);
      // Not vacuous: the instructions block really is in the manifest, and it
      // is the real text — the one carrying the untrusted-data doctrine.
      expect(serverModule.INSTRUCTIONS.length).toBeGreaterThan(200);
      expect(serverModule.INSTRUCTIONS).toContain('UNTRUSTED DATA');
      // …and the bootstrap-first instruction, which is the whole reason the
      // digest moved at RH-P3.C4 (ii). A digest bump with no property behind it
      // is a number someone updated to make a test pass.
      expect(serverModule.INSTRUCTIONS).toContain('bootstrap first');
      expect(serverModule.INSTRUCTIONS).toContain('relayhall_brief_compile');
      expect(manifest.startsWith('INSTRUCTIONS\n')).toBe(true);
      // Card fb06c930: the digest moved BECAUSE the retry sentences landed, and
      // this is what says so. Each declared sentence is present in the live
      // description of the tool it names — so a digest that matched with the
      // sentences missing would still fail here.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RETRY_CONTRACT_SENTENCES } = require('../mcp/registry');
      const byName = new Map((MCP_TOOLS as Array<{ name: string; description: string }>)
        .map((tool) => [tool.name, tool.description]));
      const absent = Object.entries(RETRY_CONTRACT_SENTENCES as Record<string, string>)
        .filter(([name, sentence]) => !(byName.get(name) ?? '').includes(sentence))
        .map(([name]) => name);
      expect(absent).toEqual([]);
      expect(Object.keys(RETRY_CONTRACT_SENTENCES).length).toBeGreaterThan(15);
    });

    it('contains none of the PROHIBITED TERMS in the operator documentation (a lint, not a proof)', () => {
      // docs/mcp.md changes legitimately and often, so it is linted rather
      // than digested — pinning it would make every routine doc edit a gate
      // event. The model-facing text a HARNESS actually consumes (server
      // instructions, tool descriptions) is what the snapshot above pins.
      const docs = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'mcp.md'), 'utf8');
      expect(claimsIn('docs/mcp.md', docs)).toEqual([]);
    });

    it('the check is not vacuous — it catches every claim that WAS there', () => {
      // The four this candidate removed, verbatim.
      expect(claimsIn('server.ts', ' * no per-MCP-session cache, idempotent handlers.'))
        .toHaveLength(1);
      expect(claimsIn('registry.ts', "description: 'Effective on the very next request; idempotent; audited.',"))
        .toHaveLength(1);
      expect(claimsIn('registry.ts', "description: 'Become a Task Assignee. Idempotent for the current Assignee.',"))
        .toHaveLength(1);
      expect(claimsIn('docs/mcp.md', 'every tool handler is idempotent and complete in itself.'))
        .toHaveLength(1);
      // The tool-description bar is higher.
      expect(claimsIn('registry.ts', "description: 'Retire an Agent. Safe to repeat.'", REPEAT_PHRASE))
        .toHaveLength(1);
      // …and both leave the PARAMETER alone, which item 7 explicitly permits.
      expect(claimsIn('registry.ts', 'requires an `idempotencyKey` of 16-128 characters')).toEqual([]);
      expect(claimsIn('registry.ts', "headers: { 'Idempotency-Key': idempotencyKey }")).toEqual([]);
      // …and do not fire on a sentence that WITHDRAWS the claim, which is what
      // this candidate's own prose has to be able to say.
      expect(claimsIn('server.ts', ' * NOTHING HERE CLAIMS RETRY SAFETY. Read-only tools are retry-safe.'))
        .toEqual([]);
      // …nor on the per-tool retry-contract sentences this candidate ships,
      // which is the property that let the lints stay unweakened: every one of
      // them passes CLAIM_WORD and REPEAT_PHRASE as they stand, and the only
      // occurrence of the word anywhere in them is the parameter name item 7
      // already permits. A candidate that had needed an exemption here would
      // have been widening the gate it was supposed to be discharging.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RETRY_CONTRACT_SENTENCES } = require('../mcp/registry');
      const sentences = Object.entries(RETRY_CONTRACT_SENTENCES as Record<string, string>);
      expect(sentences.length).toBeGreaterThan(15);
      expect(sentences.filter(([, text]) => CLAIM_WORD.test(strip(text)) || REPEAT_PHRASE.test(strip(text))))
        .toEqual([]);
      // …and the lint would still catch the claim if one of them made it.
      expect(claimsIn('registry.ts', 'Retry contract: this tool is idempotent.')).toHaveLength(1);
      expect(claimsIn('registry.ts', 'Retry contract: safe to repeat.', REPEAT_PHRASE)).toHaveLength(1);
    });
  });

  // ═══════ items 3 and 4, proven by RUNNING the surface ═══════
  //
  // Round 2's B3: the static half reads names and ordering. A memoised server
  // still says `new Server()` inside its helper; a cached transport still says
  // `new WebStandardStreamableHTTPServerTransport()` inside `handle`; a dead
  // `if (false) acceptPrincipalKey(…)` still comes first in source order. None
  // of that survives two real requests and an invocation log.

  describe('items 3–4 as BEHAVIOUR, not syntax', () => {
    const TOKEN = 'rh_dev_keyid01.secretsecretsecretsecret';
    let server: http.Server;
    let base = '';

    const principalRow = (): Principal => ({
      id: '88888888-8888-4888-8888-888888888888', kind: 'service', handle: 'connector_one',
      displayName: 'Connector One', status: 'active', role: 'agent', boundTaskId: null,
      purpose: null, legacyIdentity: false, ownExpression: null, sourceTag: null, harness: null,
      personalityId: null, parentPrincipalId: null, lastSeenAt: null, metadata: {},
    });
    const credentialRow = (): PrincipalCredential => ({
      id: '99999999-9999-4999-8999-999999999999', principalId: principalRow().id,
      credentialType: 'api_key', keyId: 'keyid01', scopes: ['principals:read'],
      expiresAt: null, revokedAt: null, transport: 'mcp', graceUntil: null, metadata: {},
    });

    interface Wire { status: number; headers: http.IncomingHttpHeaders; body: string }

    const request = (payload: unknown, token = TOKEN): Promise<Wire> => {
      const data = Buffer.from(JSON.stringify(payload), 'utf8');
      return new Promise((resolve, reject) => {
        const outgoing = http.request(`${base}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': String(data.byteLength),
            authorization: `Bearer ${token}`,
          },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        outgoing.on('error', reject);
        outgoing.write(data);
        outgoing.end();
      });
    };

    const post = (payload: unknown): Promise<Wire> => request(payload);

    const rpc = (method: string, id = 1) => (method === 'tools/call'
      ? { jsonrpc: '2.0', id, method, params: { name: 'relayhall_principal_whoami', arguments: {} } }
      : { jsonrpc: '2.0', id, method });

    beforeAll((done) => {
      const app = express();
      app.use(express.json());
      app.use('/mcp', mcpRoutes);
      server = app.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        done();
      });
    });

    afterAll((done) => { server.close(() => done()); });

    beforeEach(() => {
      jest.restoreAllMocks();
      jest.spyOn(principalService, 'bumpLastSeen').mockImplementation(() => undefined as never);
      jest.spyOn(principalService, 'authenticatePrincipalKey')
        .mockResolvedValue({ principal: principalRow(), credential: credentialRow() });
    });

    it('builds a DISTINCT server and transport for every request', async () => {
      // Both spies call through, so this is the production path with a
      // recorder on it — not a stand-in for it.
      // Both spies call through, so this is the production path with a
      // recorder on it — not a stand-in for it.
      const build = jest.spyOn(serverModule, 'buildMcpServer');
      const connect = jest.spyOn(Server.prototype, 'connect');

      await post(rpc('tools/list', 1));
      await post(rpc('tools/list', 2));

      expect(build).toHaveBeenCalledTimes(2);
      const servers = build.mock.results.map((result) => result.value);
      // A memoised server — however it is spelled — returns the SAME object.
      expect(servers[0]).not.toBe(servers[1]);

      const transports = connect.mock.calls.map((call) => call[0]);
      expect(transports).toHaveLength(2);
      // A transport cached anywhere — on the router, on a helper, in a closure
      // — is the same object twice.
      expect(transports[0]).not.toBe(transports[1]);
    });

    it('AUTHENTICATES before it constructs — by invocation order, not source order', async () => {
      const authenticate = jest.spyOn(authModule, 'acceptPrincipalKey');
      const build = jest.spyOn(serverModule, 'buildMcpServer');
      authenticate.mockClear();
      build.mockClear();

      await post(rpc('tools/list', 3));

      expect(authenticate).toHaveBeenCalled();
      expect(build).toHaveBeenCalled();
      // Dead code does not register an invocation. Source order can be staged;
      // this cannot.
      expect(authenticate.mock.invocationCallOrder[0])
        .toBeLessThan(build.mock.invocationCallOrder[0]);
    });

    it('passes the mcp transport class that ACTUALLY travels, not one that matches by luck', async () => {
      const authenticate = jest.spyOn(authModule, 'acceptPrincipalKey');
      authenticate.mockClear();

      await post(rpc('tools/list', 4));

      expect(authenticate).toHaveBeenCalled();
      for (const call of authenticate.mock.calls) {
        expect(call[2]).toBe(MCP_ROUTE_PATH);
        // Round 2 passed a literal 'any' here while the declaration stayed
        // right. This reads the value off the wire, not off the declaration.
        expect(call[3]).toBe(MCP_TRANSPORT_STAMP);
        expect(call[3]).toBe('mcp');
      }
    });

    it('a DENIED credential never reaches server construction', async () => {
      // Round-2 verdict f14da2c1 B3 asked for this directly: prove that an
      // unauthenticated or denied outcome cannot reach `buildMcpServer`. A
      // lexical ordering check cannot; refusing the credential and watching
      // what does not happen can.
      const build = jest.spyOn(serverModule, 'buildMcpServer');
      // The real denial path: the credential service finds no live credential.
      // (Not a rejected promise — that is a 500-class fault, not a refusal.)
      jest.spyOn(principalService, 'authenticatePrincipalKey')
        .mockResolvedValue(null as never);

      const refused = await post(rpc('tools/list', 7));

      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(build).not.toHaveBeenCalled();
    });

    it('takes the credential from the TRANSPORT, never from the JSON-RPC body', async () => {
      // Round-2 verdict f14da2c1 B4: the context's key set is identical when
      // the value comes from `req.body.params.clientInfo`. So send a body that
      // carries a different credential and read which one actually travelled.
      const authenticate = jest.spyOn(authModule, 'acceptPrincipalKey');
      authenticate.mockClear();

      await post({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/list',
        params: { clientInfo: { name: 'jest', version: '1', authorization: 'Bearer rh_dev_other.otherotherotherother' } },
      });

      expect(authenticate).toHaveBeenCalled();
      for (const call of authenticate.mock.calls) {
        expect(call[1]).toBe(`Bearer ${TOKEN}`);
        expect(String(call[1])).not.toContain('rh_dev_other');
      }
    });

    /**
     * ── The control that does not care how state is spelled ──
     *
     * Round-3 verdict `5cb6ff8a` B2 landed five separate mutations that the
     * static census missed: a local alias to `globalThis`, `Object.prototype`,
     * a `Map` one helper call from `buildMcpServer`, state on a function
     * object behind an alias, and a credential stored on the memoised Express
     * app. Each was caught by extending the census — and each extension was
     * answered by a new spelling the next round.
     *
     * That is a losing shape. A static census cannot soundly prove the ABSENCE
     * of state in a language where state can be reached any number of ways,
     * and every round of "add the pattern the reviewer used" makes the gate
     * longer without making it sound.
     *
     * But item 2 does not forbid state. It forbids state that "changes a later
     * call's authority or caller-visible result" — and that is a RUNTIME
     * property, so it can be measured instead of inferred. Every one of those
     * five mutations exists precisely to make a later call differ, and every
     * one fails the probe below regardless of how it is written.
     *
     * The census stays: it catches additions at review time, before anyone
     * runs anything, and it names them precisely. This is the backstop that
     * does not have to guess.
     */
    it('read-plane isolation: repeats are stable per caller, and callers are status/header-symmetric', async () => {
      // Named for exactly what it measures (owner ruling, 2026-08-27). What it
      // does NOT measure — body-level CROSS-caller normalisation (a marker
      // stable per caller but caused by another), schema-valid non-empty
      // arguments, and the mutating plane — needs per-caller clean-lifetime
      // baselines and an in-memory board double: the isolation-harness
      // candidate ruled to ride with `fb06c930`, where the sanctioned state
      // (bootstrap TTL records, idempotency records) lands and the contract
      // this probe enforces is renegotiated anyway.
      // ── What this asserts, exactly ──
      //
      // Round-4 verdict `b0b63bd5` B1 was right that the previous wording —
      // "whatever the surface stores, wherever" — could not be backed by one
      // tool, two callers and no headers. State on the CallTool handler that
      // moved a different tool's answer, a response HEADER that changed, and a
      // regression that needed a THIRD caller all walked past it.
      //
      // So the claim now names its surface and the surface is inventoried:
      // every tool on the read plane, driven for every caller, compared on the
      // COMPLETE wire (status, headers, body). The mutating plane is excluded
      // for a stated reason and that exclusion is itself asserted below, so a
      // new tool cannot quietly land outside the probe.
      const other = (handle: string, id: string): Principal => ({ ...principalRow(), id, handle });
      const CALLERS = [
        { token: 'rh_dev_keyid01.secretsecretsecretsecret', keyId: 'keyid01', handle: 'connector_one' },
        { token: 'rh_dev_keyid02.secondsecondsecondsecond', keyId: 'keyid02', handle: 'connector_two' },
        { token: 'rh_dev_keyid03.thirdthirdthirdthirdthir', keyId: 'keyid03', handle: 'connector_three' },
      ];
      const PRINCIPALS: Record<string, Principal> = {
        keyid01: principalRow(),
        keyid02: other('connector_two', '77777777-7777-4777-8777-777777777777'),
        keyid03: other('connector_three', '66666666-6666-4666-8666-666666666666'),
      };

      jest.spyOn(principalService, 'authenticatePrincipalKey')
        .mockImplementation((async (parts: { keyId?: string }) => {
          const principal = PRINCIPALS[String(parts?.keyId)];
          if (!principal) return undefined;
          return { principal, credential: { ...credentialRow(), keyId: String(parts?.keyId) } };
        }) as never);

      /**
       * The COMPLETE caller-visible answer. Only `date` is normalised — it is
       * a clock reading, not a result — along with the JSON-RPC `id` the
       * caller itself chose. Round 4 dropped every header and a regression
       * hid in one.
       */
      const shape = (wire: Wire): string => {
        const headers = Object.entries(wire.headers)
          .filter(([key]) => key !== 'date')
          .map(([key, value]) => `${key}=${String(value)}`)
          .sort()
          .join(';');
        return `${wire.status}|${headers}|${wire.body.replace(/"id":\d+/g, '"id":N')}`;
      };

      let sequence = 100;
      const callTool = (name: string, token: string) => request({
        jsonrpc: '2.0', id: (sequence += 1), method: 'tools/call', params: { name, arguments: {} },
      }, token);

      /**
       * One caller's whole read surface, in one pass — plus every OTHER class
       * of dispatch result the surface can produce.
       *
       * The second round-4 verdict (`48cabce1` B1) put module-lifetime state
       * behind the "No such RelayHall tool" branch: a result class the probe
       * never visited, so a counter could climb through it unseen. Sampling
       * only successful known tools samples one branch of several, and the
       * property is about all of them.
       */
      const sweep = async (token: string): Promise<Record<string, string>> => {
        const seen: Record<string, string> = {
          'tools/list': shape(await request(rpc('tools/list', (sequence += 1)), token)),
        };
        for (const name of READ_PLANE_TOOLS) seen[name] = shape(await callTool(name, token));
        // unknown tool — the registry's own miss branch
        seen['<unknown tool>'] = shape(await callTool('review_missing_tool', token));
        // tool-level error — a known tool given arguments it must refuse
        seen['<bad arguments>'] = shape(await request({
          jsonrpc: '2.0',
          id: (sequence += 1),
          method: 'tools/call',
          params: { name: 'relayhall_task_get', arguments: { taskId: 'not-a-uuid' } },
        }, token));
        // protocol-level miss — a JSON-RPC method the server does not handle
        seen['<unknown method>'] = shape(await request(rpc('resources/list', (sequence += 1)), token));
        return seen;
      };

      // Orders on purpose: A B C, then C B A, then A again. A regression that
      // needs a third distinct caller, or that latches on the FIRST caller,
      // shows up in one of these and not the others.
      const round1: Record<string, Record<string, string>> = {};
      for (const caller of CALLERS) round1[caller.keyId] = await sweep(caller.token);
      const round2: Record<string, Record<string, string>> = {};
      for (const caller of [...CALLERS].reverse()) round2[caller.keyId] = await sweep(caller.token);
      const round3 = await sweep(CALLERS[0].token);

      // 1 · Every caller's answers are the same the second time, and the third.
      for (const caller of CALLERS) {
        expect([caller.keyId, round2[caller.keyId]]).toEqual([caller.keyId, round1[caller.keyId]]);
      }
      expect(round3).toEqual(round1[CALLERS[0].keyId]);

      // 2 · Every caller gets its OWN identity back, in every order — the half
      //     that catches "latch the first credential and mis-serve the rest".
      for (const caller of CALLERS) {
        for (const round of [round1[caller.keyId], round2[caller.keyId]]) {
          const whoami = round.relayhall_principal_whoami;
          expect([caller.handle, whoami.startsWith('200|')]).toEqual([caller.handle, true]);
          expect([caller.handle, whoami.includes(caller.handle)]).toEqual([caller.handle, true]);
        }
      }

      // 3 · A DENIED caller changes nothing for anyone, and is denied the same
      //     way twice — the error path is caller-visible too.
      const denied1 = shape(await callTool('relayhall_principal_whoami', 'rh_dev_nosuch.nosuchnosuchnosuchno'));
      const afterDenial = await sweep(CALLERS[1].token);
      const denied2 = shape(await callTool('relayhall_principal_whoami', 'rh_dev_nosuch.nosuchnosuchnosuchno'));
      expect(denied2).toBe(denied1);
      expect(afterDenial).toEqual(round1[CALLERS[1].keyId]);

      // 4 · SYMMETRY. The three callers are deliberately given IDENTICAL
      //     scopes and differ only in identity, so for any given tool their
      //     status and their set of header names must match exactly. Only the
      //     body may differ, and only by identity.
      //
      //     This is the half that catches a regression which is stable for
      //     each caller and therefore invisible to a same-caller comparison:
      //     "the first credential wins and everyone after it is marked", or
      //     "refuse once a THIRD distinct caller appears". Round-4 verdict
      //     `b0b63bd5` landed both, and both were stable per caller.
      const facet = (wire: string): string => {
        const [status, headers] = wire.split('|');
        return `${status}|${headers.split(';').map((entry) => entry.split('=')[0]).sort().join(',')}`;
      };
      for (const key of Object.keys(round1[CALLERS[0].keyId])) {
        const facets = CALLERS.map((caller) => facet(round1[caller.keyId][key]));
        expect([key, facets[1]]).toEqual([key, facets[0]]);
        expect([key, facets[2]]).toEqual([key, facets[0]]);
        const reversed = CALLERS.map((caller) => facet(round2[caller.keyId][key]));
        expect([key, reversed]).toEqual([key, facets]);
      }

      // 5 · Not vacuous: the callers really are distinguishable, so a surface
      //     that ignored the credential entirely would fail here too.
      expect(round1.keyid01.relayhall_principal_whoami)
        .not.toEqual(round1.keyid02.relayhall_principal_whoami);
      expect(Object.keys(round1.keyid01).length).toBe(READ_PLANE_TOOLS.length + 4);
    });

    it('the probe drives EVERY read-plane tool, and the rest is inventoried', () => {
      // The claim above is only as wide as this list. Asserting the partition
      // against the live registry means a new tool cannot land outside the
      // probe without someone classifying it — which is the review event.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { MCP_TOOLS } = require('../mcp/registry');
      const registry = (MCP_TOOLS as Array<{ name: string; plane: string }>);
      const readPlane = registry.filter((tool) => tool.plane !== 'work').map((tool) => tool.name);
      const mutating = registry.filter((tool) => tool.plane === 'work').map((tool) => tool.name);

      expect([...READ_PLANE_TOOLS].sort()).toEqual([...readPlane].sort());
      expect([...MUTATING_TOOLS_NOT_PROBED].sort()).toEqual([...mutating].sort());
      // The partition is exhaustive: nothing in the registry is unclassified.
      expect([...READ_PLANE_TOOLS, ...MUTATING_TOOLS_NOT_PROBED].sort())
        .toEqual(registry.map((tool) => tool.name).sort());
      expect(READ_PLANE_TOOLS.length).toBeGreaterThan(20);
    });

    it('the memoised internal app is the same object for different callers, and holds no credential', async () => {
      // `DECLARED_PROCESS_STATE` says `internalApp` is "built with no caller
      // input". Round-3 verdict `5cb6ff8a` B2 rightly objected that the
      // exception was keyed by spelling and proved nothing. This proves it.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const inProcess = require('../mcp/inProcess');
      inProcess.resetInternalApp();
      expect(inProcess.getInternalApp.length).toBe(0);

      await request(rpc('tools/call', 24), TOKEN);
      const afterFirst = inProcess.getInternalApp();
      await request(rpc('tools/call', 25), 'rh_dev_keyid02.secondsecondsecondsecond');
      expect(inProcess.getInternalApp()).toBe(afterFirst);
      expect(JSON.stringify(Object.keys(afterFirst))).not.toContain('keyid0');
    });

    it('mints no Mcp-Session-Id on the wire, whatever the source says', async () => {
      // The end of round 2's B1: the census can be evaded, an answered header
      // cannot. This is the assertion that could not have been green while the
      // reviewer's computed key was in the tree.
      const first = await post(rpc('initialize', 5));
      const second = await post(rpc('tools/list', 6));
      expect(first.headers['mcp-session-id']).toBeUndefined();
      expect(second.headers['mcp-session-id']).toBeUndefined();
    });
  });

  // ─────────── the gate goes RED when the posture regresses ───────────

  describe('red-mutation proof', () => {
    const mutate = (file: string, edit: (source: string) => string): PostureCensus => {
      const mutated = sources.map((entry) => (entry.file === file
        ? { ...entry, source: edit(entry.source) } : entry));
      const before = sources.find((entry) => entry.file === file)!.source;
      const after = mutated.find((entry) => entry.file === file)!.source;
      expect(after).not.toBe(before);
      return censusPosture(mutated);
    };

    const fails = (file: string, edit: (source: string) => string): string => {
      const violations = classifyPosture(mutate(file, edit));
      expect(violations).not.toEqual([]);
      return violations.join('\n');
    };

    // ── round 2, B1: the evasions that made this gate a false green ──

    it("[item 1] catches the reviewer's computed key: ['session' + 'IdGenerator']", () => {
      // The exact mutation from REJECT 7c2d4dbb. The expected
      // `sessionIdGenerator: undefined` stays untouched beside it.
      expect(fails('httpRoute.ts', (source) => source.replace(
        '    sessionIdGenerator: undefined,',
        "    sessionIdGenerator: undefined,\n    ['session' + 'IdGenerator']: () => 'review-minted-session',",
      ))).toContain('[item 1]');
    });

    it('[item 1] catches a session generator supplied through a spread', () => {
      expect(fails('httpRoute.ts', (source) => source.replace(
        '    enableJsonResponse: true,',
        '    enableJsonResponse: true,\n    ...{ sessionIdGenerator: randomUUID },',
      ))).toContain('[item 1]');
    });

    it('[item 1] catches a spread the gate cannot resolve', () => {
      expect(fails('httpRoute.ts', (source) => source.replace(
        '    enableJsonResponse: true,',
        '    enableJsonResponse: true,\n    ...extraTransportOptions,',
      ))).toContain('<spread:unresolved>');
    });

    it('[item 1] catches a header name assembled from fragments', () => {
      expect(fails('httpRoute.ts', (source) => source.replace(
        'const authorization = req.headers.authorization;',
        "const hiddenHeader = 'mcp-' + 'session' + '-id';\n  const prior = req.headers[hiddenHeader];\n  const authorization = req.headers.authorization;",
      ))).toContain('[item 1]');
    });

    it('[item 1] catches a property read the gate cannot resolve at all', () => {
      expect(fails('httpRoute.ts', (source) => source.replace(
        'const authorization = req.headers.authorization;',
        'const prior = req.headers[pickHeaderName()];\n  const authorization = req.headers.authorization;',
      ))).toContain('cannot resolve');
    });

    it('[item 1] catches a session id minted through an identifier', () => {
      expect(fails('httpRoute.ts', (source) => source.replace(
        'sessionIdGenerator: undefined,', 'sessionIdGenerator: randomUUID,',
      ))).toContain('[item 1]');
    });

    it('[item 1] catches statelessness quietly stopping being the default', () => {
      expect(fails('httpRoute.ts', (source) => source.replace('sessionIdGenerator: undefined,', '')))
        .toContain('statelessness is not the default');
    });

    // ── round 2, B2: state the declaration census could not see ──

    it('[item 2] catches a keyed container added at module scope', () => {
      expect(fails('inProcess.ts', (source) => `${source}\nconst byCredential = new Map<string, unknown>();\n`))
        .toContain('[item 2] inProcess.ts:byCredential');
    });

    it('[item 2] catches caller-correlated state hidden behind a factory call', () => {
      expect(fails('rest.ts', (source) => `${source}\nconst principalScratch = buildScratchpad();\n`))
        .toContain('names a caller-correlated or accumulating value');
    });

    it('[item 2] catches an undeclared mutable binding', () => {
      expect(fails('shape.ts', (source) => `${source}\nlet lastShapedPayload: unknown;\n`))
        .toContain('is a mutable module-level binding');
    });

    it('[item 2] catches caller data pushed into an already-allowlisted registry', () => {
      // Every DECLARATION stays byte-identical through this one.
      expect(fails('registry.ts', (source) => source.replace(
        'export const REMOVED_V1_TOOLS = [',
        'export function rememberCaller(tool: McpTool): void { MCP_TOOLS.push(tool); }\nexport const REMOVED_V1_TOOLS = [',
      ))).toContain('MCP_TOOLS.push()');
    });

    it('[item 2] catches a caller-keyed Map inside buildMcpServer — stateless on HTTP, stateful on stdio', () => {
      expect(fails('server.ts', (source) => source.replace(
        '  const server = new Server(MCP_SERVER_INFO, {',
        '  const callerResults = new Map<string, number>();\n  const server = new Server(MCP_SERVER_INFO, {',
      ))).toContain('runs once per SERVER');
    });

    it('[item 2] catches Object.assign onto module state — the write is to the ARGUMENT', () => {
      expect(fails('registry.ts', (source) => `${source}\nexport function merge(extra: object): void { Object.assign(RESOURCE_DETAIL_VARIANTS, extra); }\n`))
        .toContain('Object.assign(RESOURCE_DETAIL_VARIANTS, …)');
    });

    it('[item 2] catches state parked on globalThis', () => {
      expect(fails('httpRoute.ts', (source) => `${source}\nexport function remember(key: string): void { (globalThis as any).mcpSeen = key; }\n`))
        .toContain('[item 2] httpRoute.ts writes to state that outlives the call');
    });

    it('[item 2] catches state parked on process', () => {
      expect(fails('rest.ts', (source) => `${source}\nexport function remember(key: string): void { (process as any).mcpSeen = key; }\n`))
        .toContain('[item 2] rest.ts writes to state that outlives the call');
    });

    it('[item 2] catches state parked in require.cache', () => {
      expect(fails('shape.ts', (source) => `${source}\nexport function remember(key: string): void { (require.cache as any).mcpSeen = key; }\n`))
        .toContain('[item 2] shape.ts writes to state that outlives the call');
    });

    it('[item 2] catches a store that lives OUTSIDE src/mcp and is written from inside it', () => {
      // Round 2 parked the state in another module. The store is elsewhere;
      // the write is here, and the write is what this censuses.
      expect(fails('httpRoute.ts', (source) => source.replace(
        "import { logCaughtFailure } from '../utils/secretSafeLog';",
        "import { logCaughtFailure } from '../utils/secretSafeLog';\nimport { callerStore } from '../utils/callerStore';",
      ).replace(
        'const authorization = req.headers.authorization;',
        "callerStore.set(String(req.headers.authorization), 1);\n  const authorization = req.headers.authorization;",
      ))).toContain('callerStore.set()');
    });

    it('[item 2] catches a request-keyed WeakMap in an outside module written from here', () => {
      expect(fails('rest.ts', (source) => source.replace(
        "import { errorFromRest } from './shape';",
        "import { errorFromRest } from './shape';\nimport { perRequest } from '../utils/perRequest';",
      ).replace(
        'export async function callBoard(',
        'export function remember(key: object): void { perRequest.set(key, 1); }\n\nexport async function callBoard(',
      ))).toContain('perRequest.set()');
    });

    // ── round 2, B3: syntax that looked like the right behaviour ──

    it('[item 4] catches a transport class that is passed as a bare literal', () => {
      // The reviewer's exact bypass: MCP_TRANSPORT_STAMP still declared as the
      // expected literal, but `'any'` is what actually travels.
      expect(fails('provenance.ts', (source) => source.replace(
        'req, req.headers.authorization, mountedPath, MCP_TRANSPORT_STAMP,',
        "req, req.headers.authorization, mountedPath, 'any' as TransportClass,",
      ))).toContain('as the transport class');
    });

    it('[item 4] catches the same bypass at the HTTP door', () => {
      expect(fails('httpRoute.ts', (source) => source.replace(
        'acceptPrincipalKey(probe, authorization, MCP_ROUTE_PATH, MCP_TRANSPORT_STAMP)',
        "acceptPrincipalKey(probe, authorization, MCP_ROUTE_PATH, 'any' as never)",
      ))).toContain('as the transport class');
    });

    it('[item 4] catches authentication dropped from the dispatched routes', () => {
      expect(fails('inProcess.ts', (source) => source.replace(
        'app.use(path, mcpAuthMiddleware, sharedAuthorizationMiddleware, ...(handlers as RequestHandler[]));',
        'app.use(path, sharedAuthorizationMiddleware, ...(handlers as RequestHandler[]));',
      ))).toContain('the in-process guard chain changed');
    });

    it('[item 4] catches a transport stamp that stops being a constant', () => {
      expect(fails('provenance.ts', (source) => source.replace(
        "export const MCP_TRANSPORT_STAMP: TransportClass = 'mcp';",
        'export const MCP_TRANSPORT_STAMP: TransportClass = transportFromHeader();',
      ))).toContain('MCP_TRANSPORT_STAMP is CallExpression');
    });

    it('[item 3] catches a server hoisted out of the request', () => {
      expect(fails('httpRoute.ts', (source) => `${source}\nconst sharedServer = buildMcpServer((toolName) => ({ authorization: '', toolName }));\n`))
        .toContain('at module scope');
    });

    it('[item 3] catches a transport cached on the allowlisted router', () => {
      // Syntactically still `new WebStandardStreamableHTTPServerTransport()` inside
      // `handle`. It is the WRITE to `router` that gives it away — and the
      // behavioural test above proves the object is reused.
      expect(fails('httpRoute.ts', (source) => source.replace(
        '  res.on(\'close\', () => {',
        "  (router as any).cachedTransport = transport;\n  res.on('close', () => {",
      ))).toContain('[item 2] httpRoute.ts writes to state that outlives the call');
    });

    // ── items 5 and 6 ──

    it('[item 5] catches the surface answering initialize itself', () => {
      expect(fails('server.ts', (source) => source.replace(
        "  server.setRequestHandler('tools/list',",
        "  server.setRequestHandler('initialize', async () => ({ capabilities: {} }));\n  server.setRequestHandler('tools/list',",
      ))).toContain('[item 5] the surface handles [initialize');
    });

    it('[item 5] catches a handshake handler registered under an ASSEMBLED method name', () => {
      // v2 takes a string, and a string can be built. The census folds it.
      expect(fails('server.ts', (source) => source.replace(
        "  server.setRequestHandler('tools/list',",
        "  server.setRequestHandler('initial' + 'ize', async () => ({ capabilities: {} }));\n  server.setRequestHandler('tools/list',",
      ))).toContain('[item 5] the surface handles [initialize');
    });

    it('[item 3] catches the reviewed transport class swapped for another v2 transport', () => {
      // `PerRequestHTTPServerTransport` and `createMcpHandler` exist in v2 and
      // were NOT chosen (owner decision D4): their option sets are different
      // and unreviewed here. The census names the exact class it reviewed.
      expect(fails('httpRoute.ts', (source) => source.replace(
        'new WebStandardStreamableHTTPServerTransport({',
        'new PerRequestHTTPServerTransport({',
      ))).toContain('no longer constructs new WebStandardStreamableHTTPServerTransport()');
    });

    it('[item 5] catches handshake client metadata reaching a tool as an extra key', () => {
      expect(fails('httpRoute.ts', (source) => source.replace(
        'buildMcpServer((toolName) => ({ authorization, toolName }));',
        'buildMcpServer((toolName) => ({ authorization, toolName, client: handshakeClientInfo }));',
      ))).toContain('[item 5]');
    });

    it('[item 5] catches the body supplying the CREDENTIAL while the keys stay identical', () => {
      // Round-2 verdict f14da2c1 B4, exactly. `authorization` and `toolName`
      // are still the only two keys; only the value moved.
      expect(fails('httpRoute.ts', (source) => source.replace(
        'buildMcpServer((toolName) => ({ authorization, toolName }));',
        'buildMcpServer((toolName) => ({ authorization: req.body?.params?.clientInfo?.authorization ?? authorization, toolName }));',
      ))).toContain('the value matters as much as the key');
    });

    it('[item 2] catches state closed over by a module-level IIFE', () => {
      // Round-2 verdict f14da2c1 B2: `enclosingFunction` calls this
      // `<anonymous>`, so a name-keyed check reads it as per-call state. It
      // runs at module load and lives as long as the module.
      expect(fails('rest.ts', (source) => `${source}\nexport const callerStore = (() => { const seen = new Map<string, number>(); return (key: string): void => { seen.set(key, 1); }; })();\n`))
        .toContain('runs once per SERVER');
    });

    it('[item 6] catches a held-open primitive reached through an ALIAS', () => {
      // Round-2 verdict f14da2c1 B5: `const heartbeat = setInterval;` then
      // `heartbeat(…)`. No call site names a forbidden primitive.
      expect(fails('server.ts', (source) => `${source}\nconst heartbeat = setInterval;\nexport function beat(): void { heartbeat(() => undefined, 60_000); }\n`))
        .toContain('referenced, not called here');
    });

    it('[item 6] catches a capability that implies a held-open exchange', () => {
      expect(fails('server.ts', (source) => source.replace(
        'capabilities: { tools: {} },', 'capabilities: { tools: {}, logging: {} },',
      ))).toContain('capabilities [tools, logging]');
    });

    it('[item 6] catches a server-initiated exchange added to a tool', () => {
      expect(fails('registry.ts', (source) => `${source}\nsetInterval(() => undefined, 1000);\n`))
        .toContain('calls setInterval()');
    });

    it('[item 6] catches the JSON response mode being turned off', () => {
      expect(fails('httpRoute.ts', (source) => source.replace('enableJsonResponse: true,', '')))
        .toContain('[item 6]');
    });

    it('the exact census reacts too, not only the classifier', () => {
      const mutated = mutate('shape.ts', (source) => `${source}\nconst extraRegistry = {};\n`);
      expect(mutated.state).not.toEqual(EXPECTED_STATE);
    });
  });
});
