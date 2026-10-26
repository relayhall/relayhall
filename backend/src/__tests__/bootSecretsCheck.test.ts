/**
 * The backend's entry point refuses the `.env.example` placeholder secrets
 * BEFORE anything else loads, with the reason on stderr and exit status 1.
 *
 * A refusal thrown later, from a module `server.ts` imports after it installs
 * its process-wide exception handler, is logged by class only and the process
 * exits 0 with nothing listening: a real boot of the image showed exactly that
 * for the JWT placeholder. So the check is the first import of `server.ts`,
 * and this suite pins both the behaviour and the position.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

const ENV_EXAMPLE = readFileSync(join(__dirname, '..', '..', '..', '.env.example'), 'utf8');
const example = (name: string) => ENV_EXAMPLE.split('\n')
  .find((line) => line.startsWith(`${name}=`))!.slice(name.length + 1).trim();

// Any value that is not a placeholder. Deliberately low-entropy: these are not
// secrets, and must not read as one to the publication gate's scanner.
const NOT_A_PLACEHOLDER_SECRET = 'x'.repeat(48);
const NOT_A_PLACEHOLDER_PASSWORD = 'y'.repeat(32);

function load(env: Record<string, string | undefined>): { exitCode: number | undefined; stderr: string } {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let exitCode: number | undefined;
  let stderr = '';
  const exit = jest.spyOn(process, 'exit')
    .mockImplementation(((code?: number) => { exitCode = code ?? 0; return undefined as never; }) as never);
  const write = jest.spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: unknown) => { stderr += String(chunk); return true; }) as never);
  try {
    jest.isolateModules(() => { require('../config/bootSecretsCheck'); });
  } finally {
    exit.mockRestore();
    write.mockRestore();
    process.env = saved;
  }
  return { exitCode, stderr };
}

describe('the boot check', () => {
  it('exits 1 naming JWT_SECRET for the JWT placeholder', () => {
    const result = load({ JWT_SECRET: example('JWT_SECRET'), DB_PASSWORD: NOT_A_PLACEHOLDER_PASSWORD });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/JWT_SECRET is still the placeholder/);
    expect(result.stderr).not.toContain(example('JWT_SECRET'));
  });

  it('exits 1 naming POSTGRES_PASSWORD for the database placeholder', () => {
    const result = load({ JWT_SECRET: NOT_A_PLACEHOLDER_SECRET, DB_PASSWORD: example('POSTGRES_PASSWORD') });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/POSTGRES_PASSWORD \(passed to the backend as DB_PASSWORD\)/);
    expect(result.stderr).not.toContain(example('POSTGRES_PASSWORD'));
  });

  it('names both when both are placeholders', () => {
    const result = load({ JWT_SECRET: example('JWT_SECRET'), DB_PASSWORD: example('POSTGRES_PASSWORD') });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/JWT_SECRET/);
    expect(result.stderr).toMatch(/POSTGRES_PASSWORD/);
  });

  it('does nothing for any other values, or none', () => {
    expect(load({ JWT_SECRET: NOT_A_PLACEHOLDER_SECRET, DB_PASSWORD: NOT_A_PLACEHOLDER_PASSWORD }))
      .toEqual({ exitCode: undefined, stderr: '' });
    expect(load({ JWT_SECRET: undefined, DB_PASSWORD: undefined })).toEqual({ exitCode: undefined, stderr: '' });
  });
});

describe('its position', () => {
  it('is the first statement of server.ts, so it runs before any other module loads', () => {
    const source = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
    const file = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
    const first = file.statements[0];
    expect(ts.isImportDeclaration(first)).toBe(true);
    expect(((first as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral).text).toBe('./config/bootSecretsCheck');
  });
});
