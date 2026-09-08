"""CLI brief verb: compile-only Brief retrieval.

`relayhall brief TASK_ID` POSTs to /tasks/{id}/brief (the task altitude of the
Brief family — generation only, no execution) and prints the compiled Brief
text to stdout. Loaded the same way the other CLI suites load the
extensionless `relayhall` script.

RH-P3.C4 integration (ii), owner decision D4: this file was `test_prompt_verb`
and the verb was `prompt`. Vocabulary b94dd86e section 7 retires that word
without an alias, so the verb, the route and the response key all moved
together — and the last test here is the control that says so.
"""
import importlib.machinery
import importlib.util
import io
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

import pytest

CLI_PATH = Path(__file__).parent / "relayhall"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_brief",
        importlib.machinery.SourceFileLoader("relayhall_cli_brief", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


class Args:
    def __init__(self, **kw):
        self.__dict__.update(kw)


@pytest.fixture
def api(monkeypatch):
    """Records calls and replays scripted responses."""
    calls = []
    responses = {}

    def fake_api(method, path, data=None, **kwargs):
        calls.append((method, path, data))
        for (m, p), value in sorted(responses.items(), key=lambda kv: -len(kv[0][1])):
            if m == method and (p == path or path.startswith(p)):
                return value
        return {}

    monkeypatch.setattr(cli, "api", fake_api)
    fake_api.calls = calls
    fake_api.responses = responses
    return fake_api


def run(fn, args):
    out, err = io.StringIO(), io.StringIO()
    code = None
    with redirect_stdout(out), redirect_stderr(err):
        try:
            fn(args)
        except SystemExit as exc:
            code = exc.code
    return out.getvalue(), err.getvalue(), code


# Full-length ID so resolve_task_id needs no lookup round-trip.
TASK_ID = "cccccccc-0000-4000-8000-000000000003"


def test_brief_posts_to_brief_endpoint_and_prints_text(api):
    api.responses[("POST", f"/tasks/{TASK_ID}/brief")] = {
        "success": True,
        "brief": "You are working on task cccccccc. Definition of done: ship it.",
        "model": "openai-codex/gpt-5.5",
        "thinking": "medium",
        "taskId": TASK_ID,
    }
    out, err, code = run(cli.cmd_brief, Args(id=TASK_ID))
    assert code is None
    assert ("POST", f"/tasks/{TASK_ID}/brief", None) in api.calls
    assert out.strip() == "You are working on task cccccccc. Definition of done: ship it."


def test_brief_failure_is_a_clean_error_not_a_traceback(api):
    api.responses[("POST", f"/tasks/{TASK_ID}/brief")] = {
        "success": False,
        "error": "Task not found",
    }
    out, err, code = run(cli.cmd_brief, Args(id=TASK_ID))
    assert code == 1
    assert "Task not found" in err
    assert out == ""


def test_the_retired_prompt_verb_is_gone_not_aliased():
    """D4 control: an alias is how a retired word survives every rename."""
    source = CLI_PATH.read_text(encoding="utf-8")
    assert not hasattr(cli, "cmd_prompt")
    assert 'sub.add_parser("prompt"' not in source
    assert '/tasks/{task_id}/prompt' not in source
    # Not vacuous: the canonical spelling is what the surviving verb posts to.
    assert hasattr(cli, "cmd_brief")
    assert 'sub.add_parser("brief"' in source
    assert '/tasks/{task_id}/brief' in source
