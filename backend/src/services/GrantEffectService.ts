// GrantEffectService.ts — does ONE grant row change anybody's access?
//
// Owner rulings E407 item 2 (the writer stops creating grants the grantee
// already has) and E413 (a safe bulk revoke of grants that change nobody's
// access). Both questions are answered by the authorization ENGINE itself:
// every answer below is `AuthorizationRepository.authorizedIdsByAction`, the
// same `AuthorizationService.sqlCondition` that `authorizedIds`,
// `authorizePoint` and every list narrowing run (and, for a Service,
// `selectorCoveredIds`' question, which the knowledge surfaces ask). No arm of
// the predicate is re-implemented or reasoned about here: a grant is
// REDUNDANT only when every question it could influence is answered
// byte-identically with and without the row, inside one transaction.
//
// WHO IS ASKED. A grant on principal P is consulted for P acting itself and,
// through the delegation chain, for every identity below P. So the engine is
// asked about two identities:
//   - P itself, built as the middleware builds it (its live chain when it is
//     delegated; `scopes = []`, because the predicate reads scopes only for
//     the `root` sentinel, which never survives delegation, so leaving it out
//     for an Account is the stricter input);
//   - unless P is an Agent (an Agent has no children), ONE probe identity one
//     link below P whose own() expression is the widest a link can hold
//     (`{ scopes: 'parent', objects: 'parent' }`). Every real or future
//     descendant's decision is that probe's decision intersected with its own
//     narrower caps, so a grant that changes nothing for the probe changes
//     nothing for any descendant, present or future, live or with a dead
//     chain. The probe never exists as a row: its id is a fresh random UUID
//     that matches no column.
//
// WHAT IS ASKED. Every action the grant's verb confers (`grantAllows`, the
// engine's own mapping), on the granted object (every object of the type for
// a typed wildcard) and, for a Project or Phase grant, on every Task in it
// (the inherited-Project-grant arm).
//
// AND WHAT IT LETS THE HOLDER DELEGATE. Three non-escalation checks read the
// grantee's grant-and-profile INVENTORY instead of the predicate (a non-root
// warrant creator's ceiling, an assigner's R3 cap and the Agent mint algebra
// arm). A row that is the holder's only source for its own selector is
// therefore effective even where the predicate already admits the holder
// (the owner arm, a Connector's own() cap): removing it would refuse the
// holder's next warrant, assignment or mint on that object. The inventory and
// the containment function asked are the ones those readers call.
//
// WHAT IS NOT EVALUABLE, and is never called redundant: a Group grantee (its
// reach is its members), a resource type the engine has no shape for
// (`plugin`, and `surface`, which the Access-surface arm reads outside this
// predicate), and anything the engine throws on.
import crypto from 'crypto';
import { authorizationRepository } from './AuthorizationRepository';
import {
  ADMINISTRATOR_ROLES, AUTHORIZATION_ACTIONS, grantAllows,
  type AuthorizationAction, type AuthorizationActor, type DelegationActorLink,
} from './AuthorizationService';
import type { GrantResourceType, GrantVerb } from './GrantService';
import type { ProfileRule } from './AccessProfileService';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { scopesForRole } from '../utils/identityScopes';

export type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** The resource types the engine renders (`AuthorizationRepository.sqlResource`). */
export const GRANT_EFFECT_EVALUABLE_TYPES: ReadonlySet<string> = new Set<GrantResourceType>([
  'task', 'phase', 'project', 'report', 'skill', 'personality', 'service', 'blueprint',
]);

/** The grant tuple the questions are asked about. */
export interface GrantTuple {
  granteeType: 'principal' | 'group';
  granteeId: string;
  resourceType: string;
  resourceId: string | null;
  verb: GrantVerb;
}

interface Probe { label: string; actor: AuthorizationActor }
interface Target { type: GrantResourceType; label: string; ids: string[] }

/** Every question one grant could influence. Built once and reused for the
 * answers before and after, so the probe identity is the same in both. */
export interface GrantQuestions {
  granteeId: string;
  probes: Probe[];
  actions: AuthorizationAction[];
  targets: Target[];
  /**
   * The DELEGATION question: is the grant's own selector contained in the
   * grantee's grant-and-profile inventory? Three non-escalation checks read
   * that inventory rather than the predicate: a non-root warrant creator's
   * ceiling (WarrantService.ceilingContainmentProblem, §6.2), an assigner's
   * R3 cap (AccessVehicleService) and the Agent mint algebra arm
   * (AgentMintService). For them a grant row is a SOURCE even where the
   * predicate already admits its holder, so removing it would change what
   * the holder may delegate. `bypassed` when every one of the three lets the
   * holder through without a source: an Account whose role both derives root
   * (scopesForRole) and is an administrator role (ADMINISTRATOR_ROLES).
   */
  containment: { rule: ProfileRule; bypassed: boolean };
}

/** question key -> `<allowed count>:<sha256 of the sorted allowed ids>` */
export type GrantAnswers = Record<string, string>;

export class GrantNotEvaluable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantNotEvaluable';
  }
}

export interface GrantEffectCheck {
  verdict: 'redundant' | 'effective' | 'unevaluable';
  reason: string;
  questions?: GrantQuestions;
  /** The answers WITH the grant (the state as it stands). */
  before?: GrantAnswers;
  changed?: Array<{ question: string; with: string | undefined; without: string | undefined }>;
}

const fingerprint = (ids: Set<string>): string => {
  const sorted = [...ids].sort();
  return `${sorted.length}:${crypto.createHash('sha256').update(sorted.join(',')).digest('hex')}`;
};

let savepointSeq = 0;
const nextSavepoint = (): string => `grant_effect_${++savepointSeq}`;

export class GrantEffectService {
  /** Why this tuple cannot be evaluated, or null when it can. */
  notEvaluableReason(grant: Pick<GrantTuple, 'granteeType' | 'resourceType'>): string | null {
    if (grant.granteeType !== 'principal') {
      return 'a Group grant reaches its members by membership; only principal grantees are evaluated';
    }
    if (!GRANT_EFFECT_EVALUABLE_TYPES.has(grant.resourceType)) {
      return `the authorization engine has no evaluator for resource type '${grant.resourceType}'`;
    }
    return null;
  }

  /** The grantee and, unless it is an Agent, the widest descendant probe. */
  private async probesFor(granteeId: string, queryable: Queryable): Promise<{ probes: Probe[]; bypassed: boolean }> {
    const row = (await queryable.query(
      'SELECT id::text, handle, kind, role, parent_principal_id::text AS parent, legacy_identity FROM principals WHERE id = $1',
      [granteeId])).rows[0];
    if (!row) throw new GrantNotEvaluable('the grantee principal does not exist');
    if (row.kind === 'group') throw new GrantNotEvaluable('a Group principal is never a principal grantee');
    // Required lazily: DelegationService reaches AccessProfileService, which
    // imports the Grant vocabulary this module's importers load first.
    const { delegationService } = await import('./DelegationService');
    const chain = await delegationService.resolveChain(granteeId, queryable);
    const links: DelegationActorLink[] = chain.links.map((link) => ({
      principalId: link.principalId, kind: link.kind, role: link.role, parentPrincipalId: link.parentPrincipalId,
      boundTaskId: link.boundTaskId, boundTaskRole: link.boundTaskRole, legacyIdentity: link.legacyIdentity,
      ownExpression: link.ownExpression,
    }));
    const role = resolveActorRole({ handle: String(row.handle), principalRole: row.role ?? undefined });
    const self: AuthorizationActor = {
      principalId: granteeId, handle: String(row.handle), role, scopes: [], authenticated: true,
      delegation: !row.parent || row.legacy_identity || links.length < 2 ? null : { links },
    };
    const probes: Probe[] = [{ label: `self:${granteeId}`, actor: self }];
    if (row.kind !== 'agent') {
      const probeId = crypto.randomUUID();
      const probeLink: DelegationActorLink = {
        principalId: probeId, kind: 'service', role: null, parentPrincipalId: granteeId,
        boundTaskId: null, boundTaskRole: null, legacyIdentity: false,
        ownExpression: { scopes: 'parent', objects: 'parent' },
      };
      probes.push({
        label: `descendant:${granteeId}`,
        actor: {
          principalId: probeId, handle: `descendant-probe-${granteeId}`, role: null,
          scopes: [], authenticated: true, delegation: { links: [probeLink, ...links] },
        },
      });
    }
    // Every inventory reader lets this holder through without a source.
    const bypassed = !row.parent && !row.legacy_identity
      && ADMINISTRATOR_ROLES.has(role.toLowerCase()) && scopesForRole(role).includes('root');
    return { probes, bypassed };
  }

  async questionsFor(grant: GrantTuple, queryable: Queryable): Promise<GrantQuestions> {
    const reason = this.notEvaluableReason(grant);
    if (reason) throw new GrantNotEvaluable(reason);
    const type = grant.resourceType as GrantResourceType;
    const actions = AUTHORIZATION_ACTIONS.filter((action) => grantAllows(grant.verb, action));
    const targets: Target[] = [];
    if (grant.resourceId) {
      targets.push({ type, label: grant.resourceId.toLowerCase(), ids: [grant.resourceId.toLowerCase()] });
    } else {
      const { from, resource } = authorizationRepository.sqlResource(type);
      const ids = (await queryable.query(`SELECT DISTINCT ${resource.id}::text AS id FROM ${from}`)).rows.map((r) => String(r.id));
      targets.push({ type, label: '*', ids });
    }
    if (type === 'project' || type === 'phase') {
      const column = type === 'project' ? 'project_id' : 'phase_id';
      const ids = grant.resourceId
        ? (await queryable.query(`SELECT id::text FROM tasks WHERE ${column} = $1`, [grant.resourceId])).rows.map((r) => String(r.id))
        : (await queryable.query(`SELECT id::text FROM tasks WHERE ${column} IS NOT NULL`)).rows.map((r) => String(r.id));
      if (ids.length > 0) targets.push({ type: 'task', label: `in-${type}:${grant.resourceId ? grant.resourceId.toLowerCase() : '*'}`, ids });
    }
    const { probes, bypassed } = await this.probesFor(grant.granteeId, queryable);
    const rule: ProfileRule = {
      resourceType: type, selectorForm: grant.resourceId ? 'exact' : 'all-of-type',
      selectorIds: grant.resourceId ? [grant.resourceId.toLowerCase()] : [], verbs: [grant.verb],
    };
    return { granteeId: grant.granteeId, probes, actions, targets, containment: { rule, bypassed } };
  }

  /** The engine's answer to every question, in the state `queryable` sees. */
  async answers(questions: GrantQuestions, queryable: Queryable): Promise<GrantAnswers> {
    const out: GrantAnswers = {};
    // The delegation question, asked of the product's own inventory and its
    // own containment function (the ones the three readers call).
    const rule = questions.containment.rule;
    const key = `containment:${questions.granteeId}|${rule.verbs[0]}|${rule.resourceType}|${rule.selectorIds[0] ?? '*'}`;
    if (questions.containment.bypassed) {
      out[key] = 'bypassed';
    } else {
      const { accessProfileService } = await import('./AccessProfileService');
      const { rulesCovered, sourcesFromEffectiveAccess } = await import('../utils/authorityContainment');
      const inventory = await accessProfileService.effectiveAccess(questions.granteeId, queryable);
      out[key] = rulesCovered(sourcesFromEffectiveAccess(inventory), [rule]).covered ? 'contained' : 'not-contained';
    }
    for (const probe of questions.probes) {
      for (const target of questions.targets) {
        const point = await authorizationRepository.authorizedIdsByAction(
          probe.actor, target.type, target.ids, questions.actions, queryable);
        for (const action of questions.actions) {
          out[`${probe.label}|${action}|point|${target.type}|${target.label}`] = fingerprint(point.get(action)!);
        }
        if (target.type === 'service') {
          const selector = await authorizationRepository.authorizedIdsByAction(
            probe.actor, target.type, target.ids, questions.actions, queryable, { selector: true });
          for (const action of questions.actions) {
            out[`${probe.label}|${action}|selector|${target.type}|${target.label}`] = fingerprint(selector.get(action)!);
          }
        }
      }
    }
    return out;
  }

  diff(a: GrantAnswers, b: GrantAnswers): Array<{ question: string; with: string | undefined; without: string | undefined }> {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const changed: Array<{ question: string; with: string | undefined; without: string | undefined }> = [];
    for (const key of [...keys].sort()) if (a[key] !== b[key]) changed.push({ question: key, with: a[key], without: b[key] });
    return changed;
  }

  /**
   * An EXISTING grant row: the engine's answers with it, then inside a
   * savepoint without it, then the savepoint is rolled back. `queryable` must
   * be a client inside an open transaction. Nothing is written.
   */
  async checkExisting(grant: GrantTuple & { id: string }, client: Queryable): Promise<GrantEffectCheck> {
    const reason = this.notEvaluableReason(grant);
    if (reason) return { verdict: 'unevaluable', reason };
    const savepoint = nextSavepoint();
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const questions = await this.questionsFor(grant, client);
      const before = await this.answers(questions, client);
      const deleted = await client.query('DELETE FROM grants WHERE id = $1', [grant.id]);
      if (deleted.rowCount !== 1) throw new GrantNotEvaluable('the grant row changed while it was evaluated');
      const after = await this.answers(questions, client);
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      const changed = this.diff(before, after);
      const checks = Object.keys(before).length;
      if (changed.length === 0) {
        return { verdict: 'redundant', reason: `the engine answers all ${checks} questions the same without it`, questions, before };
      }
      const first = changed[0].question.split('|');
      return {
        verdict: 'effective',
        reason: first[0].startsWith('containment:')
          ? `removing it changes ${changed.length} of ${checks} answers (first: it is the holder's own source for delegating ${first[1]} on this ${first[2]}: warrant, assignment and mint ceilings read grants, not the engine's other arms)`
          : `removing it changes ${changed.length} of ${checks} answers (first: ${first[0].split(':')[0]} ${first[1]} on ${first[3]})`,
        questions, before, changed: changed.slice(0, 5),
      };
    } catch (e) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      const message = e instanceof GrantNotEvaluable ? e.message : 'the authorization engine could not evaluate it';
      return { verdict: 'unevaluable', reason: message };
    }
  }

  /**
   * THE WRITER (E407 item 2): write the grant through `write` (the one
   * GrantService.create path, with its grant.create audit row and feed event)
   * ONLY when it changes some answer. Inside a savepoint of the caller's OWN
   * transaction: the engine is asked before, the row is written, the engine
   * is asked again, and an unchanged answer rolls the write back. The caller
   * learns which happened. A tuple the engine cannot evaluate is written as
   * before.
   */
  async writeUnlessHeld<T>(
    grant: GrantTuple, client: Queryable, write: () => Promise<T>,
  ): Promise<{ written: T | null; held: boolean; checks: number }> {
    if (this.notEvaluableReason(grant)) return { written: await write(), held: false, checks: 0 };
    const savepoint = nextSavepoint();
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      let questions: GrantQuestions;
      try {
        questions = await this.questionsFor(grant, client);
      } catch (e) {
        if (!(e instanceof GrantNotEvaluable)) throw e;
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { written: await write(), held: false, checks: 0 };
      }
      const without = await this.answers(questions, client);
      const written = await write();
      const withGrant = await this.answers(questions, client);
      if (this.diff(withGrant, without).length === 0) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { written: null, held: true, checks: Object.keys(without).length };
      }
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return { written, held: false, checks: Object.keys(without).length };
    } catch (e) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
      throw e;
    }
  }
}

export const grantEffectService = new GrantEffectService();
