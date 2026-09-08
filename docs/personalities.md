# Personalities

Personalities are reusable instruction templates attached to tasks. Their
Markdown is included when RelayHall compiles a task Brief; RelayHall does
not launch or control an agent.

> **Terminology note.** The Personality registry described here is distinct
> from the retired personality *status voice* subsystem, which used the same
> word for a bot's first-person presence updates (surface removed by
> amendment A13; its historical rows remain dormant).

## Clean-install defaults

Every installation starts with five built-in personalities:

- **Generalist** — the default for ordinary task creation
- **Planner**
- **Implementer**
- **Verifier**
- **Researcher**

Built-ins are stable read-only defaults. Create a managed personality when you
need an editable variant. Personality selection is optional. The dashboard and
CLI prefer `generalist` when it is available, but the REST API also accepts a
task with no personality.

## Manage personalities

The dashboard **Personalities** page can create, edit, and soft-retire managed
personalities. Built-in personalities — and rows imported by the retired
repository sync of earlier releases — are read-only in this lifecycle; create a
managed personality when a different contract is needed. Retirement preserves
linked task and session history.

> CLI setup (run from the repository, no install step): `./cli/relayhall`,
> `--api`/`RELAYHALL_API_URL` for the endpoint, `relayhall login` once to cache
> a token — see the README's "Using an external harness" section.

```bash
relayhall personalities
relayhall personality create --slug security-reviewer --name "Security Reviewer" \
  --category review --content "# Mission\nFind security boundary failures."
relayhall personality update security-reviewer --description "Adversarial security review"
relayhall personality retire security-reviewer --reason "Consolidated"
```

Authority (amendment A12): reads require `personalities:read`; create and
update require `personalities:write`; retire requires `personalities:admin`
(management authority is additionally enforced in-handler). The equivalent
authenticated REST routes are:

- `GET /personalities`
- `GET /personalities/:id-or-slug`
- `POST /personalities`
- `PATCH /personalities/:id`
- `DELETE /personalities/:id`

MCP exposes `relayhall_personality_list` and nothing else: Personality
creation, update and retirement are capability-plane administration and were
removed from the MCP surface at the Phase-3 re-scope. They stay on the CLI,
REST and dashboard, with a human present — board text is attacker-writable
input to an LLM context, and the behaviour profile a Task runs under is not
something a prompt-injected harness should be able to rewrite.

## Importing personalities

Personalities are board-native: the database is the single source of truth,
and there is no repository synchronization. To bring personalities in from an
external collection (a git repository of Markdown personality files, another
board, a gist), have someone **review the material and add the chosen
personalities through the normal create surfaces** — the CLI, REST, or the
dashboard. Review-before-import is the point: nothing enters
the registry without a decision.

The CLI loads a reviewed file wholesale, so the Markdown needs no shell
quoting:

```bash
relayhall personality create --slug backend-architect --name "Backend Architect"   --description "Designs maintainable backend services" --category engineering   --color green --content-file ./backend-architect.md
```

`--content-file` is also accepted by `relayhall personality update`. Imported
rows created this way are ordinary managed personalities: editable, retirable,
and versioned by the registry like anything else created on the board.

Rows labelled *imported* on the Personalities page came from the repository
sync that earlier releases shipped (removed 2026-08). They are preserved
read-only; create a managed personality to evolve one.

## Use a personality

```bash
relayhall create "Refactor auth module" --project my-project
relayhall create "Threat-model login" --personality security-reviewer
relayhall brief <task-id>
```

The estate-era `clawboard` entry point was removed with the vocabulary purge (D-9).
