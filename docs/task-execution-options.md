# Task execution options

The execution-related fields a task carries, and where each is set. The
connector-first execution profile is documented in
[execution-profiles.md](execution-profiles.md); this page is the field map.

| Field | Meaning | GUI | CLI | MCP |
|---|---|---|---|---|
| `model` | Basic model choice from the read-only catalogue (`GET /models/available`) | AI Execution → Model | `--model` | — |
| `thinking` | Basic reasoning depth `low·medium·high` | AI Execution → Thinking | `--thinking` | — |
| `executionProfile.serviceId` | The target Connector (published Service, `kind=connector`) | AI Execution → Service | `--service` | `executionProfile.serviceId` |
| `executionProfile.descriptorVersion` | The pinned immutable descriptor version | pinned automatically | `--descriptor-version` | `executionProfile.descriptorVersion` |
| `executionProfile.options` | Descriptor-declared option values | rendered per declared type | `--option key=value` (exact string) or `key:=json` (typed) | `executionProfile.options` |
| `executionProfile.parameters` | One level of per-option parameters | rendered under the option | `--parameter optionKey.paramKey=value` or `:=json` | `executionProfile.parameters` |
| `personalityId` | Personality bound to the task | AI Execution → Personality | `--personality` | `personality` |

Clearing: send `executionProfile: null` (REST/MCP) or `--clear-profile`
(CLI update) to return a task to the basic shape.

Legacy fields (`executionMode` and the pre-connector profile shape) are
refused on writes with `FIELD_RETIRED`; stored legacy values surface
read-only as `legacyExecutionProfile`. See
[execution-profiles.md](execution-profiles.md) for the compatibility rule.
