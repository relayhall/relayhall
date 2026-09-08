/**
 * assignmentAccessCoupling.test.ts — RH-P3.AZ-S7 (card 446240c4; owner
 * ruling 7440b579; AUTHZ amendment AZ-A2; contract note d3accc39).
 *
 * CI runs without a database, so the BEHAVIOUR of the coupling — chain
 * targeting, refcounting, the readability proof — is proven against real
 * Postgres by `scripts/test-s7-assignment-coupling-live.js`, which drives
 * the production services and the production predicate. What lives HERE is
 * the part that must hold on EVERY commit whether or not anyone remembers
 * to run that script: the surface contract, and the structural claims the
 * ruling makes about what AZ-S7 did NOT do.
 */

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { readFileSync } from 'fs';
import path from 'path';
import { pool } from '../db/connection';
import { resolveExecutionProfileWrite } from '../routes/tasks';
import { ProfileValidationError } from '../utils/executionProfile';
import { warrantIdleGraceMs } from '../services/WarrantService';
import { AssignmentAccessError } from '../services/AccessVehicleService';
import { ERROR_CLASS_NAMES } from '../utils/failureClassification';
import { CLAUDE_CODE_DESCRIPTOR } from './fixtures/serviceDescriptors';

const SERVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WARRANT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SRC = path.resolve(__dirname, '..');

function armPool(): void {
  (pool.query as jest.Mock).mockImplementation(async (text: string) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('SELECT * FROM services WHERE')) {
      return {
        rows: [{
          id: SERVICE_ID, slug: 'my-runner', name: 'My Runner', description: '',
          kind: 'connector', runtime_mode: 'direct', status: 'published',
          visibility_tier: 'assigned-only', delivery_mode: 'none',
          delivery_endpoint: null, delivery_poll_interval_seconds: null,
          telemetry_tier: 'none', current_descriptor_version: 1,
          revision: 'rev', created_by_principal_id: null, updated_by_principal_id: null,
          created_at: 'now', updated_at: 'now', retired_at: null,
        }],
      };
    }
    if (sql.startsWith('SELECT version, descriptor, content_hash')) {
      return {
        rows: [{
          version: 1, descriptor: CLAUDE_CODE_DESCRIPTOR, content_hash: 'h',
          created_by_principal_id: null, created_at: 'now', retired_at: null,
        }],
      };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
  });
}

const TARGETING = { executionProfile: { serviceId: 'my-runner', options: { model: 'claude-fable-5' } } };
const rootRequest = (): any => ({ scopes: ['root'] });

async function expectRefusal(payload: any, status: number, code: string): Promise<void> {
  try {
    await resolveExecutionProfileWrite({ ...payload }, rootRequest());
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileValidationError);
    expect((error as ProfileValidationError).status).toBe(status);
    expect((error as ProfileValidationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, got success`);
}

beforeEach(() => {
  jest.clearAllMocks();
  armPool();
  delete process.env.RELAYHALL_WARRANT_IDLE_GRACE_HOURS;
});

describe('the chosen access vehicle on the assignment write path (R2(a))', () => {
  it('carries a valid warrant id through to the write payload', async () => {
    const out = await resolveExecutionProfileWrite(
      { ...TARGETING, executionWarrantId: WARRANT_ID }, rootRequest());
    expect(out.executionServiceId).toBe(SERVICE_ID);
    expect(out.executionWarrantId).toBe(WARRANT_ID);
  });

  it('takes the R2(b) auto-grant fallback when no warrant is named', async () => {
    const out = await resolveExecutionProfileWrite({ ...TARGETING }, rootRequest());
    expect(out.executionServiceId).toBe(SERVICE_ID);
    expect(out.executionWarrantId).toBeUndefined();
  });

  it('refuses a warrant id that is not a UUID', async () => {
    await expectRefusal({ ...TARGETING, executionWarrantId: 'the-phase-warrant' }, 422, 'INVALID_WARRANT_ID');
  });

  it('refuses a warrant with no assignment to be the vehicle for', async () => {
    await expectRefusal({ executionWarrantId: WARRANT_ID }, 422, 'WARRANT_WITHOUT_ASSIGNMENT');
  });

  it('clears the vehicle when the assignment is cleared — a warrant pointer never outlives its assignment', async () => {
    const out = await resolveExecutionProfileWrite({ executionProfile: null }, rootRequest());
    expect(out.executionServiceId).toBeNull();
    expect(out.executionWarrantId).toBeNull();
  });

  it('refuses to clear the assignment and name a vehicle in the same write', async () => {
    // Contradictory: there is nothing left for the vehicle to carry. A
    // typed refusal beats silently honouring one half of the payload.
    await expectRefusal(
      { executionProfile: null, executionWarrantId: WARRANT_ID }, 422, 'WARRANT_WITHOUT_ASSIGNMENT');
  });
});

describe('the batch path cannot set an execution assignment (run packet dedc11d8 §2.1 finding 4)', () => {
  // routes/tasksBatch.ts hands its `updates` object straight to
  // updateTask, and TaskManagerDB will write execution_service_id from any
  // such object — so the ONLY thing standing between a batch call and an
  // uncoupled assignment is this allowlist. The packet required the path be
  // proven closed or coupled; it is closed, and this is the proof.
  const batchSource = readFileSync(path.join(SRC, 'routes/tasksBatch.ts'), 'utf8');
  const allowed = /const ALLOWED_FIELDS = \[([^\]]*)\]/.exec(batchSource)?.[1] ?? '';

  it('the allowlist exists and is non-empty — the guard is real, not vacuous', () => {
    expect(allowed.trim().length).toBeGreaterThan(0);
    expect(allowed).toContain("'status'");
  });

  it.each(['executionProfile', 'executionServiceId', 'executionDescriptorVersion', 'executionWarrantId'])(
    'refuses %s', (field) => {
      expect(allowed).not.toContain(`'${field}'`);
    });

  it('refuses an unlisted field with a typed 400 rather than passing it through', () => {
    expect(batchSource).toContain('UNSUPPORTED_BATCH_FIELD');
    // The refusal must come BEFORE the update loop, or an assignment would
    // already have been written by the time the caller is told no.
    expect(batchSource.indexOf('UNSUPPORTED_BATCH_FIELD'))
      .toBeLessThan(batchSource.indexOf('taskManager.updateTask'));
  });
});

describe('the R4 idle grace is a deployment knob with a 6h default', () => {
  it('defaults to six hours', () => {
    expect(warrantIdleGraceMs()).toBe(6 * 60 * 60 * 1000);
  });

  it('honours the deployment override', () => {
    process.env.RELAYHALL_WARRANT_IDLE_GRACE_HOURS = '2';
    expect(warrantIdleGraceMs()).toBe(2 * 60 * 60 * 1000);
  });

  it('falls back to the default on a nonsense value rather than expiring instantly', () => {
    process.env.RELAYHALL_WARRANT_IDLE_GRACE_HOURS = 'soon';
    expect(warrantIdleGraceMs()).toBe(6 * 60 * 60 * 1000);
  });

  it('permits an explicit zero — a deployment may opt out of the grace', () => {
    process.env.RELAYHALL_WARRANT_IDLE_GRACE_HOURS = '0';
    expect(warrantIdleGraceMs()).toBe(0);
  });
});

describe('what AZ-S7 deliberately did NOT do (ruling 7440b579 R1; AZ-A2)', () => {
  // "the shared predicate 4d961e37 §1 is UNCHANGED; no service-assignment
  // arm is added, now or later under this amendment." A structural check,
  // because the whole ruling rests on it: the coupling had to be built
  // WITHOUT touching the evaluator.
  it('adds no arm to the shared predicate', () => {
    const predicate = readFileSync(path.join(SRC, 'services/AuthorizationService.ts'), 'utf8');
    expect(predicate).not.toMatch(/vehicle/i);
    expect(predicate).not.toMatch(/execution_service_id/);
    expect(predicate).not.toMatch(/access_vehicle_links/);
  });

  it('mints no scope string', () => {
    // Warrants have had scope-map entries since AZ-S4; what AZ-S7 claims is
    // that it added NOTHING of its own — every surface it built reuses the
    // gates its route already passes (GET /tasks/:id/access-vehicle is
    // tasks:read; the warrant sub-routes are the session-only plane).
    const scopeMap = readFileSync(path.join(SRC, 'utils/scopeMap.ts'), 'utf8');
    expect(scopeMap).not.toMatch(/vehicle/i);
    expect(scopeMap).not.toMatch(/assignment/i);
  });

  // Review bedc25f3 B1: the first cut shipped "access-vehicle" as a route
  // path and "Access vehicle" as a capitalized UI heading while its own
  // migration comment promised neither. A promise in a comment is not a
  // gate; this is.
  it('keeps "vehicle" out of every user-facing surface — it is prose in the ruling, not a noun', () => {
    const routes = readFileSync(path.join(SRC, 'routes/warrants.ts'), 'utf8')
      + readFileSync(path.join(SRC, 'routes/tasks.ts'), 'utf8');
    // Route PATHS — the string literals a client sees.
    expect(routes).not.toMatch(/router\.[a-z]+\('\/[^']*vehicle/i);
    // Audit actions and feed event names.
    expect(routes).not.toMatch(/action: '[a-z_.]*vehicle/i);
    expect(routes).not.toMatch(/name: '[a-z_.]*vehicle/i);
    // And the surface it DOES expose spells the ratified words.
    expect(routes).toContain("'/:id/assignment-access'");
  });

  // Review 1f60bf8f B1: the r1 gate passed while `vehicleKind` and
  // `createdByVehicle` shipped as public JSON keys. A response field is a
  // named surface (b94dd86e: identifiers move too), so the gate reads the
  // shape the PRODUCTION serializer actually emits rather than trusting a
  // grep — which is what let the first repair look complete.
  it('emits no response key carrying the word — the shape, from the real serializer', async () => {
    const { accessVehicleService } = await import('../services/AccessVehicleService');
    (pool.query as jest.Mock).mockResolvedValue({
      rows: [{
        id: '11111111-1111-4111-8111-111111111111',
        vehicle_kind: 'warrant',
        warrant_id: '22222222-2222-4222-8222-222222222222',
        warrant_name: 'Phase 3 delivery',
        warrant_status: 'active',
        target_kind: 'grant',
        target_id: '33333333-3333-4333-8333-333333333333',
        created_by_vehicle: true,
        assignee_principal_id: '44444444-4444-4444-8444-444444444444',
        landed_on_principal_id: '55555555-5555-4555-8555-555555555555',
        landed_on_handle: 'runner-account',
        resource_type: 'task',
        resource_id: '66666666-6666-4666-8666-666666666666',
        verb: 'read',
        profile_id: null,
        profile_name: null,
      }],
    });
    const links = await accessVehicleService.linksForTask('11111111-1111-4111-8111-111111111111');
    expect(links).toHaveLength(1);
    const keys = Object.keys(links[0]);
    expect(keys.filter((key) => /vehicle/i.test(key))).toEqual([]);
    // And the replacements are actually there — a serializer that emitted
    // nothing would also pass the check above.
    expect(keys).toEqual(expect.arrayContaining(['carriedBy', 'createdByAssignment']));
    expect(links[0].carriedBy).toBe('warrant');
    expect(links[0].createdByAssignment).toBe(true);
  });

  // THE GATE THAT SHOULD HAVE BEEN FIRST. Enumerating surfaces to check
  // missed a new one in each of three rounds. This reads every string
  // literal the slice adds to the production sources and fails on the
  // lexeme anywhere, minus an explicit allowlist of internal identifiers.
  it('lets no string literal in the production sources carry the word, except the named internals', () => {
    // The internals the review brief permits: the linkage table and its
    // columns, the service/module identifiers, and CSS class names. Each
    // entry is a deliberate, visible exception.
    const PERMITTED = [
      'access_vehicle_links', 'vehicle_kind', 'created_by_vehicle',
      'accessVehicleService', 'AccessVehicleService',
      'AccessVehiclePicker', 'TaskAccessVehicle', 'AccessVehicle.css',
      'access-vehicle',           // the CSS class prefix
      'attachExecutionVehicle',   // a private method name
      'vehicleChanged', 'vehicleKind', 'vehicleId',  // local identifiers
      '099_assignment_access_vehicles.sql',
    ];
    const SOURCES = [
      'services/AccessVehicleService.ts',
      'services/GrantService.ts',
      'services/AccessProfileService.ts',
      'services/TaskManagerDB.ts',
      'services/WarrantService.ts',
      'services/TaskElementService.ts',
      'routes/tasks.ts',
      'routes/warrants.ts',
      'openapi/spec.ts',
    ];

    const offenders: string[] = [];
    for (const file of SOURCES) {
      const source = readFileSync(path.join(SRC, file), 'utf8')
        // Comments may name the machinery — the ruling itself does.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const literals = source.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
      for (const literal of literals) {
        if (!/vehicle/i.test(literal)) continue;
        let residue = literal;
        for (const allowed of PERMITTED) residue = residue.split(allowed).join('');
        if (/vehicle/i.test(residue)) offenders.push(`${file}: ${literal.slice(0, 110)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // And the refusals specifically, because they are the surface a caller
  // meets when something goes wrong — codes AND the messages beside them.
  it('emits no refusal code or message carrying the word', async () => {
    const { AssignmentAccessError } = await import('../services/AccessVehicleService');
    expect(new AssignmentAccessError(409, 'X', 'y').name).not.toMatch(/vehicle/i);

    for (const file of ['services/AccessVehicleService.ts', 'services/GrantService.ts', 'services/AccessProfileService.ts']) {
      const source = readFileSync(path.join(SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      // Every SCREAMING_SNAKE literal is a code on the wire.
      for (const code of source.match(/'[A-Z][A-Z0-9_]{3,}'/g) ?? []) {
        expect(code).not.toMatch(/vehicle/i);
      }
    }
  });

  it('documents no such field in the OpenAPI contract either', () => {
    const spec = readFileSync(path.join(SRC, 'openapi/spec.ts'), 'utf8');
    expect(spec).not.toMatch(/vehicle/i);
    // The surface it DOES document is the renamed one.
    expect(spec).toContain('/tasks/{id}/assignment-access');
  });

  it('writes no audit metadata key carrying the word', () => {
    // audit_events.metadata is served under audit:read, so its keys are a
    // surface as much as any response body.
    const service = readFileSync(path.join(SRC, 'services/AccessVehicleService.ts'), 'utf8');
    const metadataBlocks = service.match(/metadata: \{[\s\S]*?\},/g) ?? [];
    expect(metadataBlocks.length).toBeGreaterThan(0);
    for (const block of metadataBlocks) {
      expect(block).not.toMatch(/^\s*\w*vehicle\w*:/im);
      expect(block).not.toMatch(/'vehicle:/i);
    }
  });

  it('keeps the word out of every visible UI label too', () => {
    const ui = ['components/tasks/AccessVehiclePicker.tsx', 'components/tasks/TaskAccessVehicle.tsx']
      .map((file) => readFileSync(path.join(SRC, '../../frontend/src', file), 'utf8'))
      .join('\n');
    // Strip comments: the machinery may be NAMED in prose about itself.
    const rendered = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // What remains may still carry class names and identifiers, so the
    // check is for the word as DISPLAYED TEXT: capitalized, between tags.
    expect(rendered).not.toMatch(/>\s*[^<]*Access vehicle/i);
    expect(rendered).toMatch(/Assignment access/);
  });

  // Review bedc25f3 B3: the cap was applied to the PINNED mint ceiling
  // while the vehicle materialized the CURRENT PUBLISHED profile, so a
  // republish could hand an assigner authority it did not hold.
  it('applies the R3 cap to the authority it actually materializes', () => {
    const vehicle = readFileSync(path.join(SRC, 'services/AccessVehicleService.ts'), 'utf8');
    expect(vehicle).toContain("this.warrantCeilingRules(client, warrant, 'published')");
    expect(vehicle).toMatch(/plane: 'pinned' \| 'published'/);
  });

  it('registers its refusal class so a caught AssignmentAccessError is never classified UNKNOWN', () => {
    expect(ERROR_CLASS_NAMES).toContain('AssignmentAccessError');
    expect(new AssignmentAccessError(409, 'X', 'y').name).toBe('AssignmentAccessError');
  });
});

describe('the coupling lives at the single write choke point', () => {
  const manager = readFileSync(path.join(SRC, 'services/TaskManagerDB.ts'), 'utf8');

  // Review bedc25f3 B4: the transition was gated on the ASSIGNEE changing,
  // so auto-grant → Warrant, Warrant A → Warrant B and Warrant →
  // auto-grant were all accepted by the route and silently dropped here.
  it('treats a warrant-only change as a vehicle transition', () => {
    expect(manager).toContain('const vehicleChanged');
    expect(manager).toMatch(/warrantInPayload && newWarrant !== oldWarrant/);
  });

  // Review bedc25f3 B2: the recompute path materialized grants with no
  // containment check at all. Its signature now REQUIRES the linker, so a
  // caller cannot omit the cap by accident.
  it('requires a linker identity for every link-edit recompute', () => {
    const vehicle = readFileSync(path.join(SRC, 'services/AccessVehicleService.ts'), 'utf8');
    expect(vehicle).toMatch(/async recompute\([\s\S]{0,400}?linker: AuthorizationActor,/);
    expect(vehicle).toContain('permittedReferences(client, taskId, linker)');
    for (const call of manager.match(/accessVehicleService\.recompute\([^;]*\)/g) ?? []) {
      expect(call).toMatch(/linkerAuthorizationFor\(/);
    }
  });

  it('attaches the vehicle inside the task write transaction, not after it', () => {
    const attach = manager.indexOf('attachExecutionVehicle(client');
    const commit = manager.indexOf("await client.query('COMMIT')", attach);
    expect(attach).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(attach);
  });

  it('reaps the vehicle before the row is deleted, not by FK cascade', () => {
    const detach = manager.indexOf('accessVehicleService.detach(client, id');
    const del = manager.indexOf("DELETE FROM tasks WHERE id = $1", detach);
    expect(detach).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(detach);
  });
});
