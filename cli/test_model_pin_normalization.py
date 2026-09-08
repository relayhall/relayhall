"""Doctor model-pin normalization tests.

Covers the fix for the ~640 false "task pins unavailable model" warnings: a task
pin is only "unavailable" when NO normalized catalog entry matches. Canonical
canonical gpt-5.5 / openai-codex/gpt-5.5 / codex/gpt-5.5 must all pass.
"""

from relayhall_doctor import (
    run_doctor,
    check_unavailable_model_pin,
    _available_model_ids,
    _normalize_model_id,
)


def _task(task_id, model, status="in-progress"):
    return {
        "id": task_id,
        "title": f"task {task_id}",
        "status": status,
        "project": "P",
        "model": model,
    }


def _ctx(tasks, available_ids):
    model_status = {"models": [{"id": i} for i in available_ids]}
    return {
        "tasks": tasks,
        "available_models": _available_model_ids(model_status),
    }


def test_normalize_equivalence():
    forms = ["gpt-5.5", "openai-codex/gpt-5.5", "codex/gpt-5.5"]
    assert len({_normalize_model_id(f) for f in forms}) == 1
    assert _normalize_model_id("anthropic/Claude-Opus-4-8") == "claude-opus-4-8"
    # nested litellm route keeps its inner path
    assert (
        _normalize_model_id("litellm/gemini/gemini-3-flash-preview")
        == "gemini/gemini-3-flash-preview"
    )


def test_valid_gpt55_pins_do_not_warn_regardless_of_provider_prefix():
    # Catalog advertises only the codex-prefixed form; bare + other prefixes must
    # still be accepted via normalization.
    catalog = ["codex/gpt-5.5", "litellm/gemini/gemini-3-flash-preview"]
    tasks = [
        _task("a", "gpt-5.5"),
        _task("b", "openai-codex/gpt-5.5"),
        _task("c", "codex/gpt-5.5"),
        _task("d", "litellm/gemini/gemini-3-flash-preview"),
    ]
    issues = check_unavailable_model_pin(_ctx(tasks, catalog))
    assert issues == []


def test_genuinely_unavailable_pin_still_warns():
    catalog = ["codex/gpt-5.5"]
    tasks = [_task("bad", "no/such-model"), _task("good", "gpt-5.5")]
    issues = check_unavailable_model_pin(_ctx(tasks, catalog))
    assert len(issues) == 1
    assert issues[0]["model"] == "no/such-model"


def test_available_ids_are_normalized_from_status_payload():
    model_status = {
        "models": [{"id": "openai-codex/gpt-5.5"}],
        "ids": [
            "codex/gpt-5.5",
            "litellm/gemini/gemini-3-flash-preview",
            "anthropic/claude-opus-4-8",
        ],
    }
    ids = _available_model_ids(model_status)
    assert "gpt-5.5" in ids
    assert "gemini/gemini-3-flash-preview" in ids
    assert "claude-opus-4-8" in ids


def test_end_to_end_run_doctor_no_model_warning_for_valid_pins():
    tasks = [_task("t1", "gpt-5.5"), _task("t2", "codex/gpt-5.5")]
    model_status = {"models": [{"id": "openai-codex/gpt-5.5"}]}
    result = run_doctor(tasks, [{"id": "P", "name": "P", "status": "active"}], [], model_status)
    model_issues = [i for i in result["issues"] if i["check"] == "unavailable-model-pin"]
    assert model_issues == []
