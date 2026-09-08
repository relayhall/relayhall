/**
 * __tests__/support/moduleMutation.ts — load a REAL source module with a
 * textual mutation applied, so a control can be switched off and the pair it
 * protects watched to go red.
 *
 * WHY THIS RATHER THAN A HAND-WRITTEN "BROKEN" COPY. A mutation drill proves
 * something only if the mutant is the SHIPPED code minus one control. A
 * hand-written stand-in proves that the stand-in behaves as written — and a
 * stand-in can be edited into agreement with the assertion, which is the
 * failure class this project has been burned by. Here the mutant is produced
 * from the shipped file at run time: if the shipped text ever stops containing
 * the anchor, `applyMutations` throws rather than silently drilling nothing.
 *
 * The module is transpiled with the project's own TypeScript and evaluated in
 * a CommonJS shim whose `require` is this file's `require` — so a mutated
 * module still sees the REAL `node:https`, `node:dns` and its real siblings,
 * and only the mutated file differs from production.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export interface Mutation {
  /** Text that must occur EXACTLY ONCE in the shipped source. */
  find: string;
  /** What replaces it. */
  replace: string;
}

const backendSrc = path.join(__dirname, '..', '..');

export function readShippedSource(relativePath: string): string {
  return fs.readFileSync(path.join(backendSrc, relativePath), 'utf8');
}

export function applyMutations(source: string, mutations: Mutation[]): string {
  let out = source;
  for (const mutation of mutations) {
    const occurrences = out.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `mutation anchor must occur exactly once, found ${occurrences}: ${mutation.find.slice(0, 80)}`,
      );
    }
    out = out.replace(mutation.find, mutation.replace);
  }
  if (mutations.length > 0 && out === source) {
    throw new Error('mutation produced an identical module');
  }
  return out;
}

/**
 * Load `relativePath` (relative to `backend/src`) with `mutations` applied.
 * `overrides` lets a caller substitute a sibling module by its import
 * specifier — used to hand a mutated policy module to the dial client.
 */
export function loadMutatedModule<T = Record<string, unknown>>(
  relativePath: string,
  mutations: Mutation[],
  overrides: Record<string, unknown> = {},
): T {
  const source = applyMutations(readShippedSource(relativePath), mutations);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: relativePath,
  }).outputText;

  const moduleExports: Record<string, unknown> = {};
  const shim = { exports: moduleExports };
  const dirname = path.dirname(path.join(backendSrc, relativePath));
  const localRequire = (specifier: string): unknown => {
    if (Object.prototype.hasOwnProperty.call(overrides, specifier)) return overrides[specifier];
    if (specifier.startsWith('.')) return require(path.join(dirname, specifier));
    return require(specifier);
  };

  // eslint-disable-next-line no-new-func
  const factory = new Function('exports', 'require', 'module', '__filename', '__dirname', transpiled);
  factory(moduleExports, localRequire, shim, path.join(backendSrc, relativePath), dirname);
  return shim.exports as T;
}
