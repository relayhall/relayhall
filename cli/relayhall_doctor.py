#!/usr/bin/env python3
"""RelayHall board integrity doctor.

Pure check registry used by the canonical RelayHall CLI. Keep checks side-effect
free so seeded fixtures can exercise every issue class without a live API.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Callable

ACTIVE_TASK_STATUSES = {"ideas", "todo", "in-progress", "stuck", "review"}
TODO_STATUS = "todo"

Issue = dict[str, Any]
CheckFn = Callable[[dict[str, Any]], list[Issue]]


def _norm(value: Any) -> str:
    return str(value or "").strip().lower()


def _task_label(task: dict[str, Any]) -> str:
    title = task.get("title") or "Untitled task"
    task_id = str(task.get("id") or "unknown")
    return f"{title} ({task_id[:8]})"


def _issue(check: str, severity: str, entity_type: str, entity_id: Any, message: str, **extra: Any) -> Issue:
    payload: Issue = {
        "check": check,
        "severity": severity,
        "entityType": entity_type,
        "entityId": str(entity_id or ""),
        "message": message,
    }
    if extra:
        payload.update(extra)
    return payload


def _active_tasks(ctx: dict[str, Any]) -> list[dict[str, Any]]:
    return [t for t in ctx["tasks"] if t.get("status") in ACTIVE_TASK_STATUSES]


def check_dangling_depends_on(ctx: dict[str, Any]) -> list[Issue]:
    task_by_id = ctx["task_by_id"]
    issues: list[Issue] = []
    for task in _active_tasks(ctx):
        for dep_id in task.get("dependsOn") or []:
            if dep_id not in task_by_id:
                issues.append(_issue(
                    "dangling-depends-on",
                    "error",
                    "task",
                    task.get("id"),
                    f"{_task_label(task)} depends on missing task {dep_id}",
                    dependencyId=dep_id,
                ))
    return issues


def check_archived_depends_on(ctx: dict[str, Any]) -> list[Issue]:
    # Dependency semantics (backend TaskManagerDB dependencySatisfied()):
    # an archived-completed prerequisite is SATISFIED, so it is not an issue.
    # Archived-abandoned (or legacy NULL-disposition) deps never block the
    # dependent either, but the prerequisite work never actually happened —
    # flag those for human review.
    task_by_id = ctx["task_by_id"]
    issues: list[Issue] = []
    for task in _active_tasks(ctx):
        for dep_id in task.get("dependsOn") or []:
            dep = task_by_id.get(dep_id)
            if dep and dep.get("status") == "archived" and dep.get("archiveDisposition") != "completed":
                disposition = dep.get("archiveDisposition") or "unknown"
                issues.append(_issue(
                    "archived-depends-on",
                    "warning",
                    "task",
                    task.get("id"),
                    f"{_task_label(task)} depends on archived task {_task_label(dep)} "
                    f"whose work was never completed (disposition: {disposition}); "
                    "it does not block, but the prerequisite is unmet",
                    dependencyId=dep_id,
                    archiveDisposition=dep.get("archiveDisposition"),
                ))
    return issues


def check_stale_blocked_flags(ctx: dict[str, Any]) -> list[Issue]:
    issues: list[Issue] = []
    for task in _active_tasks(ctx):
        blocked_by = task.get("blockedBy") or []
        blocked_reason = str(task.get("blockedReason") or "").strip()
        unmet_deps = [dep for dep in task.get("dependsOn") or [] if ctx["task_by_id"].get(dep, {}).get("status") not in ("completed", "archived")]
        if (blocked_by or blocked_reason) and not unmet_deps and not blocked_by:
            issues.append(_issue(
                "stale-blocked-flags",
                "warning",
                "task",
                task.get("id"),
                f"{_task_label(task)} has blocked metadata but no active blocker/dependency",
                blockedReason=blocked_reason,
            ))
    return issues


def check_duplicate_project_names(ctx: dict[str, Any]) -> list[Issue]:
    active_projects = [p for p in ctx["projects"] if p.get("status") != "archived"]
    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for project in active_projects:
        by_name[_norm(project.get("name"))].append(project)
    issues: list[Issue] = []
    for name, projects in by_name.items():
        if name and len(projects) > 1:
            ids = [str(p.get("id")) for p in projects]
            issues.append(_issue(
                "duplicate-project-names",
                "error",
                "project",
                ids[0],
                f"Duplicate active project name '{projects[0].get('name')}' across {len(projects)} projects",
                projectIds=ids,
            ))
    return issues


def check_duplicate_personality_names(ctx: dict[str, Any]) -> list[Issue]:
    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for personality in ctx["personalities"]:
        by_name[_norm(personality.get("name"))].append(personality)
    issues: list[Issue] = []
    for name, personalities in by_name.items():
        if name and len(personalities) > 1:
            issues.append(_issue(
                "duplicate-personality-names",
                "error",
                "personality",
                personalities[0].get("id"),
                f"Duplicate personality name '{personalities[0].get('name')}' across {len(personalities)} personalities",
                personalityIds=[str(p.get("id")) for p in personalities],
            ))
    return issues


def check_duplicate_personality_slugs(ctx: dict[str, Any]) -> list[Issue]:
    by_slug: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for personality in ctx["personalities"]:
        by_slug[_norm(personality.get("slug"))].append(personality)
    issues: list[Issue] = []
    for slug, personalities in by_slug.items():
        if slug and len(personalities) > 1:
            issues.append(_issue(
                "duplicate-personality-slugs",
                "error",
                "personality",
                personalities[0].get("id"),
                f"Duplicate personality slug '{personalities[0].get('slug')}' across {len(personalities)} personalities",
                personalityIds=[str(p.get("id")) for p in personalities],
            ))
    return issues


def _has_dod(task: dict[str, Any]) -> bool:
    for key in ("definitionOfDone", "successCriteria"):
        value = task.get(key)
        if isinstance(value, list) and any(str(item).strip() for item in value):
            return True
        if isinstance(value, str) and value.strip():
            return True
    return False


def check_missing_dod(ctx: dict[str, Any]) -> list[Issue]:
    return [
        _issue("missing-dod", "warning", "task", task.get("id"), f"{_task_label(task)} is missing Definition of Done/success criteria")
        for task in _active_tasks(ctx)
        if task.get("status") != "ideas" and not _has_dod(task)
    ]


def check_autostart_outside_todo(ctx: dict[str, Any]) -> list[Issue]:
    return [
        _issue("autostart-outside-todo", "warning", "task", task.get("id"), f"{_task_label(task)} has autoStart=true while status is {task.get('status')}")
        for task in _active_tasks(ctx)
        if task.get("autoStart") is True and task.get("status") != TODO_STATUS
    ]


def check_task_without_project(ctx: dict[str, Any]) -> list[Issue]:
    project_names = {_norm(p.get("name")) for p in ctx["projects"]}
    project_ids = {_norm(p.get("id")) for p in ctx["projects"]}
    issues: list[Issue] = []
    for task in _active_tasks(ctx):
        project = task.get("project")
        if not project:
            issues.append(_issue("task-without-project", "warning", "task", task.get("id"), f"{_task_label(task)} has no project"))
        elif _norm(project) not in project_names and _norm(project) not in project_ids:
            issues.append(_issue("task-without-project", "warning", "task", task.get("id"), f"{_task_label(task)} references unknown project '{project}'"))
    return issues


# Provider prefixes stripped when comparing model ids for equivalence. Kept in
# sync with backend/src/services/modelCatalog.ts normalizeModelId(). Canonical
# canonical models gpt-5.5, openai-codex/gpt-5.5 and codex/gpt-5.5 must all
# normalize to the same value so a valid pin never reads as "unavailable".
_STRIPPABLE_MODEL_PREFIXES = (
    "litellm/",
    "anthropic/",
    "openai-codex/",
    "openai/",
    "codex-cli/",
    "codex/",
    "google/",
    "gemini/",
    "hermes/",
)


def _normalize_model_id(model: Any) -> str:
    """Strip a single known leading provider prefix (longest match first) and
    lowercase, mirroring the backend resolver. Only the leading provider segment
    is removed so nested LiteLLM routes (litellm/gemini/...) stay distinct."""
    value = str(model or "").strip().lower()
    if not value:
        return ""
    for prefix in sorted(_STRIPPABLE_MODEL_PREFIXES, key=len, reverse=True):
        if value.startswith(prefix):
            return value[len(prefix):]
    return value


def _available_model_ids(model_status: dict[str, Any] | None) -> set[str]:
    """Return normalized model ids from the flat `/models/available` payload.

    The list is backed by the live catalog resolver (LiteLLM `/v1/models` plus
    a static degraded-startup floor), and
    every id is normalized so provider-prefixed pins match their bare form.
    """
    if not model_status:
        return set()
    raw: set[str] = set()
    models = model_status.get("models") or []
    if isinstance(models, list):
        raw.update(str(m.get("id")) for m in models if isinstance(m, dict) and m.get("id"))
    ids = model_status.get("ids") or []
    if isinstance(ids, list):
        raw.update(str(item) for item in ids if item)
    return {n for n in (_normalize_model_id(v) for v in raw) if n}


def check_unavailable_model_pin(ctx: dict[str, Any]) -> list[Issue]:
    available = ctx["available_models"]
    if not available:
        return []
    issues: list[Issue] = []
    for task in _active_tasks(ctx):
        model = task.get("model")
        if model and _normalize_model_id(model) not in available:
            issues.append(_issue(
                "unavailable-model-pin",
                "warning",
                "task",
                task.get("id"),
                f"{_task_label(task)} pins unavailable model '{model}'",
                model=model,
            ))
    return issues


CHECK_REGISTRY: list[dict[str, Any]] = [
    {"id": "dangling-depends-on", "description": "Task dependsOn points at a missing task (does not block; needs cleanup)", "run": check_dangling_depends_on},
    {"id": "archived-depends-on", "description": "Active task dependsOn points at an archived task whose work was not completed (archiveDisposition != 'completed'; does not block, prerequisite unmet)", "run": check_archived_depends_on},
    {"id": "stale-blocked-flags", "description": "Blocked metadata remains after blockers are gone", "run": check_stale_blocked_flags},
    {"id": "duplicate-project-names", "description": "Active projects share a normalized name", "run": check_duplicate_project_names},
    {"id": "duplicate-personality-names", "description": "Personalities share a normalized name", "run": check_duplicate_personality_names},
    {"id": "duplicate-personality-slugs", "description": "Personalities share a normalized slug", "run": check_duplicate_personality_slugs},
    {"id": "missing-dod", "description": "Active task lacks Definition of Done/successCriteria", "run": check_missing_dod},
    {"id": "autostart-outside-todo", "description": "autoStart is set outside todo", "run": check_autostart_outside_todo},
    {"id": "task-without-project", "description": "Active task has no valid project", "run": check_task_without_project},
    {"id": "unavailable-model-pin", "description": "Task model pin is not in /models/available", "run": check_unavailable_model_pin},
]


def run_doctor(tasks: list[dict[str, Any]], projects: list[dict[str, Any]], personalities: list[dict[str, Any]], model_status: dict[str, Any] | None = None) -> dict[str, Any]:
    ctx = {
        "tasks": tasks,
        "projects": projects,
        "personalities": personalities,
        "model_status": model_status or {},
        "task_by_id": {str(t.get("id")): t for t in tasks if t.get("id")},
        "available_models": _available_model_ids(model_status),
    }
    issues: list[Issue] = []
    for check in CHECK_REGISTRY:
        issues.extend(check["run"](ctx))
    severity_counts = Counter(issue["severity"] for issue in issues)
    return {
        "ok": not issues,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "checkCount": len(CHECK_REGISTRY),
            "issueCount": len(issues),
            "severityCounts": dict(severity_counts),
        },
        "checks": [{"id": c["id"], "description": c["description"]} for c in CHECK_REGISTRY],
        "issues": issues,
    }


def render_human(result: dict[str, Any]) -> str:
    count = result["summary"]["issueCount"]
    lines = [f"RelayHall doctor: {'OK' if count == 0 else str(count) + ' issue' + ('' if count == 1 else 's')} across {result['summary']['checkCount']} checks"]
    if not result["issues"]:
        lines.append("No board integrity issues found.")
        return "\n".join(lines)
    by_check: dict[str, list[Issue]] = defaultdict(list)
    for issue in result["issues"]:
        by_check[issue["check"]].append(issue)
    for check_id in sorted(by_check):
        lines.append(f"\n{check_id} ({len(by_check[check_id])})")
        for issue in by_check[check_id]:
            lines.append(f"  [{issue['severity']}] {issue['message']}")
    return "\n".join(lines)


def render_discord_summary(result: dict[str, Any], max_issues: int = 12) -> str:
    count = result["summary"]["issueCount"]
    noun = "issue" if count == 1 else "issues"
    lines = [f"🩺 RelayHall doctor: {'OK' if count == 0 else f'{count} {noun}'} across {result['summary']['checkCount']} checks"]
    if result["issues"]:
        for issue in result["issues"][:max_issues]:
            lines.append(f"• `{issue['check']}` [{issue['severity']}] {issue['message']}")
        remaining = len(result["issues"]) - max_issues
        if remaining > 0:
            lines.append(f"…and {remaining} more. Run `relayhall doctor --json` for details.")
    return "\n".join(lines)
