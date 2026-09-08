# Harness support tiers

RelayHall is not harness-agnostic in the sense of parity. It is harness-agnostic
in the sense that every client speaks the same authenticated MCP surface, and
what a client can then do depends on what that client is: whether it has a
shell, whether anything wakes it, whether a human is sitting in front of it.

That difference is published as three tiers rather than implied away.

## The ratified definitions

Quoted verbatim from the governing strategy, so this page cannot soften them:

> **Tier A** full loop (Claude Code, Codex CLI, Gemini CLI: bootstrap,
> claim/lease, report, runner-wakeable); **Tier B** interactive board clients
> (ChatGPT developer mode, Antigravity: real MCP read/write behind OAuth,
> human-driven, no shell or scheduler); **Tier C** webhook automations (n8n and
> kin — ironically the most solid trigger mechanism in the whole design).

## The matrix

| | Tier A — full loop | Tier B — interactive board clients | Tier C — webhook automations |
|---|---|---|---|
| Named clients | Claude Code, Codex CLI, Gemini CLI | ChatGPT developer mode, Antigravity | n8n and kin |
| How it authenticates | a principal credential in a Bearer header | OAuth 2.1 | a principal credential in a Bearer header |
| Bootstrap | yes — `relayhall_brief_compile` with `session: true` | yes — the same call, once the token is in hand | yes |
| Claim and Lease | yes | yes, human-driven | yes |
| Return a Report | yes | yes | yes |
| Woken by the board | yes — work delivery to a registered Connector | no — a human drives it | yes — work delivery to a registered Connector |
| Shell of its own | yes | no | the automation's own runtime |
| **Available today** | **yes** | **yes — the OAuth 2.1 authorization server is released: authorization_code grant, S256 PKCE required, client identity by Client ID Metadata Document** | **yes** |

## What makes each row true

**Tier A.** All four capabilities are board surfaces that ship today:
`relayhall_brief_compile` with `session: true` bootstraps and is refused-until-called
for everything that changes state; `relayhall_task_claim` and the Lease verbs
carry the claim half; `relayhall_report_create` carries the return half; and
"runner-wakeable" is per-assignee work delivery, dispatched from the assignee's
own registry entry in `webhook` or `poll` mode. A reference runner ships as a
separate companion repository — satellites live in their own repositories, and
core ships a small set of them as worked examples.

The bootstrap pack for each of the three named clients ships in this repository:
[CLAUDE.md](../CLAUDE.md), [AGENTS.md](../AGENTS.md) and
[GEMINI.md](../GEMINI.md). Claude Code additionally gets `.claude/settings.json`
with a session hook, because it is the one of the three that runs a command at a
defined point in the session lifecycle.

What is **not** claimed: RelayHall does not run third-party harnesses in its own
CI. What is verified here is the board's half — the tools, the refusal, the
delivery — plus the exact configuration each client needs, which is asserted
against the board's own renderer so a pack cannot drift from the product.

**Tier B is available.** These clients cannot carry a static bearer
credential, so they need an OAuth 2.1 authorization server — and RelayHall now
releases one. The MCP endpoint advertises RFC 9728 protected-resource metadata
in its `WWW-Authenticate` challenge, which is the discovery step a Tier-B
client begins with; the release that added that advertisement is the release
that flipped this row, exactly as the previous version of this page promised.

The flow is the OAuth 2.1 floor and nothing beyond it: the authorization-code
grant with **PKCE S256 required**, an exact-string redirect-URI match, one-time
authorization codes, and no client secrets — a client identifies itself with a
**Client ID Metadata Document**, an https URL it controls that serves its own
metadata. There is no Dynamic Client Registration endpoint and there is no
refresh-token grant in this release: a human is present by definition in this
tier, and re-authorizing is a click.

What a Tier-B client receives is an ordinary RelayHall reference credential:
the access token is looked up on the board on **every single call**, so
revoking it refuses the very next one, and it is pinned to the MCP transport,
so it is refused on every REST route. Its authority is intersected with the
authority of the person who consented, on every call — a token can never
outrank, or outlive, the human behind it.

See [oauth.md](oauth.md) for the endpoints, the client metadata document shape
and the outbound-fetch policy.

**Tier C.** A webhook automation registers as a Connector like any other
assignee. Deliveries are ID-only and signed (HMAC-SHA256 over the exact
transmitted bytes), at-least-once and in cursor order; the receiver treats the
cursor as its idempotency key and reconciles a dropped delivery by pulling the
feed from that cursor. The doorbell is a hint; the feed is the truth. A poll
mode exists for automations that cannot be reached inbound. See
[services.md](services.md) for registration and
[mcp.md](mcp.md) for the tool surface.

## The rule under all three rows

Authority travels in the pull, never in the push. The board announces with an
identifier and nothing else; substance flows when the satellite authenticates
and asks with its own credential. A tier says how a client is reached and what
it can do once it arrives — never how much authority it holds. That is settled
by its grants, evaluated centrally, identically for all three tiers.
