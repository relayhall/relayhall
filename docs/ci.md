# CI: what runs, where, and how fast

RelayHall runs **two logical tiers** in **four workflow files**, with each tier
byte-identical on GitHub Actions and on Gitea Actions — the first steps of the contract job are a `cmp` of every
pair, so they cannot drift.

| Workflow | Runs on | What it is for | Target |
| --- | --- | --- | --- |
| `ci.yml` — **fast tier** | every push of every branch except `ci-full/**`, every tag except `v*` release tags, every pull request | the check that catches the largest share of ordinary mistakes in the shortest time | green in **≤ 15 minutes** |
| `ci-full.yml` — **full tier** | `workflow_dispatch`, pushes to `ci-full/**` | every real-PostgreSQL gate, every mutation drill, every red-proof control | green in **≤ 25 minutes** |

## Where this shape comes from

The project's direction, 2026-09-07:

> Parallelise everything; working on branches run a smaller number of tests
> focused on the thing being built; run the full tests only on demand,
> pre-release, when ready for final testing — not on every merge, because there
> may be multiple merges and one final test when they all come together.

Before it, one workflow ran everything on every push and took **69–89 minutes**,
paced by a single `backend` job that ran 33 gates strictly in series on one
shared database.

## THE GUARD — read this before you promote anything

The ruling moved the full matrix off every push. It did **not** make it
optional:

- **A full-tier green on the EXACT SHA is required before any TST deploy, any
  production deploy, and any release tag.** Not on an ancestor, not on "the same
  branch this morning" — the same forty-hex commit.
- **DEV may be deployed from a fast-tier-green `main`.** That is the whole
  latitude the ruling buys.

How to get one on demand, for a SHA that is not a release:

```bash
git push origin <sha>:refs/heads/ci-full/<something-you-will-recognise>
```

That ref exists for exactly this: it triggers `ci-full.yml` and nothing else.
`workflow_dispatch` from the forge UI does the same job.

**ONE REF CARRIES ONE WORKFLOW.** `release/**` and `v*` were the obvious extra
triggers for the full tier and they are deliberately absent. This forge cancels
a run to free a runner slot, so a push that schedules BOTH workflows on ONE ref
puts them in that queue against each other: four full-tier runs (1025, 1027,
1030, 1032) were destroyed that way, three of them within seconds of the
fast-tier run on the same ref starting. So the fast tier skips `ci-full/**`,
the full tier claims nothing else, and a release ref keeps the fast tier —
which owns the publication, terminology and residue gates. The full tier for a
release is asked for by name, on the exact SHA, before the tag exists. That is
what the guard requires anyway, and it is why a `v*` release tag runs neither
tier (see the tag trigger below).

**Nothing in `ci-full.yml` carries an `if:`.** A gate that can be skipped by a
condition is a gate that will be skipped on the promotion it was written for, so
the trigger is the only thing that decides whether the full tier runs.
`scripts/check-workflow-shape.py` fails the build if a condition appears
anywhere in that file.

## No gate was dropped

The existing server-written Task column gate also runs
`npm run drill:success-criteria` after the live suite. The control restores
the former generic criteria writer temporarily in its isolated checkout,
requires exactly the implementer PATCH persisted-column test to fail, and
restores source files in a finally block. Its database guard permits only a
local disposable test database or the exact CI PostgreSQL service; the same
control command can be reproduced locally from `backend/`.

`scripts/ci-gate-steps.txt` names every gate step this repository ran when CI
was split, and `scripts/check-workflow-shape.py` requires each of those 87 names
to appear **exactly once** across the two workflows. Once, not at least once: a
gate quietly present in both tiers pays its cost on every push, and a gate
present in neither has been deleted by a refactor rather than by a decision. The
rule fails closed, and the census file's own deletion reddens the gate's control
(`scripts/test-workflow-shape-gate.py`) rather than retiring the rule.

Adding a gate means adding its step name to that file in the same commit.

## The fast tier, job by job

| Job | Waits on | Skipped when | Measured |
| --- | --- | --- | --- |
| `changes` | — | never | ~15s |
| `repository-contract` | — (deliberately) | never | 5–7 min |
| `backend` | `changes` | the push touched documentation only | ~2 min |
| `frontend` | `changes` | nothing under `frontend/` changed | build, type check, proofs and the shard coverage check; no unit tests (below) |
| `frontend-unit` (3 shards) | `changes` | nothing under `frontend/` changed | one third of the unit tests each, in parallel with `frontend` |
| `cli` | `changes` | nothing under `cli/` changed | ~1 min |

`repository-contract` does **not** wait on `changes`: it is the critical path of
this tier and it is the one job a documentation-only push still needs.

### Path focus, and how it fails

`changes` computes `git diff --name-only` against the merge base with
`origin/main` and fails **open**, towards running more. Every area is set to
true when:

- the ref is `main` or any tag (a promotion ref);
- the merge base cannot be resolved, or nothing differs from it;
- **any path outside `backend/`, `frontend/`, `cli/` and the documentation set
  changed.** `scripts/` and the workflows themselves are in that outside set on
  purpose — a change there can alter what any job measures, including the
  isolated-source proofs that drill those very scripts.

So the only pushes that skip anything are the narrow ones:

| Change | `repository-contract` | `backend` | `frontend` | `cli` |
| --- | --- | --- | --- | --- |
| `backend/**`, `database/**` | runs | runs | skipped | skipped |
| `frontend/**` | runs | runs | runs | skipped |
| `cli/**` | runs | runs | skipped | runs |
| `docs/**`, `*.md` only | runs | skipped | skipped | skipped |
| `scripts/**`, workflows, anything else | runs | runs | runs | runs |
| any push to `main`, any tag other than `v*` | runs | runs | runs | runs |

The `frontend-unit` shards are skipped and run exactly when `frontend` is.

The backend type check and mocked suite run on **every** push except the
documentation-only one: a backend change is not the only thing that can break
the backend.

### The Frontend unit tests run as three parallel shards

`npm run test:unit` was one vitest worker over every unit-test file: 628 s on 22
October 2026 and 852 s on 24 October, inside a Frontend job of about 1250 s, and
growing. That one serial step was the critical path of the fast tier. The same
files now run as three jobs of the matrix `frontend-unit` (named
`Frontend unit tests (shard 1 of 3)`, `... 2 of 3`, `... 3 of 3`), in parallel with
the `frontend` job, which keeps everything that is not a unit test: type check,
build, the CSP boot-hash pin, the axe smoke set, the Blueprint and FEAT-A proofs,
the timezone control, and the shard coverage check below.

**Nothing is tested differently.** Each shard runs the command shape `test:unit`
uses (`NODE_ENV=test`, `--pool=forks`, one worker) over its own slice of the same
file set, so a shard measures what the serial step measured, on fewer files. The
timezone file stays out of the shards and runs once in `frontend`, as before; the
axe smoke file is in `test:unit`, and therefore in a shard, exactly as it was.

**The union of the shards is the file set, proved three ways**
(`scripts/frontend-test-shard.py`):

1. `check` (a step of the `frontend` job) takes the file list from vitest's own
   Node API, with the exclusions read out of the `test:unit` script in
   `package.json`, and requires every file to be in exactly one shard: a file in no
   shard is a GAP, a file in two is an OVERLAP, a path that is not in vitest's list
   is FOREIGN, and an empty shard is refused.
2. `check` then asks vitest what each shard's filters actually SELECT and requires
   it to equal the shard's assignment. vitest filters are substring matches, so a
   plan that partitions perfectly on paper can still run a neighbour (`a.test.ts`
   is a prefix of `a.test.tsx`).
3. `run` repeats the second proof for its own shard before it starts, so a job
   that skipped `check` still cannot run the wrong files. It then hands vitest the
   same `--exclude` globs `test:unit` uses (the ones the proofs selected with), so
   the proof measures the command that runs.

`scripts/test-frontend-test-shard-gate.py` (a step of `repository-contract`, no
node needed) is the control for those proofs: one defective plan per failure class
(gap, overlap, foreign file, empty shard, wrong shard count, a defective assigner,
a prefix collision, a run command that drops the exclusions), each required to go
red in its own class, and a correct plan required to pass. Rule 10 of `scripts/check-workflow-shape.py` holds the workflow
side: the matrix is exactly the shards `scripts/frontend-test-shards.json`
declares, with no `include` or `exclude`; `fail-fast: false`; the shards have the
same `needs` and `if` as `frontend`; the shard step is the one command, cut for
the declared count; no job still runs `npm run test:unit` serially; and neither the
shard job nor any of its steps sets `continue-on-error`, which would leave the run
green behind a red shard.

**The assignment is computed, never listed.** A new test file is assigned the
moment it exists; nobody registers it. What is stored is a duration estimate per
file in `scripts/frontend-test-shards.json`, used to balance the shards (longest
file first onto the lightest shard, deterministic). A file with no estimate gets
the median. Stale or missing estimates cost balance only, never coverage, so they
print a note and never fail. To rebalance after the suite has changed a lot, run
the unit tests once in one worker with a JSON report and regenerate:

```bash
cd frontend
NODE_ENV=test npx vitest run --pool=forks --maxWorkers=1 --minWorkers=1 \
  --exclude src/components/tasks/taskDueDateTimezone.test.tsx \
  --reporter=default --reporter=json --outputFile.json=/tmp/serial.json
python3 ../scripts/frontend-test-shard.py weights --report /tmp/serial.json --write
```

The estimate of a file is its cost in the serial run: from the previous file
finishing to this one finishing, so fork start, imports and environment set-up
count as well as the tests. A report from a parallel run is refused.

**Changing the number of shards** is three edits that must agree, and the gate
fails until they do: `shards` in `scripts/frontend-test-shards.json`, the
`shard: [...]` list and the `of N` in the name and the `--shard i/N` argument of
`frontend-unit` in both workflow copies. Anything that decides fast-tier green
from the forge's job list (the release decision does) reads these job names and
must be told the new count in the same change.

**Measured** on one build host, one worker per shard as in CI: the serial step
took 349.8 s; the three shards took 120.4 s, 124.9 s and 125.0 s, so the unit
tests now cost the slowest shard (125.0 s), not the sum. A shard job also pays
its own checkout, `setup-node` and `npm ci`, which the serial step paid once,
and the four-job concurrency of a runner now has three more jobs to hand out; on
a loaded shared runner expect the shards to be paced by the runner, not by the
arithmetic.

### Which jobs the public `main` requires

On the public repository `main` is protected by
`scripts/configure-github-repository.sh --protect`, which requires four status
contexts: `Repository and deployment contract`, `Backend type check and mocked
tests`, `Frontend build and tests` and `CLI tests`. These are the jobs that are
not a matrix. `Changed areas` is not required, and neither are the three
`Frontend unit tests (shard N of 3)` jobs.

**Why not the shards.** A required context is matched by name. A matrix job that
is skipped (here: `changes` found nothing under `frontend/`) reports one check
under its unexpanded name, `Frontend unit tests (shard ${{ matrix.shard }} of 3)`,
not under the three names the matrix would have produced, so a required
`... (shard 1 of 3)` would wait for a run that never comes. The shards still run
whenever `frontend` does, report red on a failing test, and are covered by the
required `frontend` job's shard coverage check; they are simply not a merge
condition by themselves.

**What a skipped job means for the four.** `backend`, `frontend` and `cli` have
`needs: changes`, and a skipped job satisfies a required check. `changes` fails
open towards running more, and `repository-contract` has no `needs`, so it runs
on every push; it is the one required check that never waits on `changes`.

`scripts/test-github-config.sh` (a step of `repository-contract`) derives the
non-matrix job names from this workflow, less `Changed areas`, and requires the
script's list to equal them, with negative controls for a list that adds a shard
and for one that drops a main job.

### Node images are exact patched releases, pinned by digest

`repository-contract` runs `scripts/check-node-base-images.py` and its control
`scripts/test-node-base-image-gate.py`. The gate reads every tracked
Dockerfile `FROM`, every workflow and compose `container:`/`image:` value and
every Node image named in a shell script, and fails when one is not pinned by
`@sha256:` digest, does not name an exact `MAJOR.MINOR.PATCH` release, is on a
major line with no patched minimum, or is below that minimum. The minimums are
the fixes for CVE-2026-111497 (Node.js Brotli decoder): 22.23.4, 24.22.1 and
26.12.1. Node 20 has no entry, so a Node 20 image fails: the line is past its
end of life. A `FROM` that reads its image from a build variable fails too,
because its version cannot be read.

To move to a newer release, pull the tag, read the digest it resolved to with
`docker image inspect --format '{{index .RepoDigests 0}}' node:<tag>`, and
write `node:<tag>@sha256:<digest>` in every place the gate lists. The
`setup-node` versions of the CI jobs are not images and are not checked here.

### Jest is not `--runInBand` any more

It was, and it cost about four minutes per run. Measured on the development
host over the same 253 suites and 4,547 tests:

| | wall clock |
| --- | --- |
| `npx jest --runInBand --silent` | **225s** |
| `npx jest --maxWorkers=4 --silent` | **43s** |
| `npx jest --maxWorkers=8 --silent` | 43s |

All green in every case. Four workers, not eight and not thirty-two: the runner
takes four jobs at once on a 32-core host, and eight bought nothing. The
database-backed suites are not in this run at all — they are separate npm
scripts in the full tier.

**One file still runs in band, and the class is what matters.** CI run 1031
reddened two assertions in `kw1KnowledgeFanout.test.ts` that measure REAL
ELAPSED TIME — a slow source must not spend an admitted source's budget — while
the same commit passed on run 1029. Nothing about fixtures broke: the suite took
52.9s instead of 40.7s because three other jobs were on the host, and a
wall-clock budget cannot tell a slow source from a busy CPU. So the step runs
two passes, `--maxWorkers=4` for everything else and `--runInBand` for that
file. **A file whose assertions measure elapsed time belongs in the serial
list; a file that is merely slow does not.** The two passes must together name
exactly the files `npx jest --listTests` names, checked before either runs — a
regex that quietly matched nothing would drop a whole suite and still look
green. Split cost: 37s + 43s against 225s.

## The full tier, job by job

Nine jobs, each with its **own** `postgres:16` service and readiness/schema
preparation. The original direct-helper jobs retain their relative order from
the old serial `backend` job; the authority-edit, assignment-coupling and
completion-reference jobs are separate specialized jobs described below.

The full tier runs only on the CI runner that carries the `relayhall-full` label: all nine jobs declare `runs-on: relayhall-full`, so a runner without that label never picks one up. A fork that has no such runner either adds the label to one of its runners or reverts that line to `ubuntu-latest` in both workflow copies. The fast tier is unchanged and stays on `ubuntu-latest`, so every runner still serves it.

`backend/scripts/wait-for-postgres.js` is the shared readiness gate. It requires
two successful `SELECT 1` queries two seconds apart, within a 180-second
monotonic budget, with bounded attempts and cleanup. A surviving CI service was
measured taking about 114 seconds to finish first-boot initialization, including
27 seconds synchronizing its shutdown checkpoint. That measurement justifies
the bounded startup allowance; it does not establish the cause of other failed
jobs whose service logs were already removed. Timeout still fails closed before
schema or tests. Each probe records elapsed time, phase and an allowlisted error
code/category; raw driver errors, connection strings and credentials are never
logged. Service health uses TCP to avoid accepting the temporary Unix-only
initialization server, with a 120-second start period before ten failed health
checks can mark it unhealthy (10-second interval, 5-second check timeout). That
separate finite service-health allowance also accommodates the measured boot on
runners that gate job setup on health. The 180-second query budget starts when
the helper runs, after setup; it is not a bound on total service or job startup.
Service health is not a substitute for the query gate.
The `relayhall_ci` services also set `PGCTLTIMEOUT: '300'` and
`POSTGRES_INITDB_ARGS: --no-sync` so their initialisation does not depend on disk
latency: on a busy runner disk the image entrypoint's temporary server overran
the default 60-second `pg_ctl -w` limit and the container exited before
readiness, and the databases are disposable, so skipping initdb's fsync is safe.


| Job | Contains | Measured (busy / quiet) |
| --- | --- | --- |
| `carriage_controls` | the carriage red-proof drill | 29 / 19 min |
| `mutation_controls` | Project→Task inheritance semantic controls; Blueprint document policy and census real-red controls; the UI refinement, Settings identity UI, Map plane, Personality version projection and Group roles drills (added 19 Oct 2026, not yet remeasured in CI) | 25 / 23 min |
| `authority_edit_controls` | AZ-A13 authority edit in-place live suite and mutation controls | not remeasured here |
| `blueprint_controls` | Blueprint canonical runtime and gate real-red controls; Blueprint MCP isolated source; three clean installations | 21 / 21 min |
| `assignment_coupling_controls` | S7 assignment-access coupling (all 19 sections, re-anchored to AZ-A10), then the 17-control role-grant-expiry mutation drill (the live suite itself runs once, in `live_gates`); last, a build and the compiled MCP/REST Task archive parity drill | isolated Linux replay: 18m23s; hosted CI pending |
| `live_gates` | the 25-step live authorization chain, the personality contract, the boot check on the compiled build and the two drills that read `backend/dist` | 17 / 16 min |
| `feata_drills` | the FEAT-A backend and MCP red proofs | 10 / 9 min |
| `scale_load` | the estate-scale read-load contract | 5 / 5 min |
| `completion_reference_lifecycle` | owned completion-reference lifecycle storage regressions, Node 22.23.4 bookworm, 10-minute timeout | not remeasured here |

**Definition order is load order.** The runner takes four jobs at once and this
workflow has nine, so queued work can extend the wall clock as slots become
available. The carriage drill is the longest single step in the repository and
cannot be split, so it is defined first; the shortest jobs are defined last. If
you add a job, put it in the file in descending order of expected duration.

The new `assignment_coupling_controls` job owns a fresh PostgreSQL service so
S7's backfill and lifecycle fixtures do not enter another live job's ordered
chain. Its three named steps each appear once in the gate census, on both forges.
All 17 expiry drill controls must fail only at their declared assertions,
with `sourceUnchanged` and `copyRemoved` closure receipts. The
150-minute job timeout is the existing runner ceiling, **not measured minutes**.
An isolated Linux runner replay on 13 October 2026 tested the
then-current source with Node 20 and PostgreSQL 16.
The test container had two CPUs and 4 GiB; its separate database had one CPU
and 1 GiB. Dependency installation took 9.15 seconds and database readiness,
base schema and migrations took 41.29 seconds. S7 passed all 57 assertions in
6.96 seconds; the expiry drill took 903.33 seconds, with its 28-test baseline
passing and all 17 controls failing at their exact declared assertions.
Both closure receipts were true. The complete isolated slot ran from
19:55:36 to 20:13:59 UTC (18 minutes 23 seconds), including setup, additional
static and type checks, and operator gaps. Source checkout preceded that slot.
This replay is within the 150-minute ceiling; it measures neither hosted CI
scheduler delay nor a busy/quiet hosted comparison. Hosted full-tier execution
and task acceptance remain pending.

AZ-A10 (migration 149) moved what both steps measure; on
15 October 2026 they were re-anchored without a product change. S7 now
gives its fixture actor a real administrator principal (role links record a
creating principal), gives the narrow assigner write on its task (the
implementer row needs it), reads role rows on the assignee where AZ-A10
lands them (sections 2, 4, 6, 11, 12 and 15), bounds section 14 to the
clause 4 role arm, and replays the backfill text of migration 149 instead
of 099, whose conflict target 149 removed (sections 13 and 18). It asserts
61 values. The drill's live baseline is now 30 tests, and control 4 (the
withdrawn floor) also declares the AZ-A10 verifier-role test, which writes a
date earlier than the default. The counts in the replay above predate this.

The `completion_reference_lifecycle` job uses the exact preparation chain
`node scripts/wait-for-postgres.js && node scripts/load-base-schema.js && npx ts-node --transpile-only src/db/migrate.ts`.
Its `&&` sequencing stops before schema if readiness fails. Unlike the
direct-helper jobs, it uses the owned `fixture` user and
`mixed_cleanup_test_lifecycle` database, with matching job-level PG*/DB_* fields.
The subsequent `npm run test:completion-reference-lifecycle` entry asserts the
explicit owned endpoint before spawning Jest; direct Jest config performs the
same assertion before importing the base config. That entry guard is not the
readiness wait. `ciPostgresReadiness.test.ts` enumerates all nine jobs and
rejects missing/reordered/masked/conditional readiness, extra schema paths and
endpoint drift. These mocked/static controls do not replace a full-tier run.

Three order dependencies are load-bearing and are why the grouping is what it is:

- **`live_gates` starts with the list/point authorization parity gate**, on a
  freshly migrated database, because its assertions are equalities over counts.
- **The boot check stays ahead of the SETGOV contract census and the
  orchestration reachability drill**, because it is the step that runs
  `npm run build` and those two read `backend/dist`.
  The MCP Task archive parity drill (`npm run test:archive-mcp-live`) also reads
  `backend/dist`, but it runs in `assignment_coupling_controls`, after the
  expiry drill, behind that job's own `npm run build`: placed inside
  `live_gates` ahead of the Standalone Report step it turned `test:metrics` red
  (503 `METRICS_UNAVAILABLE`) on the full tier. Its database guard permits only
  a local disposable test database or the exact CI PostgreSQL service.
- **`scale_load` is the only step in its group**, and therefore trivially the
  last one. Its gate needs a fivefold size difference between a small estate and
  a large one, so a database any other gate has written to would invalidate it.

**Why `test:metrics` went red at the end of `live_gates`.** Its
two failing scrapes were always the first ones after the collector was narrowed
to explicit objects. That predicate is one large expression whose estimated cost
grows with the Task count, and on the database the earlier steps had filled it
crossed PostgreSQL's JIT thresholds: the scrape spent about 6.5 s and 10.4 s
compiling two queries that ran in under 10 ms, overran its 5 s statement budget
and answered 503 `METRICS_UNAVAILABLE`. A fresh database stays under the
thresholds, which is why it never reproduced there. The scrape now runs with
`SET LOCAL jit = off`, as the authority preview already did, and keeps its 5 s
budget. `productMetricsLive` proves it on any database with a connection whose
JIT thresholds are zero.

## Reproducing a job locally

Every job reproduces locally with the same commands the workflow runs. Run only
the one you touched.

```bash
cd backend  && npm ci && npx tsc --noEmit && npx jest --maxWorkers=4
```

```bash
cd frontend && npm ci && npx tsc --noEmit && npx vite build && npm run test:unit
```

`npm run test:unit` is still the whole unit-test set in one process; CI runs the
same files as parallel shards. One shard, as CI runs it:

```bash
cd frontend && python3 ../scripts/frontend-test-shard.py run --shard 2/3
```

```bash
cd cli && python -m pytest -q
```

```bash
scripts/test-deployment-safety.sh && scripts/test-github-config.sh
python3 scripts/test-first-install.py && python3 scripts/test-first-install.py --self-proof
python3 scripts/check-doc-terminology.py && python3 scripts/check-public-residue.py
python3 scripts/check-public-allowlist.py
python3 scripts/check-workflow-shape.py && python3 scripts/test-workflow-shape-gate.py
```

The full tier's gates each need a disposable PostgreSQL. Never point one at a
deployment database: the live gates refuse any database whose name does not look
disposable, and that refusal is the last line of defence rather than the first.

`scripts/test-publish-gate.sh` is deliberately **not** in that list. It is the
single most expensive check in the repository — **~95s locally, 2.5–4.5 minutes
in CI** — because it builds throwaway clones and runs gitleaks over each one,
and it is what paces the fast tier. Let CI carry it. Run it locally only when
you are about to change publication policy itself, or when CI has told you it
failed.

## Running a full-tier job locally

`scripts/ci-local.py` runs ONE job of either workflow on your machine, step by
step, in the workflow's order, with the workflow's own commands and `env:`
values. It is how a branch proves the job it touched before its one push, and how
a red full-tier job is reproduced and repaired. It is not THE GUARD: a promotion
still needs a full-tier green on the exact SHA.

```bash
python3 scripts/ci-local.py list                       # jobs of both workflows
python3 scripts/ci-local.py run --job scale_load --out tmp/ci-local/scale_load
python3 scripts/ci-local.py run --job live_gates --out tmp/ci-local/live --from-step 22
```

What `run` does:

- **Steps.** Every `run:` step runs in order, under `bash -e` (or the step's
  `shell:`), in its `working-directory`, with the workflow, job and step `env:`
  merged as the runner merges them and `CI=true` set as the runner sets it.
  `uses:` steps are recorded as skipped: your checkout and toolchain stand in for
  them. `${{ secrets.NAME }}` is read from your environment; other expressions
  expand to empty.
- **Database.** A job with a PostgreSQL service gets one disposable database for
  the whole job, as in CI. `--db container` (the default) starts the service's
  image (`postgres:16`) bound to 127.0.0.1 on a random port, named
  `ci-local-<pid>-<job>` (or `--name-prefix`), and removes it at exit.
  `--db env` uses your `RELAYHALL_TEST_DB_URL` or `DB_HOST`/`DB_PORT`/`DB_NAME`/
  `DB_USER`/`DB_PASSWORD` instead, and refuses any host that is not loopback.
- **Mapping.** Every value a step's `env:` names for the service - its hostname
  `postgres`, port 5432, user, password, database, or a postgres URL on that
  host - is replaced by the local one. Inherited `DB_*`, `PG*`, `DATABASE_URL`
  and `RELAYHALL_TEST_DB_URL` are removed first, so a step sees only what the
  workflow gives it and never a database you happened to have exported.
  Credentials are never printed, and the password is masked in every log.
- **Results.** Under `--out`: `steps.jsonl`, one JSON record per step (`n`,
  `name`, `exit`, `result`, `seconds`, plus `log`, `cwd`, `requires`,
  `database` and the names of the mapped variables), `logs/NN-<step>.log` and
  `summary.json`. A red step never stops the run, so every red is visible; the
  exit status is 1 when any step was not green. `result` is `success`,
  `failure`, `timeout`, `skipped` or `env-unmet`.
- **Resuming.** `--from-step N` still runs the setup steps (`npm ci`, the
  readiness wait, base schema and migrations) and then step N onwards.
  `--skip-setup` skips those too, for a database you prepared before (use it
  with `--db env`).

**Suite guards.** Most live suites admit either the exact CI service or a
loopback database whose name looks disposable (`test`, `contract` or
`fixture`), and the job database is named `relayhall_ci_local_test` for that
reason. Some admit only one particular name. `scripts/ci-local-map.txt` lists
those guards; before each step the tool finds every file the step reaches (npm
scripts, the test files they name, the scripts the step runs and the files those
name) and renames the job database to the one name all of them admit. The rename
keeps the rows earlier steps wrote, so the chain stays the chain CI runs.
`python3 scripts/ci-local.py map` prints the current list:

| Step (job `live_gates` unless named) | Guard | Local database |
| --- | --- | --- |
| Current authority preview against the live evaluator (P2-D), and its mutation controls | 127.0.0.1 or localhost, a name starting `relayhall_p2d_test` | `relayhall_p2d_test` |
| The password act (the charter approval audit suite and drill); Standalone Report atomic creation and sponsor authority | `backend/src/__tests__/support/standaloneReportTestTarget.ts`: 127.0.0.1 and exactly `relayhall_report_sponsor_test` | `relayhall_report_sponsor_test` |
| Skill draft provenance against the creator kind | `skill_provenance_<suffix>` | `skill_provenance_ci_local_test` |
| Immutable Personality versions and production API contract | `personality_contract_<suffix>` | `personality_contract_ci_local` |
| Native verification evidence, authority and session correlation, and its session privacy mutation controls; MCP Task history readers | a loopback host and exactly `relayhall_native_review_test` | `relayhall_native_review_test` |
| `mutation_controls`: Task activity mutation controls | 127.0.0.1 or localhost and exactly `relayhall_task_activity_test` | `relayhall_task_activity_test` |
| `blueprint_controls`: canonical runtime and gate controls; three clean installations | the step passes `--profile ci`, which admits only the CI service | recorded `env-unmet`; run the script with `--profile local` instead |

With `--db env` a guarded step whose name your database does not satisfy is
recorded `env-unmet` with the name it needs, not run and reported red for the
wrong reason. `python3 scripts/ci-local.py check` fails when a map line matches
no file any step reaches (a renamed suite) or when a reached guard names a
database the map does not cover; it also compares the tool's YAML reader with
PyYAML when PyYAML is installed.

**One step at a time.** `plan --job <id> --out <dir> --json` prints the job as
separately runnable entries for a scheduler that grants capacity per step:

```json
{"schema": "ci-local-plan/1", "job": "scale_load", "head": "<sha>",
 "steps": [{"name": "scale_load-00-db-up", "heavy": false, "cmd": ["python3", "..."], "cwd": "<repo>", "kind": "db-up"},
           {"name": "scale_load-03-install-backend-dependencies", "heavy": true, "cmd": ["..."], "cwd": "<repo>", "n": 3}]}
```

`name` is a slug (`[A-Za-z0-9._-]`), `title` the workflow's step name. `heavy`
is true for a step that installs, loads or migrates the database, or may run more
than one test file; the readiness wait and a single `node --test` oracle are
light. The first entry starts the job database and leaves it to a holder process
that lives as long as the process that ran the entry (the scheduler) and removes
the database when it goes; the last two remove it and write `summary.json`, which
exits 1 if any planned step was not green. Each step entry records its result and
exits 0, so a scheduler that stops at the first non-zero exit still runs every
step. `plan` refuses a dirty tree, so the plan names the exact commit. A file a
step of the same `--out` created (recorded in its `wrote` field, such as a drill's
receipt) is not dirt, so `plan --from-step N` can resume that run.

**Where it differs from CI.** Steps run on your toolchain (the
`completion_reference_lifecycle` job's `node:22.23.4-bookworm` container (pinned by digest) is not
reproduced), a few steps write fixed paths under `/tmp` that two runs at once
would share, and a renamed database is visible to the step under its local name.
`python3 scripts/ci-local.py self-test` runs the tool against a stub workflow
with no database.

## What each full-tier step needs locally

A local reproduction of a full-tier job must
not trip a guard the step never meets in CI. The table below names, for every
gate step of `ci-full.yml`, what its suites and scripts ask of a local run. It
was built from the steps' `env:` blocks and from the guard lines of every file
each step reaches (the same census `scripts/ci-local.py map` and `check`
perform), not from the step names.

How to read it:

- **Local database.** In CI every step sees its job's service (host `postgres`,
  database `relayhall_ci`, `CI=true`), which each guard admits through its CI
  arm. Locally only the guard's loopback arm applies. "Loopback, name
  containing `test`, `contract` or `fixture`" is the arm most suites share;
  `ci-local.py` names the job database `relayhall_ci_local_test` for it and
  renames it before a step that asks for one exact name (the rows that name
  one). "CI service only" steps cannot run against a local database as written.
- **Environment beyond the service mapping.** Keys a step sets other than the
  `DB_*`, `PG*` and `RELAYHALL_TEST_DB_URL` mapping, which `ci-local.py`
  rewrites to the local database. `ci-local.py` also sets `CI=true` for every
  step, as the runner does.
- **Fresh database.** Only the rows that say so need one. Every other step
  runs in CI after the steps before it in its job, on the database those steps
  left, so reproduce a step after its predecessors (`run --job`, or
  `--from-step N`, which still runs the job's setup) rather than on an
  arbitrary shared database.
- **Drills that measure the whole board bring their own database.** The
  Notifications and Timeline, the Access Explorer and the Knowledge search
  console drills each migrate a fresh template database once and start every
  live run (the baseline and each control) on a fresh copy of it; the job
  database is copied aside first and restored at the end, so later steps meet
  it unchanged. On the shared job database a run read every earlier step's
  rows: the Access Explorer runs grew slower one after another until the
  `drill_controls` job outgrew its 150 minutes, and the console drill's
  selector control was refused as too broad by the knowledge sources the
  default search scope drill had registered. A new drill whose suite reads
  board-wide state follows the same shape. The Access Explorer and the
  Notifications and Timeline drills (about 50 minutes together) run in their
  own job, `board_drill_controls`, after `drill_controls`.
- The shared setup steps (`npm ci`, the readiness wait, base schema and
  migrations) need the job database and nothing else, and are not listed.

**The load rule for local runs.** Run one full-tier job at a time, each on its
own disposable database, and on a shared host only when the host has the
capacity for it. Two kinds of assertion need the machine or the database to
themselves: elapsed-time budgets (the fast tier's `kw1KnowledgeFanout` runs in
band for this reason) and whole-schema comparisons that wait for a quiet
database (the MCP-derived sessions suite, section (g)). Neither may be
loosened to pass on a busy host; run it again when the host is quiet.

| Job | Step | Local database | Environment beyond the service mapping | Also needs |
| --- | --- | --- | --- | --- |
| `carriage_controls` | Red-proof drill for the carriage controls (74e02a05, B-L10a) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `mutation_controls` | Project to Task inheritance semantic controls | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `mutation_controls` | Agent mint ceiling mutation controls (785e1eed) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `mutation_controls` | UI refinement mutation controls (9b761f09) | none | - | frontend `npm ci`; a CLEAN committed checkout (it clones it); no database |
| `mutation_controls` | Settings identity UI mutation controls (9b761f09) | none | - | frontend `npm ci`; a CLEAN committed checkout (it clones it); no database |
| `mutation_controls` | Map plane mutation controls (9b761f09) | none | - | frontend `npm ci`; edits and restores two frontend files in place: no other writer in the checkout; no database |
| `mutation_controls` | Personality version projection mutation controls (9b761f09) | none (it pins an unreachable placeholder database for its mocked suite) | - | - |
| `mutation_controls` | Authority edit frontend mutation controls (AZ-A13 stage 3) | none | - | frontend `npm ci` |
| `mutation_controls` | Knowledge default search scope mutation controls (40e0e542) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | frontend `npm ci` |
| `mutation_controls` | Task activity mutation controls (b595b3b0) | exactly `relayhall_task_activity_test` on 127.0.0.1 or localhost | `CI=true` | frontend `npm ci` |
| `mutation_controls` | Plugin view default mutation controls (8fe6d7bb) | none | - | - |
| `mutation_controls` | Sidebar widget grow mutation controls (E438, d1471ea9) | none | - | frontend `npm ci` (its widget half is vitest) |
| `mutation_controls` | Plugin health probe mutation controls (fa519c4c) | none | - | - |
| `mutation_controls` | Blueprint document policy and census real-red controls (7e202fca) | none | - | fixed `/tmp/blueprint-*-proof` paths (one run at a time) |
| `mutation_controls` | Grant and credential request mutation controls (785e1eed P1-B, P1-B-2) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `mutation_controls` | Group roles mutation controls (46cfbd1d) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `mutation_controls` | Lens contract mutation controls (4e159741) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | frontend `npm ci` (its dashboard half is vitest) |
| `mutation_controls` | Owner-only gates mutation controls (b5c83682) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `drill_controls` | Build the backend the compiled-process drills boot | none | - | - |
| `drill_controls` | Group stewards against the compiled process (46cfbd1d) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | builds `backend/dist` first (the step above); a FRESH database |
| `drill_controls` | Authority edit in place against the compiled process (1a38270d) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | builds `backend/dist` first (the step above) |
| `drill_controls` | Group owner tiers against the compiled process (ee81ee0f) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | builds `backend/dist` first (the step above) |
| `drill_controls` | Group ownership transfer against the compiled process (311229fd) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | builds `backend/dist` first (the step above) |
| `drill_controls` | Group principal against the compiled process (20f40e40) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | builds `backend/dist` first (the step above) |
| `drill_controls` | Default Verifier mutation controls (41e24358) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `drill_controls` | Group owner tier mutation controls (ee81ee0f) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `drill_controls` | Group ownership transfer mutation controls (311229fd) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `drill_controls` | Group principal mutation controls (20f40e40) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `drill_controls` | Notification hub mutation controls (b1e3b16d) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `drill_controls` | Non-UUID path id mutation controls (bc847bd0) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `drill_controls` | Project-scoped authorization mutation controls (RH-AZ.PROJ-a) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | edits and restores backend files in place: no other writer in the checkout |
| `drill_controls` | Dashboard authorization mutation controls (72258a60) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | edits and restores backend files in place: no other writer in the checkout |
| `drill_controls` | First-run administrator and role act mutation controls (27322abb) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | edits and restores backend files in place: no other writer in the checkout |
| `drill_controls` | Mint target authorization mutation controls (45e7110a) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `drill_controls` | Liveness bookkeeping bound mutation controls (8491557e) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | edits and restores backend files in place: no other writer in the checkout |
| `drill_controls` | Wake protocol 2 kinds and outcome mutation controls (E462 S4) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | edits a private copy of the tree; the source tree is fingerprinted before and after |
| `drill_controls` | Verification modes mutation controls (E462 S4b) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | edits a private copy of the tree; the source tree is fingerprinted before and after |
| `authority_edit_controls` | Authority edits in place, live (1a38270d) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `authority_edit_controls` | Authority edit in place mutation controls (1a38270d) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `blueprint_controls` | Blueprint canonical runtime and gate real-red controls (7e202fca) | CI service only (`--profile ci`); locally run the script with `--profile local` and its own fixture database | `CI=true` | fixed `/tmp/blueprint-*-proof` paths (one run at a time) |
| `blueprint_controls` | Blueprint MCP real-red controls in isolated source (7e202fca) | none | - | frontend `npm ci`; a fixed `/tmp/blueprint-mcp-proof` path |
| `blueprint_controls` | Three clean Blueprint installations and portability (7e202fca) | CI service only (`--profile ci`); locally run the script with `--profile local` and its own fixture database | `CI=true` | a fixed `/tmp/blueprint-examples-proof` path |
| `assignment_coupling_controls` | S7 assignment-access coupling, live (500fedaa) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `assignment_coupling_controls` | Role-grant-expiry mutation controls (500fedaa, absorbs 699b1f0b) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `assignment_coupling_controls` | MCP Task archive parity, live (94b3b6ea, 14d33463) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | builds `backend/dist` in the step |
| `live_gates` | List/point authorization parity (08f42f36) | loopback, name containing `test`, `contract` or `fixture` | - | a FRESH database: it is the first step and asserts equalities over counts |
| `live_gates` | Project-bounded selector form, live (95572530) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Task create/move target Project authorization (9c177e6a) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Project to Task Grant inheritance | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Project ownership authority and atomicity | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Task point-route refusal shape (f9b7febe) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Blueprint atomic creation, transport and retry contract (7e202fca) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Blueprint gates and role authority contract (7e202fca) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Session touch burst bound (8491557e) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Mint target authorization (45e7110a) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Grant and credential requests file, decide, collect and revoke, live (785e1eed P1-B, P1-B-2) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Internal execution keys are never request fields, live (7c77fcf3) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Server-written Task columns are never request fields, live (c3880767) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Notification history and read state, live (b1e3b16d L2) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Approvals hub view, live (b1e3b16d) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Assignment grant expiry, live (785e1eed P2-B) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Current authority preview against the live evaluator (P2-D) | `relayhall_p2d_test*` on 127.0.0.1 or localhost | `CI=true`, `P2D_COMPILED=1` | builds `backend/dist` in the step; `P2D_COMPILED=1` loads the compiled modules |
| `live_gates` | Authority preview mutation controls (P2-D) | `relayhall_p2d_test*` on 127.0.0.1 or localhost | `CI=true` | - |
| `live_gates` | Report link authorization (aad1894b, 91af25a6) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Telemetry projection authorization and replay (50e74c1d) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Telemetry receiver limits, two-client race (beac9c79) | any disposable database the `DB_*` keys name (the probe has no name guard: point it at a disposable one only) | - | a MIGRATED database: the probe derives its tables from `public` and refuses, naming them, without them |
| `live_gates` | MCP-derived agent sessions (35b73092) | loopback, name containing `test`, `contract` or `fixture` | - | nothing else writing to the database: section (g) waits for it to go quiet and diffs the whole schema |
| `live_gates` | Day-one connection acceptance (6e25ae48, 3f145fa3) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | The password act (bc5cd9f0) | exactly `relayhall_report_sponsor_test` on 127.0.0.1 | - | - |
| `live_gates` | Step-up through the Identity provider (a3e76724) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Knowledge fan-out set and board authorization (0b4b779b) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Directory group carriage, live (74e02a05) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Task write-field contract (9c3a1aa4, 7d38a6e0) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Featured, home group and the creation default, live (4287af8a) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Skill draft provenance against the creator kind, live (f87776ad) | `skill_provenance_<suffix>` | `CI=true` | - |
| `live_gates` | Session-brief bootstrap for a task-scoped Agent, live (1118fefa) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Rule-less task-bound Agent works its bound Task, live (c334177b) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | New-card defaults land in the project inbox phase, live (b13e5ac9) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Agent mint ceiling equals the live predicate, live (785e1eed) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Group principal kind and lifecycle, live (20f40e40) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Group roles, owners and managers, live (46cfbd1d) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Lens contract, live (4e159741) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Group owners' gates and the manager lens, live (b5c83682) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Group ownership by tier, live (ee81ee0f) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Default Verifier per Project and Phase, live (41e24358) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Group ownership transfer act, live (311229fd) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Knowledge write door through the router and MCP, live (b796067e) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Knowledge default search scope through the router and MCP, live (40e0e542) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Shared-area writer list, live and mutation controls (549cc51f) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Universal change requests: model, standing and decide, live (e97e65ea T1) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Universal change requests: mutation controls (e97e65ea T1) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | MCP action log through the router and MCP, live (ab8f78e9) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | MCP action log mutation controls (ab8f78e9) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Plugin bridge board metrics: queue and throughput, live (e220be94) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Plugin bridge board metrics: mutation controls (e220be94) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | MCP Lease claim through the router and MCP, live (76369965) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Subtask structure verbs through the router and MCP, live (2bc7b303) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Task activity attribution, authority and isolation, live (b595b3b0) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Non-UUID path ids refused by name through the router and MCP, live (bc847bd0) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Scoped connector WebSocket notifications against real PostgreSQL | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | - |
| `live_gates` | Retry contract against a real PostgreSQL (fb06c930, owner ruling 94ecf329) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Dependency graph concurrency and Brief authorization | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `live_gates` | Prove the SSO login-drill oracles (cba66ebb, 533db731) | none | - | - |
| `live_gates` | Prove the SETGOV drill oracles (bbec04de, annex 85a2218d) | none | - | - |
| `live_gates` | Immutable Personality versions and production API contract | `personality_contract_<suffix>` | `CI=true` | - |
| `live_gates` | Boot check on the compiled build (the artefact the container runs) | none | - | builds `backend/dist`; port 3997 free; no database |
| `live_gates` | Prove the SETGOV contract census and its normaliser anchor (bbec04de) | none | `RELAYHALL_BOOT_CHECK=1` | reads `backend/dist`: run the boot check first |
| `live_gates` | Prove the orchestration-configuration drill oracles (590c638a) | none | - | - |
| `live_gates` | Orchestration configuration reaches the compiled process (590c638a) | none | - | reads `backend/dist`: run the boot check first |
| `live_gates` | Native verification evidence, authority and session correlation (6b8af7d6) | exactly `relayhall_native_review_test` on a loopback host | `CI=true`, `RELAYHALL_DEPLOYMENT_ID=11111111-1111-4111-8111-111111111111` | - |
| `live_gates` | Native verification session privacy mutation controls (1444cc80) | exactly `relayhall_native_review_test` on a loopback host | `CI=true` | - |
| `live_gates` | MCP Task history readers, live (P2-C) | exactly `relayhall_native_review_test` on a loopback host | `CI=true` | - |
| `live_gates` | Standalone Report atomic creation and sponsor authority (a79978ee) | exactly `relayhall_report_sponsor_test` on 127.0.0.1 | `CI=true` | - |
| `feata_drills` | FEAT-A backend red proofs (7d38a6e0) | loopback, name containing `test`, `contract` or `fixture` | - | - |
| `feata_drills` | FEAT-A MCP receipt and schema red proofs | none | - | - |
| `scale_load` | Task read paths under load at estate scale (590e88cc) | loopback, name containing `test`, `contract` or `fixture` | `CI=true` | a FRESH database: the estate sizes are measured against an empty one |
| `completion_reference_lifecycle` | Completion reference lifecycle storage regressions | 127.0.0.1, an explicit non-default high port, `mixed_cleanup_test_*`, user `fixture` (its entry guard) | `CI=true`, `NODE_OPTIONS=...`, `RELAYHALL_OWNED_FIXTURE=completion-reference` | its own `node:22.23.4-bookworm` container, pinned by digest, in CI (not reproduced locally) |

## Replaying a published migration in a live suite

The live job runs every live suite on ONE database, so a suite that replays a
published migration with a committed query re-runs that file's DDL over what
later migrations made of the same objects. The shared-writer suite's replay of
157 narrowed the two retry-contract CHECKs that 164 and 166 had widened, and
the subtask-structure and retry-contract suites after it went red.
A replay that measures only the file's idempotence runs in a
transaction that is always rolled back, through
`replayInRolledBackTransaction` (`backend/src/__tests__/support/migrationReplay.ts`),
which fingerprints the whole public schema before and after and fails, naming
the objects, if anything changed. A replay that must commit (a mutation drill
edits the migration and needs the edit to land, or a backfill is read through
the router) is named in the register of `migrationReplayCensus.test.ts`, and
that fast-tier census fails as soon as a later migration redefines an object
such a replay defines.

## Drills outside both tiers

A mutation drill that no workflow runs rots without anyone noticing: its
anchors stop matching the code it mutates, or its inventory stops matching the
suites it drives, and the next person to need it finds it red before any
control has run. Four did exactly that and were repaired by name on
19 October 2026, and a fifth, still green, carried
the same literal-count class; each now has a full-tier step:

| Drill | What had drifted | Home |
| --- | --- | --- |
| `scripts/lenses-stewards-mutations.py` | control X1 spelled the step-up block twice and a later change rewrote it; control R1 did not declare the challenge-methods test the same change added on its route | `mutation_controls`: Group roles mutation controls (about 4 minutes) |
| `scripts/ui-refinement-mutations.py` | four literal test counts; the Task detail suite grew from 43 to 263 tests; one anchor became ambiguous when the sidebar widget blocks took the same spread. Since 20 Oct 2026 it also carries the board filter controls `filters-selected-first` (the Selected group drawn after the rest) and `filters-clear-own-only` (a filter's own clear reaching every filter), against `FilterBar.refinement.test.tsx`. The sidebar current-page control `single-current-page` is joined by `per-link-prefix-highlight`, which restores the per-link character-prefix rule so two entries are drawn active while the announced page stays single | `mutation_controls`: UI refinement mutation controls (vitest only) |
| `scripts/test-map-plane-mutations.py` | the size-map cell (`cellOf`), the faded container sink, the band's phase ground and the chip's caption ownership all moved; control `band-fade-override` is retired, because the phase ground carries no fade a constant override could differ from. Since 20 Oct 2026 it also carries the fit-to-shown controls `fit-replay` (a departure's hole closes), `fit-replay-b1` (a live task depending on an archived one returns to its column), `fit-organic-fit` (Organic regions and the archive core shrink back), `fit-sequence` (an edit re-sorts nothing), `fit-declared-order`, `fit-empty-phase`, `fit-absent-lane`, `fit-stored-record` and `fit-repack`; `fit-compaction` is retired, because the lattice is replayed from what is shown and has no hole left to close, and the `filter` control's test asserts that late measurements move nothing beyond the hole the filter closes. Since 20 Oct 2026 it carries a control per A7a behaviour: `edge-dedupe` and `edge-identity` (a relationship listed twice draws once, under a tuple identity), `split-keyboard`, `split-floor`, `split-storage` and `split-replaces` (the Map and list split), `link-ring`, `link-no-render`, `link-focus`, `link-row`, `link-scroll` and `link-chain` (hover linking), and `project-layer-contain` and `project-layer-depth` (the project ground beneath the phases) | `mutation_controls`: Map plane mutation controls (vitest only) |
| `scripts/ui-settings-mutations.py` | three literal test counts (the twin of the UI refinement drill); red at its baseline | `mutation_controls`: Settings identity UI mutation controls (vitest only) |
| `scripts/test-personality-version-mutations.py` | green, but its baseline and closing runs asserted a literal 39 tests | `mutation_controls`: Personality version projection mutation controls (mocked jest, under a minute) |

`scripts/blueprints-frontend-mutations.py` and
`scripts/blueprints-transport-mutations.py` are not orphans: the isolated
Blueprint proofs (`scripts/blueprints-isolated-proof.py`) run them in both
tiers.

The remaining eighteen were run on 20 October 2026, each on its own freshly
migrated disposable database. Fourteen were green as they stood; four had rotted
and were repaired by name. Every cheap green one now has a step in the full
tier's `drill_controls` job, on that job's own database (the compiled-process
drill that needs a fresh database runs first, right after the build the compiled
drills boot). Times are wall clock on a shared build host.

| Drill | On 20 October 2026 | Home |
| --- | --- | --- |
| `backend/scripts/lenses-stewards-compiled-drill.js` | green, 22 checks (about 15 s) | `drill_controls`, first after the build (it needs a fresh database) |
| `backend/scripts/authority-edit-compiled-drill.js` | green (about 15 s) | `drill_controls` |
| `backend/scripts/group-owner-compiled-drill.js` | green (about 15 s) | `drill_controls` |
| `backend/scripts/group-ownership-transfer-compiled-drill.js` | green (about 15 s) | `drill_controls` |
| `backend/scripts/group-principal-compiled-drill.js` | green (about 15 s) | `drill_controls` |
| `scripts/default-verifier-mutations.py` | green, 16 controls (about 3 minutes) | `drill_controls` |
| `scripts/group-owner-mutations.py` | green, 14 controls (about 5 minutes) | `drill_controls` |
| `scripts/group-ownership-transfer-mutations.py` | green, 13 controls (about 2 minutes) | `drill_controls` |
| `scripts/group-principal-mutations.py` | green, 57 controls (about 7 minutes) | `drill_controls` |
| `scripts/notification-hub-mutations.py` | green (about 4 minutes) | `drill_controls` |
| `scripts/non-uuid-path-id-mutations.py` | green, with `--live` (about 4 minutes) | `drill_controls` |
| `backend/scripts/az-proj-mutation-drill.ts` | green, 18 mutations (about 1.5 minutes) | `drill_controls` |
| `backend/scripts/mint-target-authorization-mutation-drill.ts` | green, 5 mutations and 1 compensated (about 1 minute) | `drill_controls` |
| `backend/scripts/dashboard-authorization-mutation-drill.ts` | RED: M13 and M18 anchored the two arms on the untagged `author_actor_id`, which a later review replaced with one join on `author_principal_id`. Re-anchored by name on the point read; 17 of 17 red (about 5 minutes) | `drill_controls` |
| `backend/scripts/first-run-mutation-drill.ts` | RED: M2 to M7 and M17 anchored the role act in the route, which moved into `PrincipalRoleService` (the change-request decision shares it), and the login-kind line M2 mutates gained a stored-session predicate. Re-anchored by name; 18 of 18 red (about 2 minutes) | `drill_controls` |
| `backend/scripts/presence-write-bound-mutation-drill.ts` | RED: M8's write delay (0.6 s) was measured against a 2 s acquisition deadline; a later change raised it to 15 s and the 503 never came (0.6 s and 2 s: 0 of 2). M8 now derives the delay from the shipped deadline at the measured ratio (0.3, so 4.5 s: red 3 of 3) (about 4 minutes) | `drill_controls` |
| `backend/scripts/scale-read-load-mutation-drill.ts` | RED before any control: it recreated its database through one developer's container by name. It now drops and re-creates the database `RELAYHALL_TEST_DB_URL` names, through `pg`, refusing a name that does not look disposable. Its M10 had become compensated (the D11 containment refuses an unset `DB_NAME` when the connection module loads, and the control was rewritten for that boundary); M10 now says so and M10b removes the D11 refusal and reddens the control | none: about 11 minutes of estate-scale seeding per run; run it on demand beside the `scale_load` job |
| `backend/scripts/tw1c-projection-mutation-drill.ts` | green, 21 mutations (about 15 minutes) | none: run it on demand when the telemetry projection changes (both of its gates already run in the full tier) |

The Group-owner hub work (AZ-A12 build 5) adds two drills to `drill_controls`
and one live suite to the full tier, each born with its step:
`backend/scripts/group-owner-hub-compiled-drill.js` (20 checks: the hub
classes, the owner fields, the owner-change socket and the Group-owner feed
basis against `dist/server.js` with real sessions, step-up and sockets; after
the Group principal drill), `scripts/group-owner-hub-mutations.py` (19
controls, each reddening its own declared tests of the live suite, two of
them for the build 4 skill rows of G.2 drill 1) and
`npm run test:group-owner-hub` (`src/__tests__/groupOwnerHubLive.test.ts`).

The Notifications and Timeline work (Slice A) adds
one live suite to the full tier and two drills to `drill_controls`. Each is
added with its step:

- `npm run test:notifications-timeline`
  (`src/__tests__/notificationsTimelineLive.test.ts`): two Accounts, the
  in-query arms and ceilings, the report builder's parity with
  `filterVisibleReports`, each action kind, the keyset windows, EXPLAIN index
  use on a seeded feed, the payload emits, and the runtime actor census: every
  route-level writer of a Timeline row (and the Phase create over the MCP
  ingress) stores the acting principal, and the person filter finds the row.
  It also measures the query on a realistic board: 100,000 feed rows over 90
  days and a dense last half hour, on a clock a day ahead of the database's,
  seeded inside one transaction that is rolled back, so the suite leaves no
  row behind and reads the same on a fresh database and a full-tier job
  database. On that board every filter's plan reads its index and never the
  feed sequentially, a narrow date window visits only its own rows, and every
  page answers within a generous 1 s at p95 (design choice C8's 300 ms is a
  production measurement, taken after the release). The Timeline transaction
  runs read-only with JIT off and a statement ceiling.
  The suite isolates itself: it asserts only on the rows and principals it
  creates, whatever earlier steps left in the job database. The Action Center
  adds the Timeline's text search (`q`: an object the caller cannot see never
  matches, an approval row's hidden Task title never matches, a searched page is
  never short, and on the realistic board the search never reads the feed
  sequentially and stays within the budget) and the seen mark on action items (a
  seen item stays listed, the unseen count drops, a new occurrence is unseen
  again, a key the caller cannot see is ignored without a trace, the mark is per
  caller).
- `src/__tests__/notificationsTimelineTimeout.test.ts` (fast tier): a
  Timeline statement cancelled at the ceiling answers `503
  TIMELINE_READ_TIMEOUT`; any other failure keeps the generic `500`.
- `backend/scripts/notifications-timeline-compiled-drill.js`: the same
  promises against `dist/server.js`, with real sessions and a real
  `tasks:read` Connector. It runs after the Access Explorer drill.
- `scripts/notifications-timeline-mutations.py`: 38 controls. Each
  one turns its own declared tests of the live suite red. The controls cover
  the in-query scope, each arm's ceiling, the report and skill conjuncts, the
  withheld approval actor, the `decidable` check, both keyset tuple compares,
  the window floor, the stream emit and the Phase create's acting principal,
  and the query fixes after the full tier: the date window's exact cursor
  bounds, each window's cap of one page per source, and the Timeline
  transaction's settings; and, for the Action Center, the text search (a
  title matched outside the arms' scope, an approval row matched on a Task
  title the caller cannot read, the search applied after the LIMIT, the
  caller's wildcards taken as wildcards) and the seen mark (a mark stored for
  a key the caller cannot see, another principal's mark counted, the bell
  counting seen items, a mark that ignores the occurrence).
  Every run starts on a fresh copy of a freshly migrated template (built once
  from the base schema and the migrations, recreated before each run), so no
  control pages through the rows an earlier run, or an earlier step of the
  `drill_controls` job, wrote. The job's database is copied aside and
  restored at the end.

The Action Center queue for agents adds one live suite to
the full tier and one drill to `drill_controls`, each with its own step:

- `npm run test:action-items-owner`
  (`src/__tests__/actionItemsOwnerLive.test.ts`): a person's own Connector and
  an Agent under it list every kind waiting on the person's Account (Decision,
  Verify, Stuck, Skill review) and their own, with the person's seen state;
  another person's Connector sees none of them; a title appears only where the
  caller can read the object, checked against the Task, Skill and Project point
  routes; the owner queue equals the Account's own Action Center list and the
  caps are its caps; nothing is marked, decided or written over REST, MCP or
  the CLI; and the MCP tool and the CLI print what the service answered. It
  asserts only on the principals and rows it creates.
- `scripts/action-items-owner-mutations.py`: 14 controls, each turning its own
  declared tests of that suite red by an assertion (the owning-Account
  resolution widened to a service Account, the read check taken from the
  person's reach, a title kept on an unreadable item, a Skill review shown
  without the Skill read, a Decision's detail kept, a Project name without the
  Project read, a copied predicate drifting, the merged cap, the caller's seen
  mark replacing the person's, a seen mark written by the read, and the MCP
  and CLI kind filters and concealed lines). It starts every run on a fresh
  copy of a freshly migrated template, like its neighbours, and `--describe`
  checks every anchor without a database.

The universal harness connector design (wake
protocol 2) adds one live suite to an existing step and one drill to
`drill_controls`, born with its step:

- `src/__tests__/connectorWakeKindsDb.integration.test.ts` rides
  `npm run test:connector-notifications` (`live_gates`): the `verify` and
  `stuck` kinds rung from the Action Center's own predicates, their
  withdrawal and dedupe, a Connector that may not see the Task, the
  protocol-1 gate Hermes depends on, the own-work guard, the `wake.outcome`
  entries and the catch-up pull.
- `scripts/connector-wake-kinds-mutations.py`: 16 controls, each withdrawing
  one of those guards in a private copy of the tree; each must turn exactly
  its declared tests of that suite red by an assertion. The suite writes only
  rows it creates under random handles, so every run shares the job's
  database; `--describe` checks every anchor without a database.

Verification modes (design section 6.8) add
one live suite and one drill, each born with its step:

- `src/__tests__/verificationModesLive.test.ts` (`npm run test:verification-modes`,
  step "Verification modes per Task, live (E462 S4b)" in `live_gates`): who may
  set `none` (never an Agent, never the implementing chain) and when, the
  displaced default and the audit and Timeline rows, a `none` finish that
  completes the Task and readies and rings its dependent, the setter re-check,
  the assigned claim without a Verifier, the `verifier-agent` arm and its
  negative controls, the chain guard G(Task), and the S4 review folds (the
  wake's guard reads G, protocol 2 while any open socket speaks it).
- `scripts/verification-modes-mutations.py`: 36 controls, each withdrawing one
  of those guards in a private copy of the tree; each must turn exactly its
  declared tests of that suite red by an assertion. `--describe` checks every
  anchor without a database. The S4 drill's own-work and protocol anchors now
  name G(Task) and the derived protocol (repaired by name).

Run a drill as its step does: from `backend/`, with `RELAYHALL_TEST_DB_URL` and
the `DB_*` keys naming the same disposable database (`CI=true` only in CI);
the compiled-process drills need `npm run build` first.

## The publication allowlist will catch you out

`.relayhall-public-allowlist` is not a filter — it is a **whole-tree manifest**,
and `scripts/publish-to-github.sh` requires it to equal
`git ls-tree -r --name-only <sha>` **exactly**. Adding, renaming or deleting any
file breaks it, in either direction. That is deliberate: every path that reaches
the public repository has been looked at by someone.

The trap is that this does not show up as a merge conflict. Two branches can
each add files, merge with zero conflicts, and produce a tree that fails the
gate — git reports a clean merge and nothing warns you until the gate runs.

So run the cheap check, which makes the identical comparison in well under a
second and prints the exact paths:

```bash
python3 scripts/check-public-allowlist.py
```

It runs in CI too, immediately before the expensive gate, so this failure costs
~1s instead of minutes. It checks `HEAD`, so commit first — it will tell you if
your working tree is dirty. Use `--rev` to check a merge result before you push
it.

It will not edit the allowlist for you. Approving a path for publication is a
review decision, and a tool that silently added whatever showed up in the tree
would defeat the gate it exists to support. Paste the paths it prints, in the
order it prints them.

Note that the contract scripts require a clean working tree, because they build
throwaway clones of `HEAD`. Commit first, then run them.

## Cancellation

Owner update, 2026-10-07: development iterations use **latest commit wins**.
Regular CI cancels older queued and running runs for the same workflow, event
and branch. Push and PR concurrency groups remain independent. Same-repository PR jobs
skip because the head commit already receives push CI; fork PRs, PRs from
`ci-full/**` (which do not receive fast push CI), and payloads missing a
matching repository identity or head branch still run. The two root jobs share this
condition; backend/frontend/CLI depend on the changes job and therefore skip
with it. No required test is removed from the push run. Different branches
never cancel each other. Recheck required status contexts before adopting this
policy on a forge that requires PR-event-specific statuses.

The full tier also cancels superseded pushes to the same `ci-full/**` branch.
Use a stable branch name (for example `ci-full/owner-main-control-20261007`)
during iteration rather than making a new branch for every commit.

Runs on `main`, `release/**` and tags retain their regular CI evidence.
Manual dispatch exists only in the full tier. Full-tier `workflow_dispatch` runs, `ci-full/main` and
`ci-full/release/**` runs retain their full evidence. Protected runs use a
unique run-ID group: merely setting `cancel-in-progress: false` can still
replace an older pending run in a shared concurrency group.

Cancellation means superseded, never passed. The newest candidate still needs
every required check green on its exact SHA before promotion. Existing runs
created before this policy may need explicit, branch-and-SHA-checked cancellation.
No deployment workflow is changed by this policy.

For a retained release qualification, push the exact candidate to
`ci-full/release/<release-name>` or use manual dispatch. Keep that evidence
separate from the reusable development branch; cancellation is never a substitute
for completing the newest candidate’s required tests.

Compatibility: Gitea 28 stores the serialized concurrency mapping in a
255-character column before evaluating it. Keep the entire mapping below that
limit (current mappings serialize to approximately 216 and 188 bytes).
Protected runs have unique groups even though cancellation is enabled;
no subsequent run shares their group. Names containing `/release/` are
conservatively retained, and full-test refs ending `/main` are retained.

The tag trigger in the fast tier is explicit and load-bearing: `on.push.branches`
alone does **not** schedule tag refs, so a workflow with only a branch filter
runs no CI whatsoever on a tag. The fast tier carries `tags-ignore: ['v*']`
beside its branch filter, which schedules every tag except a release tag.
Release tags (`v*`) do not run CI, because a release tag is placed only after a
full-tier green on the exact SHA and a green readback, so a run on the tag would
re-test a commit that has already passed both tiers. If you ever edit either
trigger block, keep the `tags-ignore` line: deleting it stops CI on every tag,
and `tags` cannot be added beside it on the same event.

Publication is a separate gate and is not driven by CI at all:
`scripts/publish-to-github.sh` builds the allowlisted snapshot and enforces the
exact allowlist match, the private-residue contract and a pinned gitleaks scan
over it. It does not run the build or test jobs — those are covered by the CI
run on the commit being published.

## Why the private runner does not use the Actions cache

The workflow asks for `cache: npm`, and on GitHub that cache works and is worth
having. On the private Gitea runner the cache **server is deliberately off**, so
you will see this warning once per Node job:

```
::warning::Cache action is only supported on GHES version >= 3.5.
```

That warning is expected and is not a fault. The history: `act_runner`'s cache
server advertises its own address on the runner's Docker network, but each job
container gets its own per-job network and cannot route there. Every Node job
therefore spent two ~270-second TCP connect timeouts — once restoring, once
saving — which was 542 of the 598 seconds each Node job took.

The same disabled cache server is why there is **no `actions/cache` step keyed
on the lockfile hash** in either workflow. It was considered for this split and
would restore nothing here; `npm ci` is measured at **8–11 seconds** per job in
CI, which is not the problem. On GitHub, `setup-node`'s own `cache: npm` already
covers it. If the cache server is ever repaired, key it on
`hashFiles('**/package-lock.json')` and measure before keeping it.

## Options considered and rejected

**Restricting the publication gate to `main`, tags and PRs.** It is the largest
remaining item on the fast tier's critical path at 2.5–4.5 minutes. Not taken:
it trades defence in depth on a security gate for minutes, and it moves the
discovery of a broken allowlist from the branch you are working on to the moment
you promote. Ask for it explicitly if fast-tier latency starts to hurt; do not
let it arrive as a side effect of another change.

**Splitting the carriage red-proof drill.** It is one `npm` script and the
longest single step in the repository. Splitting it is a change to the drill, not
to CI, and it needs its own card.

**Skipping the backend job when only the frontend changed.** Rejected by the
same reasoning that puts `scripts/` in the "everything changed" set: a backend
change is not the only thing that can break the backend, and the type check plus
the mocked suite now cost about two minutes.

## Runner capacity

The private runner takes **four** jobs concurrently (the full-tier runner one at
a time since 19 October 2026, for the race described below) and caps a job at 150
minutes (raised from 75 on 11 Oct 2026, after the document-controls job, 63 minutes on an idle runner, was killed twice beside running lanes); the eight full-tier jobs other than completion-reference lifecycle declare `timeout-minutes: 150` to match;
the completion-reference job declares a tighter 10-minute timeout. Measured at
capacity 2 the host peaked at load 6.9 of 32 cores with 25 GB RAM and 22 GB disk
free. Going higher needs a fresh measurement, and disk is the binding constraint
rather than CPU: each concurrent job holds its own workspace volume — and the
full tier now asks for nine workspaces and nine PostgreSQL containers rather than
three.

**The setup-node action-cache race.** The private full-tier
runner's `act_runner` clones every remote action into one cache directory per
`uses:` string, shared by all the jobs it runs at once. The clone is locked;
the copy into a job's container is not; and a clone of `actions/setup-node@v4`
fast-forwards the shared checkout to the action's default branch and back.
A job copying the action while a neighbour clones it fails at its first step
with `lstat .../<file>: no such file or directory` or
`Cannot find module '.../dist/setup/index.js'`, before any repository code
runs. Nothing in the workflows can remove it: pinning the action to a commit
does not stop the clone's pull, a pre-warm job does not stop each later job's
own clone, and a retry of the setup step needs either an `if:` (refused in the
full tier, above) or an unconditional second setup step that races in the same
way. The runner side holds it instead: one job at a time until `act_runner` is
upgraded past the release that serialises action-cache reads (upstream fix in
1.0.2), after which concurrency can return. Until then a red at the setup step
with either signature is this race, not the change under test.

## SCALE fixture database guard

The scale-load suite and its seed script share one host predicate. Local
disposable databases remain supported. The service hostname `postgres` is
accepted only when `CI` is exactly `true` and the resolved database name is
exactly `relayhall_ci`, matching the workflow's disposable service fixture.
It is refused outside CI, for other database names, or through another remote
hostname. Deployment database names and missing names are refused. The seed
checks the database configuration used by its actual pool, including defaults.

`scaleDatabaseGuard.test.ts` drives both real entry guards without opening a
database connection: the live suite is stopped at its first Express import,
after the URL check and before pool setup. Thirty cases include CI admission,
missing/false/noncanonical CI markers, remote hosts, unrelated databases and
the deployment defaults. Prove the controls by temporarily changing each
boundary and requiring its predeclared exact failing assertion set:

```bash
python3 backend/scripts/test-scale-database-guard.py --output-dir tmp/scale-guard
```

The load mutation drill writes its logs under the ignored repository directory
`tmp/scale-drill` by default; `SCALE_DRILL_LOGS` overrides that directory. Its
database reset still uses the drill's documented local disposable container.
The child-lookup index migration is129 in the reservation ledger.

Lifecycle entry/scheduler correction: both npm run test:completion-reference-lifecycle and direct Jest --config backend/jest.completion-reference.config.js apply the same pure endpoint assertion before any base config, service or pool imports. RELAYHALL_TEST_DB_URL is the authority for the assertion; actual readiness PG* and storage DB_* must exactly match its decoded fields. DATABASE_URL is ignored. Local fixture requires 127.0.0.1, explicit non-default high port and mixed_cleanup_test_* database; CI postgres:5432 requires CI=true and fixture user. The legacy file notifier these suites once stubbed is removed (choice C10); a status move's notification is its feed row, which the suites assert. The scheduled warrant callback reports each resolved retryable warrantId/status/code through existing diagnostics and waits for the next 60-second tick; there is no immediate retry. Creation-owner COMMIT 40001 rolls back and maps to ASSIGNMENT_REFERENCE_BUSY/409.
