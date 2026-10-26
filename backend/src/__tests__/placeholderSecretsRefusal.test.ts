/**
 * The backend refuses to start on the two secrets `.env.example` ships as
 * placeholders.
 *
 * `.env.example` is the file an operator copies when they set an install up by
 * hand instead of through `./setup.sh`. Two of its lines are placeholders that
 * must never reach a running board: `JWT_SECRET` (anyone who reads the public
 * file could sign a dashboard token the board accepts) and `POSTGRES_PASSWORD`
 * (the database role's password, passed to the backend as `DB_PASSWORD`).
 * Before this check the backend accepted both: `getJwtSecret()` refused only an
 * empty value.
 *
 * The placeholders are READ FROM `.env.example` itself, never restated here, so
 * this suite and the file it guards cannot drift apart: if the example's text
 * changes, the refusal must change with it or this suite goes red.
 *
 * The check compares with the literal placeholders only. Any other value,
 * including one that merely contains the placeholder, is accepted unchanged.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ENV_EXAMPLE = readFileSync(join(__dirname, '..', '..', '..', '.env.example'), 'utf8');

function exampleValue(name: string): string {
  const line = ENV_EXAMPLE.split('\n').find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`.env.example has no ${name}= line`);
  const value = line.slice(name.length + 1).trim();
  if (!value) throw new Error(`.env.example's ${name} is empty`);
  return value;
}

const JWT_PLACEHOLDER = exampleValue('JWT_SECRET');
const DB_PLACEHOLDER = exampleValue('POSTGRES_PASSWORD');

describe('the .env.example placeholders are the ones the check knows', () => {
  it('reads two non-trivial placeholders from the shipped example', () => {
    expect(JWT_PLACEHOLDER.length).toBeGreaterThan(8);
    expect(DB_PLACEHOLDER.length).toBeGreaterThan(8);
  });
});

describe('JWT_SECRET', () => {
  const saved = process.env.JWT_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = saved;
  });

  function freshSecrets(): typeof import('../config/secrets') {
    let loaded: typeof import('../config/secrets') | undefined;
    jest.isolateModules(() => {
      loaded = require('../config/secrets');
    });
    return loaded as typeof import('../config/secrets');
  }

  it('refuses the .env.example placeholder, naming the variable and the fix', () => {
    process.env.JWT_SECRET = JWT_PLACEHOLDER;
    const { getJwtSecret } = freshSecrets();
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET/);
    expect(() => getJwtSecret()).toThrow(/\.env\.example/);
    expect(() => getJwtSecret()).toThrow(/setup\.sh/);
  });

  it('never echoes the refused value', () => {
    process.env.JWT_SECRET = JWT_PLACEHOLDER;
    const { getJwtSecret } = freshSecrets();
    let message = '';
    try { getJwtSecret(); } catch (error) { message = (error as Error).message; }
    expect(message).not.toBe('');
    expect(message).not.toContain(JWT_PLACEHOLDER);
  });

  it('accepts any other value, including one that only contains the placeholder', () => {
    for (const value of [`${JWT_PLACEHOLDER}-2`, `x${JWT_PLACEHOLDER}`, 'an-invented-signing-secret-0123456789']) {
      process.env.JWT_SECRET = value;
      const { getJwtSecret } = freshSecrets();
      expect(getJwtSecret()).toBe(value);
    }
  });

  it('still refuses an empty value', () => {
    process.env.JWT_SECRET = '';
    const { getJwtSecret } = freshSecrets();
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET environment variable is required/);
  });
});

describe('DB_PASSWORD (POSTGRES_PASSWORD in .env)', () => {
  const saved = process.env.DB_PASSWORD;
  afterEach(() => {
    if (saved === undefined) delete process.env.DB_PASSWORD;
    else process.env.DB_PASSWORD = saved;
  });

  function loadConnection(): unknown {
    let loaded: unknown;
    jest.isolateModules(() => {
      loaded = require('../db/connection');
    });
    return loaded;
  }

  it('the database module refuses to load with the .env.example placeholder', () => {
    process.env.DB_PASSWORD = DB_PLACEHOLDER;
    expect(() => loadConnection()).toThrow(/POSTGRES_PASSWORD/);
    expect(() => loadConnection()).toThrow(/\.env\.example/);
  });

  it('never echoes the refused value', () => {
    process.env.DB_PASSWORD = DB_PLACEHOLDER;
    let message = '';
    try { loadConnection(); } catch (error) { message = (error as Error).message; }
    expect(message).not.toBe('');
    expect(message).not.toContain(DB_PLACEHOLDER);
  });

  it('loads with any other value, and with none', () => {
    process.env.DB_PASSWORD = `${DB_PLACEHOLDER}-2`;
    expect(() => loadConnection()).not.toThrow();
    delete process.env.DB_PASSWORD;
    expect(() => loadConnection()).not.toThrow();
  });
});
