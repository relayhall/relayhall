/**
 * bootstrapGate — THE fail-closed bootstrap check (RH-P3.C4 subtask [1];
 * strategy 4e40f06f §2.10 ratified item C2; owner decision D2).
 *
 * §2.10, verbatim: "work-plane tool calls from a session that has not
 * bootstrapped return 'bootstrap first' with the index inline — ONE MIDDLEWARE
 * CHECK that kills the silent-skip hole (only Claude Code has a deterministic
 * bootstrap hook; every other harness relies on instruction files the model
 * can skip)."
 *
 * ── Why this is the only place the check can live ──
 *
 * The exemption is a property of the TOOL (`McpTool.plane`), and the identity
 * is a property of the CREDENTIAL on the request. Exactly one site in the
 * process holds both at once: the `tools/call` dispatcher in `mcp/server`,
 * which is the single site that ever invokes `tool.handler`. Pushing the check
 * down into the in-process dispatch chain would have to be told the plane by
 * the tool itself — distributing the exemption decision across 52 call sites,
 * where one wrong argument exempts a mutating verb silently. Pushing it up
 * into the HTTP ingress would miss stdio, which builds its server through the
 * same `buildMcpServer` and would otherwise be an ungated second front door.
 *
 * The one-site claim is not a comment: `c4McpBootstrapGate` measures it, by
 * driving EVERY tool in the live registry through the dispatcher rather than
 * sampling, and by censusing `tool.handler(` call sites in the shipped source.
 *
 * ── Why the credential is re-resolved here ──
 *
 * The gate does not trust a credential id handed to it by a transport. It
 * resolves the credential itself, through the same `acceptPrincipalKey` both
 * ingresses call, so revocation, expiry, rotation grace, delegation-chain
 * liveness and the transport pin are all re-evaluated at the moment of the
 * decision. That is the S-A6 posture requirement (de73f9f8 §1.3: the surface
 * "re-evaluates the credential carried by the transport plus current RelayHall
 * authorization state before every canonical backend operation invoked by a
 * tool call") applied to this control rather than assumed of it. On stdio, the
 * only alternative — resolving once at process start — would keep a revoked
 * credential bootstrapped for the life of the process.
 *
 * ── Fail closed means fail closed ──
 *
 * Every path that is not a positive "this credential holds a live bootstrap
 * record" returns a refusal: no record, a lapsed record, a credential that no
 * longer authenticates, and a lookup that THREW. There is no arm that lets a
 * work-plane tool through on a shrug.
 */
import { acceptPrincipalKey, type AuthRequest } from '../middleware/auth';
import { isBootstrapLive } from '../services/McpBootstrapService';
import { MCP_TRANSPORT_STAMP, MCP_ROUTE_PATH } from './provenance';
import { board, type McpCallContext } from './rest';
import { untrusted, sections } from './shape';
import type { McpTool, ToolPlane } from './registry';

/**
 * The exempt set, named explicitly (run packet 3e6ec75a §5[1]: "Name the
 * exempt set explicitly on the card and in evidence").
 *
 *  - `bootstrap` — the verb that WRITES the record. Gating it would make
 *    bootstrapping impossible, which is the one way to turn a fail-closed
 *    control into a locked door.
 *  - `introspection` — read-only tools that change nothing. A harness must be
 *    able to ask who it is and what it may do BEFORE it can be told it should
 *    have bootstrapped; refusing `relayhall_principal_whoami` to an
 *    un-bootstrapped caller would leave a misconfigured client with no way to
 *    diagnose itself.
 *
 * Everything else is `work` and refuses. The set is a constant here and is
 * asserted against the live registry by the gate's own suite, so a tool added
 * later with no plane, or with the wrong one, is a test failure rather than a
 * silent exemption.
 */
export const BOOTSTRAP_EXEMPT_PLANES: readonly ToolPlane[] = ['bootstrap', 'introspection'];

/** The stable first line of the refusal — what §2.10 says it must say. */
export const BOOTSTRAP_REFUSAL_MARKER = 'bootstrap first';

/**
 * The bootstrap policy as one sentence, rendered from the same constant the
 * gate decides by.
 *
 * The in-repo bootstrap packs (CLAUDE.md, AGENTS.md, GEMINI.md and the
 * SessionStart hook) quote this VERBATIM, and the C9 drift suite compares
 * their committed bytes against what this returns. Review 4ab06516 B1 found
 * why that is necessary: the packs' refusal prose was unbound, so replacing
 * "refused" with "allowed without bootstrapping" left the suite green. Prose
 * generated from BOOTSTRAP_EXEMPT_PLANES cannot say the opposite of what the
 * gate does, and adding a plane to the exempt set turns every document that
 * quotes the old sentence red until it is re-quoted.
 */
export function bootstrapPolicySentence(): string {
  const open = [...BOOTSTRAP_EXEMPT_PLANES].join(' and ');
  return `Before this credential has bootstrapped, only the ${open} planes answer; `
    + `every other tool is refused with "${BOOTSTRAP_REFUSAL_MARKER}".`;
}

/** The verb a refused caller is told to call, and how. */
export const BOOTSTRAP_VERB = 'relayhall_brief_compile';
const BOOTSTRAP_CALL = `${BOOTSTRAP_VERB} with {"session": true}`;

/**
 * The granted-skill index, inline (§2.10: "Session-start granted-skill index;
 * on-demand full text").
 *
 * The index is board free text authored by other parties, so it rides inside
 * the §4.1 untrusted-data fence like every other piece of board text this
 * surface emits. A caller whose credential cannot read the registry is TOLD
 * that, rather than handed a refusal with a silently empty index — an empty
 * list and an unreadable list are different facts and a model acts differently
 * on each.
 */
export async function grantedSkillIndex(ctx: McpCallContext): Promise<string> {
  let envelope: Record<string, unknown>;
  try {
    envelope = await board(ctx, { method: 'GET', path: '/skills', requiredScope: 'skills:read' });
  } catch {
    return 'Your granted skill index could not be read with this credential (it needs `skills:read`). Bootstrap anyway — the Brief reports the same condition.';
  }
  const skills = Array.isArray(envelope.skills) ? (envelope.skills as Record<string, unknown>[]) : [];
  if (skills.length === 0) return 'Your granted skill index is empty — no Skills are published to this credential.';
  const lines = skills.map((skill) => {
    const name = String(skill.name ?? '(unnamed)');
    const category = skill.category ? ` [${String(skill.category)}]` : '';
    const version = skill.currentVersion ? ` v${String(skill.currentVersion)}` : '';
    const summary = typeof skill.description === 'string' && skill.description.trim().length > 0
      ? ` — ${skill.description.trim()}`
      : '';
    return `${String(skill.id ?? '?')} ${name}${category}${version}${summary}`;
  });
  return sections(
    `Your granted skill index (${skills.length} Skill${skills.length === 1 ? '' : 's'}) — names and summaries only; fetch full SKILL.md text on demand with relayhall_skill_get.`,
    untrusted('the Skill registry', lines.join('\n')),
  );
}

/** The refusal a work-plane call gets when its credential has not bootstrapped. */
export async function bootstrapRefusal(ctx: McpCallContext, reason: string): Promise<string> {
  return sections(
    `${BOOTSTRAP_REFUSAL_MARKER} — ${reason} ${ctx.toolName} is a work-plane tool and is refused until this credential has bootstrapped.`,
    `Call ${BOOTSTRAP_CALL}. It returns your complete working context — personality, attached Reports, your granted skill index and the board's workflow doctrine — and records this credential as bootstrapped. Then call ${ctx.toolName} again, unchanged.`,
    // The same sentence the in-repo bootstrap packs quote. A refused caller is
    // told the policy, not just that it was refused — and the renderer is
    // production behaviour rather than a test-only oracle (review 41b196d3).
    bootstrapPolicySentence(),
    await grantedSkillIndex(ctx),
  );
}

/**
 * The check. Returns the refusal text a work-plane caller must be given, or
 * `null` when the call may proceed.
 *
 * Returning text rather than throwing is deliberate: the dispatcher renders it
 * as a TOOL error (`isError: true`), which is what a model can read and act on
 * — a protocol error is not (SEP-1303, de73f9f8 §2.1).
 */
export async function bootstrapGate(tool: McpTool, ctx: McpCallContext): Promise<string | null> {
  if (BOOTSTRAP_EXEMPT_PLANES.includes(tool.plane)) return null;

  const credentialId = await resolveCredentialId(ctx);
  if (!credentialId) {
    return bootstrapRefusal(ctx, 'this credential did not authenticate, so no bootstrap record could be established for it.');
  }
  let live: boolean;
  try {
    live = await isBootstrapLive(credentialId);
  } catch {
    // A lookup failure is not "no record" — it is "we do not know". Both
    // refuse; only this one says so, because a caller retrying against a
    // wedged database should not be told to bootstrap forever.
    return bootstrapRefusal(ctx, 'the board could not establish whether this credential has bootstrapped, and will not run work-plane tools on an unestablished bootstrap.');
  }
  if (live) return null;
  return bootstrapRefusal(ctx, 'this credential has no live bootstrap record.');
}

/**
 * The credential this call actually authenticates as, resolved live.
 *
 * `acceptPrincipalKey` writes the resolved credential id onto the request it
 * is given; a bare object is enough, because nothing here needs the rest of an
 * Express request and nothing is written back to a response.
 */
export async function resolveCredentialId(ctx: McpCallContext): Promise<string | null> {
  const probe = {} as AuthRequest;
  try {
    const outcome = await acceptPrincipalKey(
      probe, ctx.authorization, MCP_ROUTE_PATH, MCP_TRANSPORT_STAMP,
    );
    if (outcome.kind !== 'ok') return null;
  } catch {
    return null;
  }
  return probe.credentialId ?? null;
}
