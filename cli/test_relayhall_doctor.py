import json

from relayhall_doctor import run_doctor, render_human, render_discord_summary


def make_task(task_id, title, status="todo", **overrides):
    task = {
        "id": task_id,
        "title": title,
        "status": status,
        "project": "Project A",
        "dependsOn": [],
        "blockedBy": [],
        "autoStart": False,
        "definitionOfDone": "Done when tested",
        "successCriteria": ["tested"],
        "model": "openai/gpt-5.5",
    }
    task.update(overrides)
    return task


def test_doctor_detects_all_required_issue_classes():
    tasks = [
        make_task("missing-dep", "dangling dep", dependsOn=["does-not-exist"]),
        make_task("archived-dep", "archived dep", dependsOn=["archived-blocker"]),
        make_task("archived-blocker", "old blocker", status="archived"),
        make_task("stale-blocked", "stale blocked", blockedBy=[], blockedReason="waiting", dependsOn=[]),
        make_task("missing-dod", "missing dod", definitionOfDone=[], successCriteria=[]),
        make_task("bad-autostart", "bad autostart", status="in-progress", autoStart=True),
        make_task("no-project", "orphan", project=None),
        make_task("bad-model", "bad model", model="no/such-model"),
    ]
    projects = [
        {"id": "p1", "name": "Project A", "status": "active"},
        {"id": "p2", "name": "project a", "status": "active"},
    ]
    personalities = [
        {"id": "a1", "name": "Builder", "slug": "builder"},
        {"id": "a2", "name": "builder", "slug": "builder-2"},
        {"id": "a3", "name": "Reviewer", "slug": "builder"},
    ]
    model_status = {"models": [{"id": "openai/gpt-5.5"}], "ids": ["openai/gpt-5.5"]}

    result = run_doctor(tasks, projects, personalities, model_status)
    check_ids = {issue["check"] for issue in result["issues"]}

    assert result["summary"]["issueCount"] >= 10
    assert {
        "dangling-depends-on",
        "archived-depends-on",
        "stale-blocked-flags",
        "duplicate-project-names",
        "duplicate-personality-names",
        "duplicate-personality-slugs",
        "missing-dod",
        "autostart-outside-todo",
        "task-without-project",
        "unavailable-model-pin",
    }.issubset(check_ids)


def test_doctor_renderers_are_stable_and_include_cron_ready_summary():
    result = run_doctor(
        [make_task("t1", "bad", project=None, definitionOfDone="")],
        [],
        [],
        {"models": [{"id": "openai/gpt-5.5"}], "ids": ["openai/gpt-5.5"]},
    )

    human = render_human(result)
    discord = render_discord_summary(result)
    payload = json.dumps(result)

    assert "RelayHall doctor" in human
    assert "task-without-project" in human
    assert "RelayHall doctor" in discord
    assert "1 issue" in discord
    assert '"issues"' in payload
