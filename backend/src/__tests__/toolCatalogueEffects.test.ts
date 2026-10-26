/**
 * toolCatalogueEffects - every Tools page label is pinned to what the tool's
 * handler does (card 11276e77, owner ruling D24).
 *
 * The dashboard labels each built-in tool Session setup, Read-only or Board
 * changes. Until D24 it derived that from the bootstrap PLANE, which decides
 * admission and not nature: five read-only tools were gated as `work` and so
 * showed as "Board changes". The label now comes from `toolEffect()`, and this
 * suite is the control that keeps it true.
 *
 * ── Where the expectation comes from ──
 *
 * Not from the field under test. `readOnly` and `plane` are what the catalogue
 * is built from, so an expectation read from them would agree with any mislabel
 * (`c4McpBootstrapGate` makes the same point about its exempt set). Not from a
 * hand-copied list of labels either: a copy can be edited to agree with the
 * code. The expectation is read off the HANDLER. Every registry handler reaches
 * the board through `board(ctx, { method, ... })` or `callBoard(...)`, so the
 * scan parses the shipped `registry.ts` and collects the `method` of every
 * board call inside each tool's handler:
 *
 *   - every call a literal `'GET'`  -> the handler can only read   -> `read`
 *   - any other literal, or an expression the scan cannot resolve (a ternary,
 *     a shorthand, a variable)       -> it can change the board     -> `change`
 *   - no board call found at all    -> unknown: the test FAILS rather than
 *     calling a handler it cannot see through read-only
 *
 * Three handlers read with a POST because the request carries a body that does
 * not fit a query string: the knowledge search and the two Blueprint previews.
 * They are named in POST_AS_READ below, and each exception must also be a
 * POST-only handler whose own description says it reads or writes nothing, so
 * the list cannot excuse a tool that really writes.
 */
import express from 'express';
import { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import router from '../routes/toolCatalogue';
import { MCP_TOOLS } from '../mcp/registry';

type Effect = 'session' | 'read' | 'change';
type Entry = { name: string; description: string; plane: string; effect: string };

const REGISTRY_FILE = join(__dirname, '..', 'mcp', 'registry.ts');

/**
 * Handlers that read through a POST. Written out on purpose and reviewed as
 * text; each line is a claim the second test below re-measures.
 *   relayhall_knowledge_source_search - POST /knowledge-queries: the query text
 *     travels in the body; the route returns coverage and results.
 *   relayhall_blueprint_preview, relayhall_blueprint_setup_preview - POST
 *     .../preview: the plan travels in the body; the services only SELECT.
 */
const POST_AS_READ = [
  'relayhall_knowledge_source_search',
  'relayhall_blueprint_preview',
  'relayhall_blueprint_setup_preview',
];

const SELF_DECLARED_READ = /\bRead-only\b|\bWrites nothing\b/;

/** The `method` of every board call inside each tool handler, by tool name. */
function handlerMethods(sourceText: string): Map<string, string[]> {
  const source = ts.createSourceFile(REGISTRY_FILE, sourceText, ts.ScriptTarget.Latest, true);
  const literal = (node: ts.Node | undefined): string | undefined =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
  const keyOf = (name: ts.PropertyName | undefined): string | undefined =>
    name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
  const walk = (node: ts.Node, visit: (inner: ts.Node) => void): void => {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  };
  const found = new Map<string, string[]>();
  walk(source, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const own = new Map<string, ts.ObjectLiteralElementLike>();
    for (const property of node.properties) {
      const key = keyOf(property.name);
      if (key) own.set(key, property);
    }
    const nameProperty = own.get('name');
    const handler = own.get('handler');
    const toolName = nameProperty && ts.isPropertyAssignment(nameProperty) ? literal(nameProperty.initializer) : undefined;
    if (!toolName || !toolName.startsWith('relayhall_') || !handler) return;
    const methods: string[] = [];
    walk(handler, (inner) => {
      if (ts.isPropertyAssignment(inner) && keyOf(inner.name) === 'method') {
        methods.push(literal(inner.initializer) ?? `<${inner.initializer.getText(source)}>`);
      } else if (ts.isShorthandPropertyAssignment(inner) && inner.name.text === 'method') {
        methods.push('<method>');
      }
    });
    if (found.has(toolName)) throw new Error(`registry declares ${toolName} twice`);
    found.set(toolName, methods);
  });
  return found;
}

/** What a handler with these board calls does, or why that cannot be said. */
function effectOf(plane: string, name: string, methods: string[]): Effect {
  if (plane === 'bootstrap') return 'session';
  if (methods.length === 0) throw new Error(`${name}: no board call found in its handler, so its nature is unknown`);
  const writes = methods.filter((method) => method !== 'GET');
  if (writes.length === 0) return 'read';
  // The exception forgives a POST and nothing else.
  return POST_AS_READ.includes(name) && writes.every((method) => method === 'POST') ? 'read' : 'change';
}

async function servedCatalogue(): Promise<Entry[]> {
  const app = express(); app.use('/tool-catalogue', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/tool-catalogue`);
    expect(response.status).toBe(200);
    return (await response.json() as { tools: Entry[] }).tools;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const SHIPPED = handlerMethods(readFileSync(REGISTRY_FILE, 'utf8'));

describe('catalogue labels are pinned to the handler, not to the plane', () => {
  it('the scan sees every registered tool and a board call in each', () => {
    expect([...SHIPPED.keys()].sort()).toEqual(MCP_TOOLS.map((tool) => tool.name).sort());
    expect([...SHIPPED].filter(([, methods]) => methods.length === 0).map(([name]) => name)).toEqual([]);
  });

  it('every served effect equals what the tool\'s handler does', async () => {
    const tools = await servedCatalogue();
    expect(tools.length).toBe(MCP_TOOLS.length);
    const mismatches = tools.flatMap((tool) => {
      const methods = SHIPPED.get(tool.name) ?? [];
      const expected = effectOf(tool.plane, tool.name, methods);
      return tool.effect === expected
        ? []
        : [`${tool.name} (plane ${tool.plane}, board calls ${methods.join('/')}): labelled '${tool.effect}', handler is '${expected}'`];
    });
    expect(mismatches).toEqual([]);
  });

  it('the only effects served are the three the page can label', async () => {
    const tools = await servedCatalogue();
    expect([...new Set(tools.map((tool) => tool.effect))].sort()).toEqual(['change', 'read', 'session']);
  });

  it('a description that says the tool only reads is never served as a board change', async () => {
    const contradictions = (await servedCatalogue())
      .filter((tool) => SELF_DECLARED_READ.test(tool.description) && tool.effect === 'change')
      .map((tool) => tool.name);
    expect(contradictions).toEqual([]);
  });

  it('each POST-as-read exception is a POST-only handler that declares itself read-only', () => {
    for (const name of POST_AS_READ) {
      const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect(SHIPPED.get(name)?.length).toBeGreaterThan(0);
      expect(SHIPPED.get(name)!.every((method) => method === 'POST')).toBe(true);
      expect(tool!.description).toMatch(SELF_DECLARED_READ);
      expect(tool!.readOnly).toBe(true);
    }
  });

  it('bootstrap admission is untouched: a read-only work tool is still gated', () => {
    // The label is not the gate. Declaring a work tool read-only must not move
    // it out of the plane the bootstrap middleware refuses.
    for (const name of ['relayhall_knowledge_source_search', 'relayhall_knowledge_source_get', 'relayhall_blueprint_list',
      'relayhall_blueprint_get', 'relayhall_service_review_requests']) {
      const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
      expect([name, tool?.plane, tool?.readOnly]).toEqual([name, 'work', true]);
    }
  });
});

describe('the scan is a control with teeth', () => {
  const shipped = readFileSync(REGISTRY_FILE, 'utf8');

  it('moving a read handler to PATCH turns its derived effect into a change', () => {
    const mutated = shipped.replace(
      "blueprintBoard(ctx, { method: 'GET', path: '/blueprints', requiredScope",
      "blueprintBoard(ctx, { method: 'PATCH', path: '/blueprints', requiredScope");
    expect(mutated).not.toBe(shipped);
    const methods = handlerMethods(mutated).get('relayhall_blueprint_list')!;
    expect(effectOf('work', 'relayhall_blueprint_list', methods)).toBe('change');
  });

  it('a method the scan cannot resolve counts as a possible write', () => {
    const mutated = shipped.replace(
      "blueprintBoard(ctx, { method: 'GET', path: '/blueprints', requiredScope",
      "blueprintBoard(ctx, { method: String(args.limit), path: '/blueprints', requiredScope");
    expect(mutated).not.toBe(shipped);
    const methods = handlerMethods(mutated).get('relayhall_blueprint_list')!;
    expect(effectOf('work', 'relayhall_blueprint_list', methods)).toBe('change');
  });

  it('a handler with no board call is refused, not read as read-only', () => {
    expect(() => effectOf('work', 'relayhall_synthetic', [])).toThrow(/nature is unknown/);
  });

  it('the exception list does not excuse a tool that mixes reads and writes', () => {
    expect(effectOf('work', 'relayhall_knowledge_source_search', ['POST'])).toBe('read');
    expect(effectOf('work', 'relayhall_knowledge_source_search', ['GET', 'PATCH'])).toBe('change');
    expect(effectOf('work', 'relayhall_knowledge_source_search', ['POST', '<m>'])).toBe('change');
    expect(effectOf('work', 'relayhall_task_create', ['POST'])).toBe('change');
  });
});
