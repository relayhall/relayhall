# Going Further — wiring RelayHall into your infrastructure

A fresh RelayHall install is intentionally a **generic system of record**: the
core dashboard and API plus empty registries ready for your own content.
Everything below is optional and connects through explicit APIs or plugins.

## What ships vs. what you bring

| Area | Ships in the box | You bring |
|---|---|---|
| Task/project boards, reports | ✅ fully working | — |
| Sessions, stats, audit | empty-state core surfaces | Reporter plugins (see [observability.md](observability.md)) |
| Skills | empty registry | Your own skill entries describing *your* CLIs/services |
| Personalities | five built-in defaults | Managed personalities you create (or import by review) on the board |
| Plugins | plugin system + example | Your plugin containers (avatar, GPU, blogs, …) |
| LLM model catalog | provider bridge code | Your LLM proxy endpoint + keys |
| Orchestration | Brief/report/task APIs | Your pull-side worker or orchestrator harness |

## 1. Teach your agents your infrastructure (Skills)

Skills are where agents learn what *your* infrastructure offers. Each Skill is
an instruction entry that gets injected into agent context — globally when
marked `is_global`, or per project through project links. Add Skills for the
things your agents should reach for: your password vault CLI, your GPU/media
boxes, your snapshot/backup tooling, your browser automation. Create them in
the dashboard (Skills → New Skill) or via `POST /api/skills`. Write
instructions as material injected into compiled Briefs: concrete commands,
expected output, safety notes.
**Never put secrets in skill instructions** — reference your vault instead.
See [skills.md](skills.md) for the full surface.

## 2. Give your agents identities (Personalities)

Personalities are board-native: create them in the dashboard (Personalities →
New personality) or over CLI/MCP, starting from the five built-ins every
installation ships. To import an existing collection, have an agent review it
and add the personalities worth keeping —
`relayhall personality create … --content-file <reviewed>.md` loads a file
wholesale (see [personalities.md](personalities.md#importing-personalities)).
Personalities are prepended to compiled Briefs — a Backend Architect reviews schema
changes differently than a Growth Hacker writes copy.

## 2b. Anchor each project's governing agreements (Charter)

Give each long-running project a Charter — its authority index. The Charter
lists where every governing agreement lives and what wins on conflict, and it
is included in every compiled Brief for the project automatically, so a
one-task agent starts with the project's standards in hand instead of
re-deriving them. Writes are owner-plane; see [charter.md](charter.md).

## 3. Connect an LLM proxy (model catalog)

Model metadata works through an OpenAI-compatible proxy (e.g.
[LiteLLM](https://github.com/BerriAI/litellm)), configured explicitly with
`LITELLM_ADMIN_API_URL` and `LITELLM_MASTER_KEY`. Once it is reachable,
the task execution-profile model pickers offer the live provider catalog.

## 4. Connect an orchestrator

RelayHall never starts or observes an agent runtime. A worker polls or receives
an event, reads assigned work with a scoped credential, compiles a Brief, and
runs it in its own trust boundary. It pushes task state and reports back to the
board. Keep that worker in a separate repository or deployment service; do not
mount its workspace, runtime home, or credentials into core.

## 5. Equip a Verifier

The core review preflight ([automated task Verifier](automated-task-verifier.md))
checks board-resident criteria, reports, and task/session metadata. It does
not semantically prove acceptance criteria. If a
review needs a browser, vault, repository checkout, or other privileged tool,
run an independent verifier outside core and have it file a report.

## 6. Optional service integrations

- **Webhooks / automation** — outbound webhooks (HMAC-signed) pair well with
  n8n or similar; see [api.md](api.md).
- **Plugins** — build your own dashboard panels as containers; see
  [plugin-development.md](plugin-development.md) and the example plugin.

## Security posture

Keep every credential in env vars or your vault — never in skill entries, task
notes, or config committed to git. Do not mount agent or workspace directories
into core. Bind the database to localhost. Before making any deployment public-facing,
put it behind your reverse proxy with TLS and strong auth.
