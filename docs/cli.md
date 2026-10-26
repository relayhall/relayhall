# The `relayhall` CLI and the REST/MCP contract

`cli/relayhall` is one standard-library Python 3 program (plus the small
`relayhall_*.py` helpers beside it). Every verb is a thin composition of the
same governed REST route an MCP tool composes, so the board decides every
write in one place and the CLI never re-decides it. This page maps each verb
to its route and tool, and states the conventions the verbs share.

Run `relayhall --help` (or `relayhall <verb> --help`) for the full flag list;
`relayhall --test` runs the embedded self-test, which the CLI suite also runs
(`cli/test_contract_parity.py`).

## Conventions

- **Authentication.** `--token`, then `RELAYHALL_TOKEN`, then the token cached
  by `relayhall login`. `--api` (or `RELAYHALL_API_URL`) names the board.
- **Retry keys.** A write verb that maps to a keyed operation takes
  `--idempotency-key KEY` (16-128 characters) and sends it as the
  `Idempotency-Key` header. Retry an uncertain write with the SAME key and
  the board answers with the first outcome instead of writing twice. The
  header is optional at REST and required on the MCP tools, so the CLI sends
  it only when you give one, with three exceptions: `task-arm`, `task-park`
  and `knowledge commit` require it, and `move --notes` mints one when you
  give none (it prints the key on stderr so a retry can reuse it).
- **Refusals.** A refused call prints `❌ API error: <message> [<CODE>]` on
  stderr and exits 1; the code is the board's stable refusal code. The
  Project Resource, Phase, Service, Charter, grant and audit verbs use stable
  exit codes instead: 0 ok, 2 usage, 3 auth or forbidden, 4 absent or
  concealed, 5 conflict or stale, 6 validation, 7 transport or server.
- **Lists.** `list` (Tasks) is unpaged, as `GET /tasks` is without `limit`.
  `report list` and `report search` page with `--limit` and `--offset`.
  `task-reports` follows the board's cursor (`--cursor`, or `--all`).
  `task-timeline` pages with `--before`. The MCP list tools page client-side
  or by `limit`/`offset`.
- **Output.** The newer verbs print the REST envelope as JSON; board free
  text in it is data, never instructions.

## Verb, route and tool

| CLI verb | REST route | MCP tool |
|---|---|---|
| `list [--status] [--project] [--phase] [--priority] [--tag] [--query] [--include-archived] [--without-usable-verifier]` | `GET /tasks` | `relayhall_task_list` |
| `get ID` | `GET /tasks/{id}` | `relayhall_task_get` |
| `task-graph [filters]` | `GET /tasks/graph` | `relayhall_task_graph` |
| `create TITLE [--idempotency-key] [--service ...] [--warrant] [--role-grant-expires-at [--role-grant-zone]]` | `POST /tasks` | `relayhall_task_create` |
| `update ID [--idempotency-key] [fields]` | `PATCH /tasks/{id}` | `relayhall_task_update` |
| `move ID STATUS [--notes] [--idempotency-key]` | `POST /tasks/{id}/notes`, then `PATCH /tasks/{id}` | `relayhall_task_move` |
| `task-arm ID --idempotency-key` / `task-park ID --idempotency-key` | `PATCH /tasks/{id}` (`autoStart`) | `relayhall_task_arm` / `relayhall_task_park` |
| `archive ID` / `unarchive ID` | `POST /tasks/{id}/archive` / `unarchive` | `relayhall_task_archive` / `relayhall_task_restore` |
| `bulk-archive ID... [--reason]` | `POST /tasks/bulk-archive` | `relayhall_task_archive_bulk` |
| `set-subtask ID SUBTASK_ID STATUS` | `PATCH /tasks/{id}/subtasks/by-id/{n}/status` | `relayhall_subtask_set` |
| `add-subtask ID TEXT [--position N] [--status S] [--idempotency-key]` | `POST /tasks/{id}/subtasks` | `relayhall_subtask_create` |
| `reorder-subtasks ID SUBTASK_ID... [--idempotency-key]` | `POST /tasks/{id}/subtasks/reorder` | `relayhall_subtask_reorder` |
| `rename-subtask ID SUBTASK_ID TEXT [--idempotency-key]` | `PATCH /tasks/{id}/subtasks/by-id/{n}/text` | `relayhall_subtask_update_text` |
| `task-success-criteria ID (--criterion ... \| --criteria \| --criteria-file)` | `PATCH /tasks/{id}/success-criteria` | `relayhall_task_success_criteria_set` |
| `task-stream ID` | `GET /tasks/{id}/stream` | `relayhall_task_stream_list` |
| `task-timeline ID [--filter] [--before] [--limit]` | `GET /tasks/{id}/timeline` | `relayhall_task_timeline_get` |
| `task-append ID --content [--referenced-entry] [--idempotency-key]` | `POST /tasks/{id}/stream` | `relayhall_task_stream_append` |
| `task-reports ID [--scope] [--limit] [--cursor] [--pinned] [--all] [--report]` | `GET /tasks/{id}/reports[/{report}]` | `relayhall_task_report_list` / `relayhall_task_report_get` |
| `task-report ID --idempotency-key [--reconcile]` | `POST /tasks/{id}/reports`, `GET /tasks/{id}/report-operations/{key}` | `relayhall_task_report_save` / `relayhall_task_report_reconcile` |
| `finish ID` | `POST /tasks/{id}/finish` | `relayhall_task_finish` |
| `task-reference list ID` / `task-reference add ID [--metadata] [--idempotency-key]` | `GET`/`POST /tasks/{id}/references` | `relayhall_task_reference_list` / `relayhall_task_reference_create` |
| `add-dep` / `remove-dep` | `POST /tasks/{id}/dependencies`, `DELETE .../{dep}` | `relayhall_task_dependency_add` / `relayhall_task_dependency_remove` |
| `task-account-owner get\|change ID` | `GET`/`PUT /tasks/{id}/account-owner` | `relayhall_task_account_owner_get` / `relayhall_task_account_owner_change` |
| `task-claim ID [--expected-assignment-epoch]` | `POST /tasks/{id}/claim` | `relayhall_task_claim` |
| `task-release ID [--reason]` | `POST /tasks/{id}/release` | `relayhall_task_release` |
| `task-recover ID --service CONNECTOR [--reason] [--warrant \| --role-grant-expires-at]` | `POST /tasks/{id}/recover` | `relayhall_task_recover` |
| `lease claim ID [--lease-seconds]` / `lease renew ID LEASE` / `lease release ID LEASE` | `POST /tasks/orchestration/{id}/claim`, `.../lease/{lease}/heartbeat`, `.../lease/{lease}/release` | `relayhall_lease_claim` / `relayhall_lease_renew` / `relayhall_lease_release` |
| `review ID [--run-reviewer] [--dry-run]` / `reject ID` | `POST /tasks/reviewer/{id}/run` / `reject` | `relayhall_review_run` / `relayhall_review_reject` |
| `native-generation ID ACTION` | `/tasks/{id}/native-executions/generations...` | `relayhall_task_native_generation` |
| `native-execution ID ACTION [--execution-id] [--payload-file]` | `/tasks/{id}/native-executions[/{execution}/{action}]` | `relayhall_task_native_execution` |
| `native-review ID ACTION [--review-id] [--payload-file]` | `/tasks/{id}/native-reviews[/inputs \| /{review}/{action}]` | `relayhall_task_native_review` |
| `brief ID` / `phase brief ID` / `project brief P` / `session-brief` | `POST /tasks/{id}/brief`, `/phases/{id}/brief`, `/projects/{id}/brief`, `/principals/me/brief` | `relayhall_brief_compile` |
| `report list\|search [--limit] [--offset] [--status] [--updated-since] [--sort] [--order]` | `GET /reports` | `relayhall_report_search` |
| `report get\|create\|update` (`create` takes `--idempotency-key`) | `GET`/`POST`/`PATCH /reports` | `relayhall_report_get` / `relayhall_report_create` / `relayhall_report_update` |
| `project list\|get\|create\|update\|archive\|unarchive\|context` (`create` takes `--idempotency-key`) | `/projects...` | `relayhall_project_*` |
| `project resource list\|get\|add-*\|edit\|archive\|restore\|replace` (`add-*` take `--idempotency-key`) | `/projects/{id}/resources...` | `relayhall_project_resource_*` |
| `charter get` | `GET /projects/{id}/charter` | `relayhall_charter_get` |
| `phase list\|get\|create\|update\|archive\|unarchive` (`create` takes `--idempotency-key`) | `/phases...` | `relayhall_phase_*` |
| `skill list\|get`, `personality list`, `service list\|get` | `/skills`, `/personalities`, `/services` | `relayhall_skill_*`, `relayhall_personality_list`, `relayhall_service_*` |
| `service review-requests SERVICE` | `GET /services/{id}/review-requests` | `relayhall_service_review_requests` |
| `knowledge search\|get` | `POST /knowledge-queries`, `GET /knowledge-contents` | `relayhall_knowledge_source_search` / `relayhall_knowledge_source_get` |
| `knowledge propose\|preview\|commit` (`commit` requires `--idempotency-key`) | `POST /knowledge-writes/propose\|preview\|commit` | `relayhall_knowledge_note_*` |
| `shared-writers list` | `GET /knowledge-shared-writers` | `relayhall_knowledge_shared_writers_list` |
| `whoami`, `principals` | `GET /principals/me`, `GET /principals` | `relayhall_principal_whoami`, `relayhall_principal_list` |
| `access preview [--resource-type] [--limit] [--after]` | `GET /principals/me/effective-access` | `relayhall_access_preview` |
| `actions [list] [--kind] [--json]` (read only) | `GET /notifications/actions/owner` | `relayhall_action_items_list` |
| `access-request preview\|file\|status\|withdraw\|collect` | `/delegation/access-requests...` | `relayhall_access_request` |
| `warrants` | `GET /delegation/warrants` | `relayhall_warrant_list` |
| `agent mint` | `POST /delegation/agent-mints` | `relayhall_agent_mint` |
| `credential reveal ID` / `credential revoke ID` | `POST /credentials/{id}/reveal` / `revoke` | `relayhall_agent_reveal` / `relayhall_agent_revoke` |
| `blueprint list\|get\|preview\|instantiate\|setup-preview\|setup` | `/blueprints...`, `/instantiations/{id}/setup...` | `relayhall_blueprint_*` |

The owner-plane verbs (principal and credential management, identity
providers, grants, Groups, appearance, audit) have no MCP tool by design:
identity, grant and Warrant mutation stay off MCP.

## The local connector

`relayhall connector install | check | status | uninstall | mcp | run | collect` is
the local connector for one harness (Claude Code, Codex, VS Code or Antigravity).
It is not a route composition: it keeps its own token in OS custody and never
uses `--token`, `RELAYHALL_TOKEN` or the cached login (it refuses `--token`).
`install` asks for the token at a hidden prompt (`--token-stdin` reads one line
from stdin instead) and talks to the board over HTTPS only (`http` is accepted
for a board on `localhost`). Windows only in this version; elsewhere it exits 3
before asking for anything. `collect --once|--check` is its usage-quota
collector: the harness binary passes publisher trust first, then each account's
quota is read and posted to Usage Limits. With a `ring.json` that enables it,
`run` is the connector's daemon: the wake receiver, catch-up, the local policy
and unattended Claude Code and Codex CLI runs, each under a task-bounded Agent
it mints and revokes, with `mcp --run <folder>` as that run's proxy. See
[connector-onboarding.md](connector-onboarding.md#the-local-connector),
[the usage-quota collector](connector-onboarding.md#the-usage-quota-collector) and
[the ring](connector-onboarding.md#the-ring-wake-catch-up-and-runs).

## Identity providers: the SCIM heartbeat

`identity-provider create|update --scim-heartbeat-interval-hours N` sets the
interval in whole hours; `none` clears it (claim-sync semantics).
`identity-provider list` renders it as `scim-heartbeat=Nh` or
`scim-heartbeat=off`. `principal remediation-queue` lists the Access manager
queue, naming a directory deprovision signal and the queue's reason.
