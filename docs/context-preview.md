# Inspecting agent context

View context is available on Task details, each Phase, Project details, saved Skill details and Report details. It loads only when opened. Choose the operation, inspect the exact plain text, refresh it or copy it. Escape closes the preview and returns focus to its button. Closing discards the response; nothing is placed in persistent storage.

The preview uses the signed-in caller's existing API access. It does not impersonate an agent. A different credential, revision or operation can return different data. All authorization remains in the canonical routes. The browser never fetches concealed references to enrich a result.

## Retrieval matrix

| Element / choice | Canonical request | Meaning and adapter differences |
| --- | --- | --- |
| Task / compiled brief | POST /tasks/:id/brief with {} | Default Markdown brief body, including existing quoted-data fences. Same default body selected by CLI brief and MCP brief_compile taskId. MCP concise adds a fence and budgeted pages; detailed returns the whole response envelope. |
| Task / record | GET /tasks/:id | Complete returned API envelope. MCP task_get detailed serializes the same envelope with two-space JSON indentation; CLI formats fields for humans. |
| Phase / compiled brief | POST /phases/:id/brief with {} | Full returned brief body; members are intentionally id/title/status, not expanded task briefs. Requires task disclosure access in addition to phase access. |
| Phase / record | GET /phases/:id | Complete returned phase record envelope, without expanding member tasks. |
| Project / awareness brief | POST /projects/:id/brief with {} | Bounded purpose, Charter constraints, available resource descriptions and typed locators, visible phase progress and task counts/summaries, relevant report snippets and drill-down references. CLI project brief and MCP brief_compile projectId use this same route. |
| Project / available resources | GET /projects/:id/context | Active available resource projection, project fields and omission counters, including the outer API envelope. MCP project_context_get adds a labelled fence; CLI project context --json returns the same envelope; ordinary CLI output formats its fields. |
| Project / record | GET /projects/:id | Complete returned project record envelope. No project-wide task expansion. |
| Skill / record | GET /skills/:id | Canonical metadata envelope. MCP's existing no-version skill_get returns a summary even when detailed was requested, so this view is explicitly API JSON. |
| Skill / published full content | GET /skills/:id, then GET /skills/:id/versions/:publishedId/content | Resolve the current published immutable version, then fetch its full version envelope through skills:use authorization. No draft fallback. HTTP ETag is shown separately and excluded from the copied API body. MCP version/fullContent detailed adds etag to its JSON; concise wraps/budgets the content. |
| Report / record | GET /reports/:id | Complete returned record envelope including content and structured handover. Existing visibility and promotion filtering applies. MCP report_get detailed serializes this envelope; concise formats its header and budgets the content. |

The JSON serializer is the same standard two-space JSON.stringify formatting used by backend/src/mcp/shape.ts json(). The frontend does not construct a second context document. Brief previews select the server's brief string without trimming or rewriting. JSON previews preserve all API fields and existing string fences.

Canonical implementation locations: backend/src/routes/tasks.ts handleCompiledBrief; routes/phases.ts; routes/projects.ts and services/ProjectResourceService.ts; routes/skills.ts and services/SkillManager.ts; routes/reports.ts and services/ReportManager.ts; backend/src/mcp/registry.ts; cli/relayhall.

### Project awareness and legacy task-bound briefs

The default project brief now works without a task ID: POST /projects/:id/brief with {} returns the shared project-awareness-v1 brief. It requires projects:read and tasks:read. Phase and report sections additionally require their own read scopes and otherwise explicitly say they were not queried. Object-level SQL authorization is applied before task/phase counts and candidate limits. Report promotion visibility remains enforced by the existing shared ReportVisibility helper.

Available resources are read through a bounded projection that retains descriptions, stable IDs and the same typed detail allowlist as resource context. Hidden and archived resources are excluded in SQL; their names, URLs and descriptions never enter the projection. Selection takes the first available resource of each kind before additional rows, in repository/environment/workspace/reference order. Within repositories, the primary repository comes first; remaining ties use normalized name and ID. This keeps a primary repository and an environment visible even when many references exist. Actual locators remain intact with exact resource GET references. The older resources-only API remains unchanged.

Default limits are six unfinished task summaries, six phases, six available resources and five report snippets. Reports are selected from thirty authorized pinned/recent candidates, followed by promotion checks; this is explicitly a bounded window, not an exhaustive report count. Task/phase totals count only visible non-archived records. Task summaries prioritize stuck work, recorded blocking reasons, running work and review work; timestamp and ID ties are deterministic. Phase order uses position, creation time and ID. Report snippets use summary or the first 180 characters of content; full bodies are never read for this index.

Purpose, goal and Charter excerpts have field bounds. The entire brief is limited to 24,000 UTF-16 characters (approximately 6,000 tokens at most using this heuristic); lower-priority entries are omitted if necessary, with omission indicators inside the copied brief. Output metadata estimates Unicode scalars divided by four, matching the graphical estimate. Follow the canonical references to retrieve full details. All free text remains inside a structurally safe untrusted-data fence; no LLM or frontend-generated summary is involved.

Supplying {taskId} still selects the existing task-bound project brief, including its before/after binding and authorization checks. Invalid bodies and unknown options fail; no arbitrary task is selected for standalone awareness.

CLI: relayhall project brief PROJECT [--json]. Default prints the exact returned brief followed by the normal terminal newline; --json preserves the complete API envelope. MCP projectId now reaches this valid standalone path: detailed serializes its envelope, concise retains the existing untrusted wrapper and text-budget continuation behavior.

### Completeness and version boundaries

These selected point reads return their complete API payload; the preview does not use MCP concise pages or silently slice a long string. Complete response does not mean every related object: server-selected fields, summaries, inaccessible IDs and omission counts remain unchanged. Task brief options default to the existing non-inline-report behavior. Phase briefs list task identities; request a task's brief for its working context.

Published skill content is independent of any draft or historical version displayed by the skill editor. Its returned version identity and HTTP ETag can be inspected. A skill without a published version produces a clear failure for the full-content choice, while the record remains available.

Normal refresh, operation changes and element changes invalidate old copyable text immediately. Aborted or late responses cannot overwrite a new selection. Permission-denied refreshes clear the previous payload. API reads use no-store and do not issue conditional requests. A currently displayed snapshot is not a live revocation feed; close or refresh to discard/revalidate it, as with other board detail reads.

## Estimate and accessibility

The estimate is ceil(Unicode scalar count / 4) over exactly the displayed/copied string, including whitespace and textual fences. It is approximate; it is not the server's potentially differently counted estimate, an exact model tokenizer or the total harness prompt cost. Conversation, tool schemas, harness instructions and transport wrappers are excluded. Counting streams characters without allocating a second character array and memoizes per payload.

The preview is a labelled inline region with native labelled format selector, announced loading/errors/copy status, a keyboard-focusable wrapped text area, theme variables and narrow-layout controls. It renders data as React text, never HTML or Markdown. Empty briefs remain valid zero-token strings. Clipboard denial leaves selectable text and a visible instruction.

## Other board elements

Project resources are covered by the canonical project context choice. Subtasks are fields of Task reads/briefs, not independently expanded documents. Reports attached to tasks retain server disclosure rules; open their Report detail to request their full visible record. Skill versions are covered by the published-content operation; explicit historical-version selection remains on the existing skill editor/API.

Personalities, tools/services, Charters, Blueprints, sessions and access-management objects have different administrative or operational reads. This change does not invent brief semantics for them or expose credentials. Their existing detail surfaces remain unchanged; additional preview adapters should be separately specified against their actual read contracts.

## Verification

Focused tests cover exact copy bytes, Unicode/whitespace estimates, empty and long content, HTML-as-text, immutable skill version/ETag, no published version, format changes, stale responses, denied refresh, clipboard failure, lazy disclosure and Escape focus restoration. Existing page and full frontend checks are run for the candidate. Release evidence and environment acceptance are recorded in the implementation task, rather than asserting deployment from this document.
