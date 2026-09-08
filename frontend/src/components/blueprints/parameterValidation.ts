import type { BlueprintParameter, BlueprintValue } from '../../types/blueprint';

interface PatternToken { accepts: (character: string) => boolean; min: number; max: number }
/** Bounded pattern language matching the portable-document validator. It never
 * compiles a document's pattern with the browser's backtracking regex engine. */
export function matchesBlueprintPattern(pattern: string, value: string): boolean {
  const invalid = (): never => { throw new Error('Unsupported parameter pattern'); };
  if (pattern.length > 200 || !pattern.startsWith('^') || !pattern.endsWith('$')) invalid();
  const source = pattern.slice(1, -1); const tokens: PatternToken[] = [];
  for (let i = 0; i < source.length;) {
    let accepts: (character: string) => boolean;
    if (source[i] === '[') {
      const end = source.indexOf(']', i + 1); if (end < 0) invalid();
      const body = source.slice(i + 1, end); if (!body || /[^A-Za-z0-9 _-]/.test(body)) invalid();
      const allowed = new Set<string>();
      for (let k = 0; k < body.length; k++) {
        if (k + 2 < body.length && body[k + 1] === '-') {
          const start = body.charCodeAt(k), stop = body.charCodeAt(k + 2);
          if (stop < start || stop - start > 128) invalid();
          for (let n = start; n <= stop; n++) allowed.add(String.fromCharCode(n)); k += 2;
        } else allowed.add(body[k]);
      }
      accepts = c => allowed.has(c); i = end + 1;
    } else {
      let literal = source[i++];
      if (literal === '\\') { literal = source[i++]; if (!literal || !'-_. '.includes(literal)) invalid(); }
      else if (!/[A-Za-z0-9 _-]/.test(literal)) invalid();
      accepts = c => c === literal;
    }
    let min = 1, max = 1;
    if (source[i] === '{') {
      const end = source.indexOf('}', i); const bounds = /^\{([0-9]{1,4})(?:,([0-9]{1,4}))?\}$/.exec(source.slice(i, end + 1));
      if (!bounds) invalid();
      min = Number(bounds![1]); max = Number(bounds![2] ?? bounds![1]);
      if (min > max || max > 8192) invalid(); i = end + 1;
    } else if (source[i] === '?') { min = 0; i++; }
    tokens.push({ accepts, min, max });
  }
  if (value.length > 8192) return false;
  let positions = new Set([0]);
  for (const token of tokens) {
    const next = new Set<number>(); let runStart = 0; const reachable = new Int32Array(value.length + 2);
    for (let i = 0; i <= value.length; i++) reachable[i + 1] = reachable[i] + Number(positions.has(i));
    for (let end = 0; end <= value.length; end++) {
      if (end > 0 && !token.accepts(value[end - 1])) runStart = end;
      const low = Math.max(runStart, end - token.max), high = end - token.min;
      if (high >= low && reachable[high + 1] > reachable[low]) next.add(end);
    }
    positions = next;
  }
  return positions.has(value.length);
}
export function parameterError(parameter: BlueprintParameter, value: BlueprintValue | undefined): string | null {
  if (value === undefined || value === null || value === '') return parameter.required ? 'An answer is required.' : null;
  const constraints = parameter.constraints || {};
  if (parameter.type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 'Enter a whole number.';
    if (constraints.min != null && value < constraints.min) return `Enter at least ${constraints.min}.`;
    if (constraints.max != null && value > constraints.max) return `Enter no more than ${constraints.max}.`;
  } else if (parameter.type === 'boolean') {
    if (typeof value !== 'boolean') return 'Choose Yes or No.';
  } else {
    if (typeof value !== 'string') return 'Enter text.';
    if (constraints.minLength != null && value.length < constraints.minLength) return `Use at least ${constraints.minLength} characters.`;
    if (constraints.maxLength != null && value.length > constraints.maxLength) return `Use no more than ${constraints.maxLength} characters.`;
    if (parameter.type === 'enum' && !constraints.enum?.includes(value)) return 'Choose one of the listed answers.';
    if (parameter.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter a date as YYYY-MM-DD.';
    if (constraints.pattern) {
      try { if (!matchesBlueprintPattern(constraints.pattern, value)) return 'The answer does not match the required format.'; }
      catch { return 'This parameter uses a pattern that cannot be validated here.'; }
    }
  }
  return null;
}
