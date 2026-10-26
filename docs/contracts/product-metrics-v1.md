# Product metrics: first core delivery slice

`GET /api/metrics` emits Prometheus text exposition 0.0.4 through the ordinary
authenticated route funnel. This initial slice reports current readable project
and task gauges. It does not complete the broader ratified metrics build.

Issue a separate direct Service Connector under the owning Account through the
existing supported credential workflow with **only** `metrics:read`, normal
expiry/revocation, and an API transport pin for HTTP scraping. Its own object
rules may narrow project/task reads. Every scrape rechecks the stored scope set,
credential liveness and live Account chain. An Agent, legacy identity, appointed
Main, parentless credential, broad credential or human session is refused.
This scope authorizes no product mutation and no other object API reads.

Set `RELAYHALL_METRICS_LABEL_KEY` to a persistent secret of at least 32 bytes via
the deployment secret configuration. Keep it stable across restarts; rotating
it deliberately changes the opaque project references. Neither the key nor raw
Account/project identifiers appear in the response. Configure
`RELAYHALL_METRICS_PROJECT_LIMIT` (default 200, range 1–10000). Invalid or absent
required configuration fails the scrape with 503. No query parameters can select
another Account or object set.

The collector applies the existing live project/task read predicates within
one repeatable-read, read-only database transaction with a five-second statement
timeout. No plugin or Service network call occurs on scrape. Project detail is
capped, ordered by stable IDs, and labels use keyed, Account-local opaque
references. `relayhall_tasks_aggregate{status}` counts every readable current
task, including orphan tasks and omitted projects; it is a gauge, not a historic
completion counter. `relayhall_projects` reports the full readable project
count. `relayhall_metrics_truncated{family="projects"}` and
`relayhall_metrics_omitted_projects` disclose overflow. Unknown stored status
values are counted in `relayhall_metrics_unknown_task_status`; they never enter
labels. Fixed board states with no tasks emit legitimate zero current counts.

`relayhall_metrics_source_available` explicitly reports unimplemented or unproven
durable event families, plugin, Governor, adoption, approval and deployment sources
as unavailable. Their numeric families are omitted. A core/auth/configuration
failure returns non-200.

The successor records **first completion of Account-owned tasks** in the
same database transaction as the task transition. A permanent HMAC tombstone
derived from the source and task ID prevents retries and reopening from counting
it again after event detail is pruned. The HMAC key is generated once and kept
across restarts. The tombstone has no Account or raw task ID. Secret-free event
detail contains source, task ID, Account ID and capture time. New events
update persistent UTC-day and cumulative tables exactly once. The collector
reports `relayhall_task_completions_total` since recording began,
`relayhall_task_completions_utc_day` for the current UTC date and
`relayhall_task_completions_rolling_24h` from the retained detail. These are
Account-owned counts, not a reconstruction of every task the Account can read.
An explicit collector object selector omits historical numbers and reports the
completion source unavailable, because aggregate history cannot safely honor
that selector. It does not broaden the collector's access.

Migration 150 does not backfill old completed tasks: their reliable transition
history is unavailable. `relayhall_metrics_history_complete{source="task_completions"}`
is therefore zero, and `relayhall_metrics_recording_since_timestamp_seconds`
states when verified recording began. Other completion paths without a verified
Account owner are omitted. Onboarding, deployment and refusal source families
remain unavailable; no numbers are inferred from current rows or partial audit
coverage. The broad `durable_events` availability flag remains zero until all
ratified event families are sourced.

`product_metric_retention` holds configurable `detail_days` (default 90) and
`daily_months` (default 13), changed through the normal database change route.
An event insertion prunes old rows at most once a day. The existing hourly
telemetry retention tick also calls `product_metric_prune()` so an idle system
does not retain detail indefinitely. An operator may call it during maintenance.
Pruning never resets cumulative totals or lifetime dedupe tombstones. Deleting
an Account cascades its readable detail, daily and cumulative rows; the opaque
tombstone remains so a restored task cannot be recounted. No new monitoring
schedule is added.
Responses are private to the collector and have `Cache-Control: no-store`.

Remaining parent deliverables include verified onboarding, deployment and refusal
producers, the versioned plugin definition/cache
contract and v1 compatibility, Account-bound Governor producer/freshness, and
configurable agent/connector/plugin caps with truthful aggregate totals. The
plugin-host board work remains unfinished; the Governor producer is unproven.
Their later slices require their own dependency readiness and independent review.

Run `npm run test:metrics` against an initialized, migrated disposable database
named `relayhall_report_sponsor_test` on 127.0.0.1 with `RELAYHALL_TEST_DB_URL` set.
The existing test target guard also admits the exact full-CI PostgreSQL service.
The default unit suite runs the pure/ingress checks; both full CI mirrors run the
real database gate. Production credential setup requires the normal supported
issuance path and auth-class TST rehearsal before release.
