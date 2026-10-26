# Structured Report handover v1

Reports may carry an optional `handover` object alongside their Markdown content. It is a small machine-readable resumption aid, not a second report body. Migration `088_report_handover.sql` adds the nullable JSONB column after the current canonical 081–087 sequence.

```json
{
  "schema_version": 1,
  "decisions": ["Use the existing Report lifecycle."],
  "assumptions": ["The linked task remains in the same Project."],
  "alternatives_rejected": ["A free-form YAML footer: it is not reliably machine-readable."],
  "unresolved_questions": ["Who performs the independent acceptance review?"]
}
```

The four categories are arrays of non-blank, single-line strings. Missing categories normalize to empty arrays. `schema_version` may be omitted on input and normalizes to `1`. Unknown keys, another version, multiline items, more than 50 entries in a category, items longer than 2,000 characters, and canonical payloads over 64 KiB are rejected. `null` means no structured handover and clears it on update.

The REST field and database column are named `handover`. CLI create/update accept inline JSON or a JSON file. MCP exposes typed Report create, get, and update tools using the same object. The dashboard renders and edits the four categories explicitly.

When compiling a task Brief, RelayHall includes structured handovers from non-deleted Reports that both link the task and belong to its Project. The compiler emits only Report identity, title, lifecycle status, and the normalized handover—never the free-form report body. It serializes these values as quoted JSON data and labels them as untrusted, non-authoritative context. A handover lookup failure fails Brief compilation closed; an absent handover is normal.

Archive does not erase handover context: an archived linked Report remains eligible because Reports are readable and linkable while archived. Soft-deleted Reports are excluded.

## Explicit delegated Task ceilings

The Task-bound Report save and exact-key reconciliation workflows require both the trusted request and freshly resolved post-lock authority to remain within every explicit delegated Task own-object and own-scope cap. A current claimant role does not bypass an empty, missing, excluded, foreign-Task or foreign-project cap. The four canonical selector forms retain their ordinary meanings. Agent authority remains bound to its exact Task.

Saving requires Task WRITE scope and object caps. Exact-key read reconciliation requires Task READ scope and object caps, and therefore permits genuinely read-only credentials and rules. These caps narrow an existing authorization decision; they do not confer access. Missing positive parent Task WRITE alone remains distinct from explicit delegated exclusion. Generic legacy Task role arms and Report grants are unchanged.

Presented credentials are re-read after the Task lock, including their current scope set and decision-time expiry; another live credential cannot replace the presented one. An ambiguous save retains its logical key through denied reconciliation. The original Report bytes and genuine reference-derived human evidence audience are unchanged.
