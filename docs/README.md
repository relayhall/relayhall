# RelayHall Documentation

Index of the documentation in this directory. Start with the main [README](../README.md), [DEPLOYMENT](../DEPLOYMENT.md), and [CONTRIBUTING](../CONTRIBUTING.md) at the repo root.

## Getting Started
- [getting-started.md](getting-started.md) — 5-minute setup guide
- [going-further.md](going-further.md) — wiring RelayHall into your own infrastructure (starter-pack guide)
- [mount-points.md](mount-points.md) — volume mounts the stack needs

## API
- [api.md](api.md) — API usage notes; the machine-readable spec is served at `GET /openapi.json`
- [report-handover.md](report-handover.md) — the optional structured handover object a Report may carry

## Features
- [observability.md](observability.md) — the reporter model (F11): why Sessions/Stats are empty-state, the ingest contract, pipeline health
- [personalities.md](personalities.md) — Personality instruction templates for agent tasks
- [execution-profiles.md](execution-profiles.md) — task execution modes and access profiles
- [Task orchestration](task-orchestration.md) — task lifecycle, review flow, Verifier heartbeat
- [Automated task Verifier](automated-task-verifier.md) — deterministic review preflight
- [Task execution options](task-execution-options.md) — execution option reference
- [skills.md](skills.md) — the Skills registry: instruction entries served to agents, and how Skills differ from Phase-2 Tools
- [charter.md](charter.md) — the Charter: a project's authority index, included in every compiled Brief
- [services.md](services.md) — the Service registry: registered external systems, Connectors, and versioned capability descriptors
- [grants.md](grants.md) — object-level grants: (grantee, resource, verb) authority, owner-plane management
- [authorization.md](authorization.md) — the shared authorization predicate, evaluation order, Task roles, and route coverage
- [phases.md](phases.md) — the Phase object: grouping tasks under one outcome, the goal property, and the phase brief
- [dependency-picker.md](dependency-picker.md) — task dependency picker behavior
- [RelayHall doctor usage](relayhall-doctor-usage.md) — `relayhall doctor` CLI
- [MCP server](mcp.md) — authenticated personality and principal MCP verbs
- [harness-support.md](harness-support.md) — the A/B/C support tiers: what each class of client can do today
- [oauth.md](oauth.md) — the OAuth 2.1 authorization server: the Tier-B front door, Client ID Metadata Documents, and what an access token actually is
- [Principals](principals.md) — clean-install identity provenance and lifecycle
- [task-elements.md](task-elements.md) — what the Task core carries and what is composed around it
- [lifecycle-policy-contract.md](lifecycle-policy-contract.md) — the evaluator contract: what RelayHall owns and what an installed evaluator owns
- [terminology.md](terminology.md) — where the working vocabulary is decided while RelayHall is being built

## Plugins
- [plugin-development.md](plugin-development.md) — how to build a plugin
- [example-plugin/](example-plugin/) — minimal hello-world plugin
- [seams.md](seams.md) — the five deployment seams the core never embeds a vendor on

## Engineering References
- [ci.md](ci.md) — what CI runs, the local commands that reproduce each job, and why the private runner skips the Actions cache
- [PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md) — architecture narrative
- [CONTEXT-OPTIMIZATION.md](CONTEXT-OPTIMIZATION.md) — agent context optimization guidance
- [design-system.md](design-system.md) — the design contract the appearance gates enforce
- [publishing.md](publishing.md) — the two-repository model and how a public release is cut
- [third-party-licenses.md](third-party-licenses.md) — licences for third-party assets shipped in the tree
- [design-history/](design-history/) — superseded design records, kept for provenance

## Assets

- [brand/](brand/) — the brand package: the architecture diagram in both Themes, the social card and the org avatar
- [images/](images/) — the screenshots the README shows, captured from a demonstration deployment

Files keyed to internal task IDs or dates are point-in-time working notes, not living documentation.
