import fs from 'fs';
import path from 'path';
import { DatabaseError } from 'pg';
import { logCaughtFailure, logCaughtWarning } from '../utils/secretSafeLog';
import { isFailureCode, isErrorClassName } from '../utils/failureClassification';

const LINE = /^(.*) \((Error|NonError)\) \[class=([A-Za-z0-9_]+) code=([A-Z_]+) id=([0-9a-f-]{36})\]$/;

const parseLine = (line: string) => {
  const match = LINE.exec(line);
  if (!match) throw new Error(`log line did not match the sink's published shape: ${line}`);
  return { context: match[1], category: match[2], errorClass: match[3], code: match[4], id: match[5] };
};

describe('logCaughtFailure', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('logs only fixed context, the bounded category, registered class, closed-set code and a generated id', () => {
    const privateMarker = 'postgres://user:secret@db/private-row';
    const error = new Error(privateMarker);
    error.name = `PrivateName:${privateMarker}`;
    error.stack = `PrivateStack:${privateMarker}`;

    const failureId = logCaughtFailure('[Projects API] list failed', error);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = parseLine(errorSpy.mock.calls[0][0]);
    expect(line.context).toBe('[Projects API] list failed');
    expect(line.category).toBe('Error');
    expect(line.errorClass).toBe('Error');
    expect(line.code).toBe('ERROR_UNCLASSIFIED');
    expect(line.id).toBe(failureId);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateMarker);
  });

  it('does not coerce or inspect a non-Error caught value', () => {
    const privateMarker = 'private-non-error-value';
    const caught = {
      message: privateMarker,
      toString: jest.fn(() => {
        throw new Error('caught value was coerced');
      }),
    };

    expect(() => logCaughtFailure('[Tasks API] create failed', caught)).not.toThrow();

    expect(caught.toString).not.toHaveBeenCalled();
    const line = parseLine(errorSpy.mock.calls[0][0]);
    expect(line.category).toBe('NonError');
    expect(line.errorClass).toBe('NonError');
    expect(line.code).toBe('NON_ERROR');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateMarker);
  });

  it('preserves warning severity without exposing the caught value', () => {
    const privateMarker = 'private-warning-detail';

    logCaughtWarning('[Startup] optional subsystem unavailable', new Error(privateMarker));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = parseLine(warnSpy.mock.calls[0][0]);
    expect(line.context).toBe('[Startup] optional subsystem unavailable');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateMarker);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('publishes a database failure by its own constant, never the driver detail', () => {
    const privateMarker = 'private-row-value';
    const error = new DatabaseError(privateMarker, privateMarker.length, 'error');
    (error as { code?: string }).code = '57014';
    (error as { detail?: string }).detail = privateMarker;
    (error as { table?: string }).table = privateMarker;

    logCaughtFailure('[Tasks API] Error loading board:', error);

    const line = parseLine(errorSpy.mock.calls[0][0]);
    expect(line.errorClass).toBe('DatabaseError');
    expect(line.code).toBe('DB_STATEMENT_TIMEOUT');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateMarker);
  });

  it('does not publish an untabled SQLSTATE, only that it was untabled', () => {
    const error = new DatabaseError('boom', 4, 'error');
    (error as { code?: string }).code = 'XX999';

    logCaughtFailure('[Tasks API] Error loading board:', error);

    expect(parseLine(errorSpy.mock.calls[0][0]).code).toBe('DB_OTHER');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('XX999');
  });

  /**
   * Review d89f50d8 B1 reproduced exactly this: a getter on the caught value
   * ran inside the sink and appended its own marker to the emitted line, while
   * the published code stayed a legitimate closed-set constant. The assertion
   * is therefore on the WHOLE line, not just on the code.
   */
  it('runs no caught-value accessor, so nothing can be appended to the emitted line', () => {
    const marker = 'CAUGHT_PRIVATE_Z9Q7';
    const caught = new DatabaseError('boom', 4, 'error');
    let getterRan = false;
    Object.defineProperty(caught, 'code', {
      configurable: true,
      get() {
        getterRan = true;
        // What the reviewer's probe did: reach the sink from inside the read.
        // eslint-disable-next-line no-console
        console.error(`hijacked ${marker}`);
        return '57014';
      },
    });

    logCaughtFailure('[Probe] database getter', caught);

    expect(getterRan).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(marker);
    expect(parseLine(errorSpy.mock.calls[0][0]).code).toBe('DB_OTHER');
  });

  it('does not throw when the caught value is a hostile Proxy', () => {
    const hostile = new Proxy(new Error('boom'), {
      getPrototypeOf() { throw new Error('trap'); },
      getOwnPropertyDescriptor() { throw new Error('trap'); },
    });

    let id!: string;
    expect(() => { id = logCaughtFailure('[Tasks API] Error loading board:', hostile); }).not.toThrow();
    const line = parseLine(errorSpy.mock.calls[0][0]);
    expect(line.id).toBe(id);
    expect(isFailureCode(line.code)).toBe(true);
  });

  it('emits registered values and a fresh id on every call', () => {
    const first = logCaughtFailure('[Tasks API] Error listing tasks:', new Error('one'));
    const second = logCaughtFailure('[Tasks API] Error listing tasks:', new Error('two'));

    expect(first).not.toBe(second);
    for (const call of errorSpy.mock.calls) {
      const line = parseLine(call[0]);
      expect(isFailureCode(line.code)).toBe(true);
      expect(isErrorClassName(line.errorClass)).toBe(true);
    }
  });
});

describe('secret-safe source invariants', () => {
  const source = (relativePath: string): string => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

  it('does not publish an unhandled-rejection reason or its Promise', () => {
    const server = source('server.ts');
    const handler = server.slice(
      server.indexOf("process.on('unhandledRejection'"),
      server.indexOf("const app: Express", server.indexOf("process.on('unhandledRejection'")),
    );

    expect(handler).toContain("logCaughtFailure('[Server] unhandled promise rejection', reason)");
    expect(handler).not.toMatch(/console\.(?:error|warn|log)\([^;\n]*,\s*(?:reason|_?promise)\b/i);
    expect(handler).not.toMatch(/console\.(?:error|warn|log)\(\s*(?:reason|_?promise)\b/i);
  });

  it('keeps canonical-runtime failure detail fixed in logs and responses', () => {
    const tasks = source('routes/tasks.ts');
    const start = tasks.indexOf('canonicalRuntimeSignalService.listTaskSignals');
    const block = tasks.slice(start, tasks.indexOf('res.json({', start));

    expect(block).toContain("canonicalRuntimeError = 'canonical runtime lookup failed'");
    expect(block).toContain("logCaughtWarning('[Tasks API] Canonical runtime lookup failed', error)");
    expect(block).not.toMatch(/error\.message|String\(error\)|\$\{canonicalRuntimeError\}/);
  });

  it('does not alias model-catalog exception detail before logging', () => {
    const catalog = source('services/modelCatalog.ts');
    const start = catalog.indexOf('} catch (err: any)');
    const block = catalog.slice(start, catalog.indexOf('} finally {', start));

    expect(block).toContain("logCaughtWarning('[ModelCatalog] LiteLLM model discovery failed', err)");
    expect(block).not.toMatch(/\b(?:const|let)\s+msg\b|err\??\.message|String\(err\)/);
  });

  it('keeps the sink and the classifier free of direct caught-value member reads', () => {
    const sink = source('utils/secretSafeLog.ts');
    for (const call of sink.match(/console\.(?:error|warn)\([^;]*\);/g) ?? []) {
      expect(call).not.toMatch(/\bcaught\b/);
    }

    // Every read of the caught value must go through the descriptor helper.
    // `caught.code` / `caught.name` / `caught.constructor` is what B1 broke.
    const classifier = source('utils/failureClassification.ts');
    const body = classifier.slice(classifier.indexOf('function ownDataProperty'));
    expect(body).not.toMatch(/\bcaught\s*\.\s*(?!constructor\b)[A-Za-z_$]/);
    expect(body).toContain('Object.getOwnPropertyDescriptor');
  });
});
