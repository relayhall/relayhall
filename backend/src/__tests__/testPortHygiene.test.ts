/**
 * Card 7e66a6c2 — the control that keeps the port collision from coming back.
 *
 * Two suites bound the SAME fixed loopback port. jest runs test files in
 * parallel workers, so whether they collided was decided by worker scheduling:
 * the loser failed with EADDRINUSE and reported a different number of
 * assertions each run, which reads as a flaky change rather than as two suites
 * sharing a port.
 *
 * The rule this census enforces is the class the repair belongs to: a suite
 * that listens asks the kernel for a free port (bind 0) and reads the assigned
 * one back. Nothing under src/__tests__ may bind a port number written into the
 * test tree. The one endpoint that genuinely cannot move — the boot-check
 * pool's pinned endpoint, whose port is a PRODUCTION constant — is not an
 * exception: support/pinnedBootCheckEndpoint.ts reads that port out of
 * production and takes turns on it, so no literal is written here either.
 *
 * Known limit, stated rather than papered over: this is a textual census, so
 * `server.listen(chosenPort)` where `chosenPort` is a locally-defined constant
 * is invisible to it. That is the backstop's boundary, not a claim of universal
 * coverage — what makes the rule hold at runtime is that the only exclusive
 * endpoint in the tree is taken through the helper, and
 * pinnedEndpointExclusion.test.ts measures that.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const TESTS_ROOT = __dirname;

interface LiteralBind {
  file: string;
  line: number;
  port: number;
  source: string;
}

type Exemption = { file: string; line: number; port: number; why: string };

/**
 * VALUE-scoped exemptions: file, line AND the exact port, so an exemption
 * cannot silently cover a second literal that appears later in the same file.
 * There is deliberately no file-level or directory-level form.
 *
 * The list is EMPTY, and one of the tests below keeps it empty. The filter is
 * the mechanism; that assertion is the ratchet. Adding an entry reddens this
 * suite until the exemption has been argued and this control amended to accept
 * it — which is the point: an exemption should be a deliberate, reviewable act,
 * not a quiet append.
 */
const EXEMPTIONS: ReadonlyArray<Exemption> = [];

/**
 * The positional form, matched against the WHOLE file rather than line by line:
 * review round 1 finding F3 was that a call broken across lines — the shape a
 * formatter produces on a long argument list — walked past a line-anchored
 * scan. `\s` matches newlines, so this crosses line breaks; the line number is
 * recovered from the match offset. Port 0 is the rule, not a violation, so it
 * is recognised here and discarded by the caller.
 */
const POSITIONAL = /\.listen\s*\(\s*(\d[\d_]*)/g;

/** The start of an options-object call: `.listen({`. */
const OPTIONS_OPENER = /\.listen\s*\(\s*\{/g;

/** A `port:` at the top level of that object. */
const OPTIONS_PORT = /\bport\s*:\s*(\d[\d_]*)/g;

/** Every `.listen(` call site the census can see, literal port or not. */
const ANY_LISTEN = /\.listen\s*\(/g;

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function sourceOf(content: string, index: number): string {
  const from = content.lastIndexOf('\n', index) + 1;
  const to = content.indexOf('\n', index);
  return content.slice(from, to === -1 ? content.length : to).trim();
}

/** The index of the `}` or `]` closing the bracket at `open`, or -1. */
function closingBracket(content: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '[': ']' };
  const stack: string[] = [pairs[content[open]]];
  for (let i = open + 1; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '{' || ch === '[') {
      stack.push(pairs[ch]);
    } else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * The same text with every NESTED object and array blanked to spaces, newlines
 * kept so offsets and line numbers survive.
 *
 * Review round 2 finding R2-F2: the options-object pattern used to stop at the
 * first `}`, so an options object carrying a nested object ahead of its port
 * — the literal behind it — was invisible. Blanking the nested
 * regions leaves exactly the keys of THIS object, which is what the rule is
 * about; a `port:` belonging to some inner object is not this call's port.
 */
function withoutNested(objectBody: string): string {
  const out = objectBody.split('');
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === '{' || out[i] === '[') {
      const end = closingBracket(objectBody, i);
      const stop = end === -1 ? out.length - 1 : end;
      for (let j = i; j <= stop; j += 1) {
        if (out[j] !== '\n') {
          out[j] = ' ';
        }
      }
      i = stop;
    }
  }
  return out.join('');
}

function literalBindsIn(file: string, content: string): LiteralBind[] {
  const found: LiteralBind[] = [];
  const record = (index: number, raw: string): void => {
    const port = Number(raw.replace(/_/g, ''));
    if (port !== 0) {
      found.push({ file, line: lineOf(content, index), port, source: sourceOf(content, index) });
    }
  };

  POSITIONAL.lastIndex = 0;
  let positional = POSITIONAL.exec(content);
  while (positional !== null) {
    record(positional.index, positional[1]);
    positional = POSITIONAL.exec(content);
  }

  OPTIONS_OPENER.lastIndex = 0;
  let opener = OPTIONS_OPENER.exec(content);
  while (opener !== null) {
    const open = opener.index + opener[0].length - 1;
    const close = closingBracket(content, open);
    const body = withoutNested(content.slice(open + 1, close === -1 ? content.length : close));
    OPTIONS_PORT.lastIndex = 0;
    let port = OPTIONS_PORT.exec(body);
    while (port !== null) {
      // Reported at the line the CALL starts on: that is where a reader looks,
      // and a long options object can put the key many lines away.
      record(opener.index, port[1]);
      port = OPTIONS_PORT.exec(body);
    }
    opener = OPTIONS_OPENER.exec(content);
  }

  return found.sort((a, b) => a.line - b.line || a.port - b.port);
}

function countListenSites(content: string): number {
  return (content.match(ANY_LISTEN) ?? []).length;
}

function isSource(name: string): boolean {
  return /\.tsx?$/.test(name);
}

/**
 * A symbolic link to a source file is a source file. Review round 2 finding
 * R2-F3: both enumerations asked `isFile()`, which is false for a symlink, so a
 * linked `*.test.ts` was censused by neither and the two agreed on the same
 * incomplete set. Both now ask this instead.
 */
function isSourceEntry(dir: string, entry: fs.Dirent): boolean {
  if (!isSource(entry.name)) {
    return false;
  }
  if (entry.isFile()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return fs.statSync(path.join(dir, entry.name)).isFile();
  } catch {
    return false; // a broken link holds no source
  }
}

function parentOf(entry: fs.Dirent, fallback: string): string {
  // `parentPath` on current node, `path` on the release before it.
  const holder = entry as unknown as { parentPath?: string; path?: string };
  return holder.parentPath ?? holder.path ?? fallback;
}

/** The walk under test: hand-rolled recursion. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (isSourceEntry(dir, entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * An INDEPENDENT enumeration of the same tree, from node's own recursive
 * directory read. Review round 1 finding F4: a floor like "more than 100 files"
 * is satisfied by a walker that quietly stops descending into one subtree, so
 * the count proved nothing about completeness. Two implementations that must
 * agree exactly do — a regression in either one is a disagreement, and neither
 * is the census's own idea of what the tree contains.
 */
function enumerateIndependently(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => isSourceEntry(parentOf(entry, dir), entry))
    .map((entry) => path.join(parentOf(entry, dir), entry.name));
}

function relative(full: string): string {
  return path.relative(TESTS_ROOT, full).split(path.sep).join('/');
}

function coveredBy(bind: LiteralBind, exemptions: ReadonlyArray<Exemption>): boolean {
  return exemptions.some((e) => e.file === bind.file && e.line === bind.line && e.port === bind.port);
}

const FILES = walk(TESTS_ROOT);
const CENSUS = FILES.map((full) => {
  const content = fs.readFileSync(full, 'utf8');
  return {
    relative: relative(full),
    listenSites: countListenSites(content),
    literalBinds: literalBindsIn(relative(full), content),
  };
});

describe('no suite binds a port number written into the test tree', () => {
  it('reports no literal-port bind under src/__tests__', () => {
    const offenders = CENSUS.flatMap((f) => f.literalBinds).filter((b) => !coveredBy(b, EXEMPTIONS));
    expect(offenders.map((b) => `${b.file}:${b.line} binds ${b.port} — ${b.source}`)).toEqual([]);
  });

  it('carries no exemption', () => {
    // A non-empty list is not a pass with a note; it is a red until this
    // control is amended to expect the entry.
    expect(EXEMPTIONS).toEqual([]);
  });
});

describe('the census can see what it is censusing', () => {
  it('walked exactly the tree, measured against an enumeration it does not own', () => {
    const walked = FILES.map(relative).sort();
    const independent = enumerateIndependently(TESTS_ROOT).map(relative).sort();

    // Equality, not a floor: a walker that skips a subtree disagrees here even
    // though every count stays comfortably large.
    expect(walked).toEqual(independent);

    // And the tree is not empty, so the equality above is not two empty sets
    // agreeing.
    expect(walked.length).toBeGreaterThan(100);
    expect(CENSUS.reduce((total, f) => total + f.listenSites, 0)).toBeGreaterThan(60);

    // The suites that motivated the card must be among the files scanned.
    const scanned = new Set(walked);
    expect(scanned.has('bootCheckMode.test.ts')).toBe(true);
    expect(scanned.has('orchestrationConfigurationReachability.test.ts')).toBe(true);
    expect(scanned.has('support/pinnedBootCheckEndpoint.ts')).toBe(true);
  });

  it('counts a symbolic link to a source file as a source file', () => {
    // R2-F3: both enumerations asked isFile(), which a symlink is not, so a
    // linked test file was censused by neither and they agreed on the same
    // incomplete set. Measured on the shared predicate, in a real directory.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixg-symlink-'));
    try {
      fs.writeFileSync(path.join(root, 'target.test.ts'), 'x\n');
      fs.symlinkSync(path.join(root, 'target.test.ts'), path.join(root, 'linked.test.ts'));
      fs.symlinkSync(path.join(root, 'absent.test.ts'), path.join(root, 'broken.test.ts'));
      fs.writeFileSync(path.join(root, 'notes.md'), 'x\n');

      const seen = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => isSourceEntry(root, entry))
        .map((entry) => entry.name)
        .sort();

      expect(seen).toEqual(['linked.test.ts', 'target.test.ts']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects a literal bind when there is one to detect', () => {
    // Assembled rather than written out, so these fixtures are not themselves
    // violations the census above would report against its own file.
    const positional = ['    server', '.listen(', '59998', ", '127.0.0.1');"].join('');
    const options = ['    server', '.listen(', '{ port: ', '8080', ", host: '127.0.0.1' });"].join('');

    expect(literalBindsIn('fixture.ts', positional).map((b) => b.port)).toEqual([59998]);
    expect(literalBindsIn('fixture.ts', options).map((b) => b.port)).toEqual([8080]);
  });

  it('detects a literal bind broken across lines, and reports the line the call starts on', () => {
    // The shape a formatter produces on a long argument list — F3.
    const positional = ['\n\n    server', '.listen(', '\n      ', '59998', ",\n      '127.0.0.1',\n    );"].join('');
    const options = ['\n\n    server', '.listen(', '{\n      ', 'port: ', '8080', ",\n      host: '127.0.0.1',\n    });"].join('');

    expect(literalBindsIn('fixture.ts', positional).map((b) => [b.line, b.port])).toEqual([[3, 59998]]);
    expect(literalBindsIn('fixture.ts', options).map((b) => [b.line, b.port])).toEqual([[3, 8080]]);
  });

  it('detects a literal port behind a nested object or array', () => {
    // R2-F2, the reviewer's own input: the options scan used to stop at the
    // first closing brace, so anything nested ahead of `port` hid it.
    const nested = ['    server', '.listen(', '{ tls: { rejectUnauthorized: false }, ', 'port: ', '59998', ", host: '127.0.0.1' });"].join('');
    const array = ['    server', '.listen(', '{ backlogs: [1, 2, 3], ', 'port: ', '8080', ' });'].join('');
    const deep = ['    server', '.listen(', '{ a: { b: { c: [ { d: 1 } ] } },\n      ', 'port: ', '7000', ' });'].join('');

    expect(literalBindsIn('fixture.ts', nested).map((b) => b.port)).toEqual([59998]);
    expect(literalBindsIn('fixture.ts', array).map((b) => b.port)).toEqual([8080]);
    expect(literalBindsIn('fixture.ts', deep).map((b) => b.port)).toEqual([7000]);
  });

  it('does not report a port belonging to some inner object', () => {
    // The other half of the nesting rule: blanking the nested regions is what
    // makes the scan see THIS call's keys, so an inner port must not be
    // reported as if the call bound it.
    const inner = ['    server', '.listen(', '{ upstream: { ', 'port: ', '5432', ' }, port: 0 });'].join('');
    expect(literalBindsIn('fixture.ts', inner)).toEqual([]);
  });

  it('does not report the form the rule asks for', () => {
    const ephemeral = ['    server', '.listen(', '0', ", '127.0.0.1', done);"].join('');
    const spreadEphemeral = ['    server', '.listen(', '\n      ', '0', ',\n      done,\n    );'].join('');
    const derived = ['    server', '.listen(', 'endpoint.port', ', endpoint.host, done);'].join('');
    const derivedOptions = ['    server', '.listen(', '{ ', 'port: ', 'endpoint.port', ' });'].join('');

    expect(literalBindsIn('fixture.ts', ephemeral)).toEqual([]);
    expect(literalBindsIn('fixture.ts', spreadEphemeral)).toEqual([]);
    expect(literalBindsIn('fixture.ts', derived)).toEqual([]);
    expect(literalBindsIn('fixture.ts', derivedOptions)).toEqual([]);
  });

  it('an exemption covers only the value it names', () => {
    // The real matcher, not a restatement of it: a copy written here could be
    // edited to agree with whatever the filter above happened to do.
    const bind: LiteralBind = { file: 'a.ts', line: 7, port: 59998, source: '' };
    const exempted: Exemption[] = [{ file: 'a.ts', line: 7, port: 59998, why: 'fixture' }];

    expect(coveredBy(bind, exempted)).toBe(true);
    expect(coveredBy({ ...bind, line: 8 }, exempted)).toBe(false);
    expect(coveredBy({ ...bind, port: 59997 }, exempted)).toBe(false);
    expect(coveredBy({ ...bind, file: 'b.ts' }, exempted)).toBe(false);
    expect(coveredBy(bind, [])).toBe(false);
  });
});
