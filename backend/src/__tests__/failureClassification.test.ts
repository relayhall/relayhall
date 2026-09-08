import fs from 'fs';
import path from 'path';
import { DatabaseError } from 'pg';
import {
  identifyCaughtFailure,
  isFailureCode,
  isErrorClassName,
  FAILURE_CODES,
  ERROR_CLASS_NAMES,
} from '../utils/failureClassification';

/**
 * The property under test is not "does it label things sensibly" but "can any
 * caught value push its own content into the result, or its own code into the
 * logging path". Every case carries a private marker somewhere a naive
 * implementation would read it from.
 */
const PRIVATE_MARKER = 'postgres://user:secret@db/private-row';

const databaseError = (code?: string): DatabaseError => {
  const error = new DatabaseError(PRIVATE_MARKER, PRIVATE_MARKER.length, 'error');
  if (code !== undefined) (error as { code?: string }).code = code;
  (error as { detail?: string }).detail = PRIVATE_MARKER;
  (error as { table?: string }).table = PRIVATE_MARKER;
  (error as { where?: string }).where = PRIVATE_MARKER;
  return error;
};

describe('identifyCaughtFailure', () => {
  it('maps tabled SQLSTATEs to their own constant', () => {
    expect(identifyCaughtFailure(databaseError('57014')).code).toBe('DB_STATEMENT_TIMEOUT');
    expect(identifyCaughtFailure(databaseError('40001')).code).toBe('DB_SERIALIZATION_FAILURE');
    expect(identifyCaughtFailure(databaseError('40P01')).code).toBe('DB_DEADLOCK');
    expect(identifyCaughtFailure(databaseError('53300')).code).toBe('DB_TOO_MANY_CONNECTIONS');
    expect(identifyCaughtFailure(databaseError('23505')).code).toBe('DB_UNIQUE_VIOLATION');
    expect(identifyCaughtFailure(databaseError('57014')).errorClass).toBe('DatabaseError');
  });

  it('reports an untabled SQLSTATE as DB_OTHER instead of reporting the SQLSTATE', () => {
    const identity = identifyCaughtFailure(databaseError('XX999'));
    expect(identity.code).toBe('DB_OTHER');
    expect(JSON.stringify(identity)).not.toContain('XX999');
  });

  it('returns the table constant, not the string read from the caught value', () => {
    // Same characters, different object. What comes back must be ours.
    const sqlstate = ['5', '7', '0', '1', '4'].join('');
    const identity = identifyCaughtFailure(databaseError(sqlstate));
    expect(identity.code).toBe('DB_STATEMENT_TIMEOUT');
    expect(FAILURE_CODES).toContain(identity.code);
  });

  // --- Review d89f50d8 B1: the leak this file was rejected for. -----------
  it('never invokes an accessor the caught value supplies for code', () => {
    const codeGetter = jest.fn(() => '57014');
    const caught = new DatabaseError('boom', 4, 'error');
    Object.defineProperty(caught, 'code', { get: codeGetter, configurable: true });

    const identity = identifyCaughtFailure(caught);

    expect(codeGetter).not.toHaveBeenCalled();
    expect(identity.code).toBe('DB_OTHER');
  });

  it('never invokes an accessor reached through a driver subclass prototype', () => {
    const codeGetter = jest.fn(() => '57014');
    class HostileDatabaseError extends DatabaseError {}
    Object.defineProperty(HostileDatabaseError.prototype, 'code', {
      get: codeGetter, configurable: true,
    });
    const caught = new HostileDatabaseError('boom', 4, 'error');

    const identity = identifyCaughtFailure(caught);

    expect(codeGetter).not.toHaveBeenCalled();
    expect(identity.code).toBe('DB_OTHER');
  });

  it('never invokes a constructor or name accessor', () => {
    const constructorGetter = jest.fn(() => ({ name: PRIVATE_MARKER }));
    const caught = new Error('boom');
    Object.defineProperty(Object.getPrototypeOf(caught), 'constructor', {
      get: constructorGetter, configurable: true,
    });
    try {
      const identity = identifyCaughtFailure(caught);
      expect(constructorGetter).not.toHaveBeenCalled();
      expect(identity.errorClass).toBe('UNKNOWN');
    } finally {
      Object.defineProperty(Object.getPrototypeOf(caught), 'constructor', {
        value: Error, writable: true, configurable: true,
      });
    }
  });

  it('does not inspect a non-Error value or trigger its accessors', () => {
    const constructorGetter = jest.fn(() => ({ name: PRIVATE_MARKER }));
    const codeGetter = jest.fn(() => PRIVATE_MARKER);
    const caught = {
      message: PRIVATE_MARKER,
      get constructor() { return constructorGetter(); },
      get code() { return codeGetter(); },
      toString: jest.fn(() => { throw new Error('caught value was coerced'); }),
    };

    const identity = identifyCaughtFailure(caught);

    expect(identity).toEqual({ category: 'NonError', errorClass: 'NonError', code: 'NON_ERROR' });
    expect(constructorGetter).not.toHaveBeenCalled();
    expect(codeGetter).not.toHaveBeenCalled();
    expect(caught.toString).not.toHaveBeenCalled();
  });

  it('answers INSPECTION_REFUSED instead of throwing when a trap throws', () => {
    const hostile = new Proxy(new Error('boom'), {
      getPrototypeOf() { throw new Error(`trap:${PRIVATE_MARKER}`); },
      getOwnPropertyDescriptor() { throw new Error(`trap:${PRIVATE_MARKER}`); },
    });

    let identity!: ReturnType<typeof identifyCaughtFailure>;
    expect(() => { identity = identifyCaughtFailure(hostile); }).not.toThrow();
    expect(isFailureCode(identity.code)).toBe(true);
    expect(JSON.stringify(identity)).not.toContain(PRIVATE_MARKER);
  });

  // --- Class identity (R17), by registration rather than by reported name. --
  it('identifies a registered product error class', () => {
    class TaskNotFoundError extends Error {}
    expect(identifyCaughtFailure(new TaskNotFoundError(PRIVATE_MARKER)).errorClass)
      .toBe('TaskNotFoundError');
  });

  it('separates the built-in programming faults', () => {
    expect(identifyCaughtFailure(new TypeError(PRIVATE_MARKER)).errorClass).toBe('TypeError');
    expect(identifyCaughtFailure(new RangeError(PRIVATE_MARKER)).errorClass).toBe('RangeError');
    expect(identifyCaughtFailure(new SyntaxError(PRIVATE_MARKER)).errorClass).toBe('SyntaxError');
    expect(identifyCaughtFailure(new Error(PRIVATE_MARKER)).errorClass).toBe('Error');
  });

  it('reduces an unregistered class name to UNKNOWN rather than reporting it', () => {
    const Hostile = class extends Error {};
    Object.defineProperty(Hostile, 'name', { value: `Private_${PRIVATE_MARKER}` });
    const identity = identifyCaughtFailure(new Hostile(PRIVATE_MARKER));

    expect(identity.errorClass).toBe('UNKNOWN');
    expect(JSON.stringify(identity)).not.toContain(PRIVATE_MARKER);
  });

  it('reports a plain Error — the pool-acquisition timeout shape — as ERROR_UNCLASSIFIED', () => {
    // pg raises exactly this when a caller waits past connectionTimeoutMillis:
    // a plain Error with no code. Measured live on DEV at candidate e76ebe5.
    const identity = identifyCaughtFailure(new Error('timeout exceeded when trying to connect'));
    expect(identity.code).toBe('ERROR_UNCLASSIFIED');
    expect(identity.errorClass).toBe('Error');
  });

  it('only ever returns members of the closed sets', () => {
    const Hostile = class extends Error {};
    Object.defineProperty(Hostile, 'name', { value: PRIVATE_MARKER });
    const caughtValues: unknown[] = [
      databaseError('57014'), databaseError('XX999'), databaseError(),
      new TypeError(PRIVATE_MARKER), new RangeError(PRIVATE_MARKER),
      new SyntaxError(PRIVATE_MARKER), new ReferenceError(PRIVATE_MARKER),
      new URIError(PRIVATE_MARKER), new EvalError(PRIVATE_MARKER),
      new Hostile(PRIVATE_MARKER), new Error(PRIVATE_MARKER),
      PRIVATE_MARKER, 42, null, undefined, true, Symbol('s'),
      { message: PRIVATE_MARKER }, [PRIVATE_MARKER], Object.create(null),
    ];

    for (const caught of caughtValues) {
      const identity = identifyCaughtFailure(caught);
      expect(isFailureCode(identity.code)).toBe(true);
      expect(isErrorClassName(identity.errorClass)).toBe(true);
      expect(JSON.stringify(identity)).not.toContain(PRIVATE_MARKER);
    }
  });
});

describe('the error-class registry stays current with the source tree', () => {
  const sourceRoot = path.join(__dirname, '..');

  const sourceFiles = (directory: string): string[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
      return entry.isFile() && full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
    });

  it('registers every error class declared under backend/src', () => {
    const declared = new Set<string>();
    for (const file of sourceFiles(sourceRoot)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/class\s+([A-Za-z0-9_]+)\s+extends\s+[A-Za-z0-9_.]*Error\b/g)) {
        declared.add(match[1]);
      }
    }

    // If this fails, add the new class to ERROR_CLASS_NAMES. An unregistered
    // class logs as UNKNOWN, which silently costs the diagnostic 590e88cc
    // exists to provide.
    const unregistered = [...declared].filter(name => !ERROR_CLASS_NAMES.includes(name as never));
    expect(unregistered).toEqual([]);
    expect(declared.size).toBeGreaterThan(20);
  });
});
