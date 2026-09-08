# CI: what runs, where, and how fast

RelayHall runs **two** workflows, and each is byte-identical on GitHub Actions
and on Gitea Actions — the first steps of the contract job are a `cmp` of every
pair, so they cannot drift.

| Workflow | Runs on | What it is for | Target |
| --- | --- | --- | --- |
| `ci.yml` — **fast tier** | every push of every branch except `ci-full/**`, every tag, every pull request | the check that catches the largest share of ordinary mistakes in the shortest time | green in **≤ 15 minutes** |
| `ci-full.yml` — **full tier** | `workflow_dispatch`, pushes to `ci-full/**` | every real-PostgreSQL gate, every mutation drill, every red-proof control | green in **≤ 25 minutes** |

## The ruling this shape comes from

Owner ruling, 2026-09-07:

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
the full tier claims nothing else, and a release ref or a tag keeps the fast
tier — which owns the publication, terminology and residue gates, and is the
last thing a release should lose. The full tier for a release is asked for by
name, on the exact SHA, before the tag exists. That is what the guard requires
anyway.

**Nothing in `ci-full.yml` carries an `if:`.** A gate that can be skipped by a
condition is a gate that will be skipped on the promotion it was written for, so
the trigger is the only thing that decides whether the full tier runs.
`scripts/check-workflow-shape.py` fails the build if a condition appears
anywhere in that file.

## No gate was dropped

`scripts/ci-gate-steps.txt` names every gate step this repository ran when CI
was split, and `scripts/check-workflow-shape.py` requires each of those 84 names
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
| `frontend` | `changes` | nothing under `frontend/` changed | ~8 min |
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
| any push to `main`, any tag | runs | runs | runs | runs |

The backend type check and mocked suite run on **every** push except the
documentation-only one: a backend change is not the only thing that can break
the backend.

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

Six jobs, each with its **own** `postgres:16` service, its own readiness wait and
its own `load-base-schema && migrate`. Every job's steps are in the same relative
order they held in the old serial `backend` job.

| Job | Contains | Measured (busy / quiet) |
| --- | --- | --- |
| `carriage_controls` | the carriage red-proof drill | 29 / 19 min |
| `mutation_controls` | Project→Task inheritance semantic controls; Blueprint document policy and census real-red controls | 25 / 23 min |
| `blueprint_controls` | Blueprint canonical runtime and gate real-red controls; Blueprint MCP isolated source; three clean installations | 21 / 21 min |
| `live_gates` | the 25-step live authorization chain, the personality contract, the boot check on the compiled build and the two drills that read `backend/dist` | 17 / 16 min |
| `feata_drills` | the FEAT-A backend and MCP red proofs | 10 / 9 min |
| `scale_load` | the estate-scale read-load contract | 5 / 5 min |

**Definition order is load order.** The runner takes four jobs at once and this
workflow has six, so whichever two are dispatched last decide the wall clock.
The carriage drill is the longest single step in the repository and cannot be
split, so it is defined first; the two shortest jobs are defined last. If you
add a job, put it in the file in descending order of expected duration.

Three order dependencies are load-bearing and are why the grouping is what it is:

- **`live_gates` starts with the list/point authorization parity gate**, on a
  freshly migrated database, because its assertions are equalities over counts.
- **The boot check stays ahead of the SETGOV contract census and the
  orchestration reachability drill**, because it is the step that runs
  `npm run build` and those two read `backend/dist`.
- **`scale_load` is the only step in its group**, and therefore trivially the
  last one. Its gate needs a fivefold size difference between a small estate and
  a large one, so a database any other gate has written to would invalidate it.

## Reproducing a job locally

Every job reproduces locally with the same commands the workflow runs. Run only
the one you touched.

```bash
cd backend  && npm ci && npx tsc --noEmit && npx jest --maxWorkers=4
```

```bash
cd frontend && npm ci && npx tsc --noEmit && npx vite build && npm run test:unit
```

```bash
cd cli && python -m pytest -q
```

```bash
scripts/test-deployment-safety.sh && scripts/test-github-config.sh
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

Superseded fast-tier runs are cancelled automatically, **except on `main` and on
tags**. Push twice to a branch and the older run stops where it is. On the two
promotion refs both runs complete, so every commit on the release path keeps its
own recorded result.

**Neither workflow declares `concurrency` for the full tier.** Every ref
`ci-full.yml` fires on is a promotion ref, and a discarded full run is
indistinguishable from one that was never required — so there is no group for a
later run to evict an earlier one from. What the forge itself does to free a
runner slot is a different matter, and is why one ref carries one workflow.

The tag trigger in the fast tier is explicit and load-bearing: `on.push.branches`
alone does **not** schedule tag refs, so a workflow with only a branch filter
runs no CI whatsoever on a release tag. If you ever edit either trigger block,
keep the tag line.

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

The private runner takes **four** jobs concurrently and caps a job at 75
minutes; every full-tier job declares `timeout-minutes: 75` to match. Measured at
capacity 2 the host peaked at load 6.9 of 32 cores with 25 GB RAM and 22 GB disk
free. Going higher needs a fresh measurement, and disk is the binding constraint
rather than CPU: each concurrent job holds its own workspace volume — and the
full tier now asks for six workspaces and six PostgreSQL containers rather than
three.

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
