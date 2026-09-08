/**
 * support/astStrings — static string resolution for the two C4 gates.
 *
 * Round-2 verdict `7c2d4dbb` rejected both gates for the same reason in two
 * places: they read LITERALS, and a value can be written as an expression.
 * `'session' + 'IdGenerator'` is a property key; `` `2025-${'11'}-25` `` is a
 * date; `cond ? 'x' : y` hides a value in the arm a single-value fold throws
 * away. Neither gate saw any of it.
 *
 * The fold lives here rather than in either gate because both need exactly the
 * same answer, and two copies of a security-relevant helper are two things
 * that drift. It is excluded from the production build (`tsconfig.json`) and
 * type-checked by ts-jest at test time, where its callers live.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/** Strip the wrappers that never change a value. */
export function unwrap(node: ts.Node): ts.Node {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
    return unwrap(node.expression);
  }
  return node;
}

/**
 * Every string this expression can evaluate to, statically. Empty means the
 * gate could not resolve it — which is itself information, and its callers
 * treat it as such rather than as "nothing to see".
 *
 * A conditional contributes BOTH arms on purpose.
 */
export function foldStrings(node: ts.Node): string[] {
  const target = unwrap(node);
  if (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target)) return [target.text];
  if (ts.isNumericLiteral(target)) return [target.text];
  if (ts.isTemplateExpression(target)) {
    let combos = [target.head.text];
    for (const span of target.templateSpans) {
      const parts = foldStrings(span.expression);
      if (parts.length === 0) return [];
      combos = combos.flatMap((prefix) => parts.map((part) => prefix + part + span.literal.text));
    }
    return combos;
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldStrings(target.left);
    const right = foldStrings(target.right);
    if (left.length === 0 || right.length === 0) return [];
    return left.flatMap((l) => right.map((r) => l + r));
  }
  if (ts.isConditionalExpression(target)) {
    return [...foldStrings(target.whenTrue), ...foldStrings(target.whenFalse)];
  }
  // Round-3 verdict `5cb6ff8a` B1/B3: `.concat()`, `[…].join('')` and
  // `String.fromCharCode(…)` are ordinary ways to write a constant, and a fold
  // that stops at `+` sees none of them.
  if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)) {
    const receiver = unwrap(target.expression.expression);
    const method = target.expression.name.text;
    if (method === 'concat') {
      let combos = foldStrings(receiver);
      if (combos.length === 0) return [];
      for (const argument of target.arguments) {
        const parts = foldStrings(argument);
        if (parts.length === 0) return [];
        combos = combos.flatMap((prefix) => parts.map((part) => prefix + part));
      }
      return combos;
    }
    if (method === 'join' && ts.isArrayLiteralExpression(receiver)) {
      const separators = target.arguments.length === 0 ? [','] : foldStrings(target.arguments[0]);
      if (separators.length === 0) return [];
      let combos = [''];
      let first = true;
      for (const element of receiver.elements) {
        const parts = foldStrings(element);
        if (parts.length === 0) return [];
        combos = combos.flatMap((prefix) => parts.flatMap(
          (part) => separators.map((sep) => (first ? part : prefix + sep + part)),
        ));
        first = false;
      }
      return receiver.elements.length === 0 ? [''] : combos;
    }
  }
  if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)
    && ts.isIdentifier(unwrap(target.expression.expression))
    && (unwrap(target.expression.expression) as ts.Identifier).text === 'String'
    && target.expression.name.text === 'fromCharCode') {
    const codes = target.arguments.map((argument) => {
      const value = unwrap(argument);
      return ts.isNumericLiteral(value) ? Number(value.text) : NaN;
    });
    if (codes.some(Number.isNaN)) return [];
    return [String.fromCharCode(...codes)];
  }
  if (ts.isTaggedTemplateExpression(target)) return foldStrings(target.template);
  return [];
}

/** True when this node is inside a larger expression the fold already covers. */
export function nestedInFoldable(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isTemplateSpan(parent) || ts.isConditionalExpression(parent)
    || ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)
    || ts.isTaggedTemplateExpression(parent) || ts.isArrayLiteralExpression(parent)) return true;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) return true;
  // The receiver and arguments of a foldable call are folded WITH the call, so
  // reporting them separately would say the same thing twice.
  if (ts.isPropertyAccessExpression(parent) && parent.parent
    && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
    return ['concat', 'join', 'fromCharCode'].includes(parent.name.text);
  }
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    return ['concat', 'join', 'fromCharCode'].includes(parent.expression.name.text);
  }
  return false;
}

/** Expression kinds `foldStrings` can resolve — the set worth folding AT. */
export function isFoldableNode(node: ts.Node): boolean {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isTemplateExpression(node) || ts.isBinaryExpression(node)
    || ts.isConditionalExpression(node) || ts.isCallExpression(node)
    || ts.isTaggedTemplateExpression(node);
}

export interface SurfaceFile { file: string; source: string }

/** Every `.ts` under a directory, recursively, in stable order. */
export function readSurface(root: string, prefix = ''): SurfaceFile[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) return readSurface(full, `${prefix}${entry.name}/`);
      if (!entry.name.endsWith('.ts')) return [];
      return [{ file: `${prefix}${entry.name}`, source: fs.readFileSync(full, 'utf8') }];
    });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Bare ISO dates a module can PRODUCE — folded, so a concatenation or a
 * template substitution counts, and so does a value in the unused arm of a
 * conditional. Comments are not expressions and are not scanned: the surface
 * documents the unreleased 2026-07-28 revision in prose, which §1.2 permits.
 */
export function authoredDateLiterals(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2020, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isFoldableNode(node) && !nestedInFoldable(node)) {
      for (const value of foldStrings(node)) {
        if (ISO_DATE.test(value)) found.push(`${file}: '${value}'`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
