#!/usr/bin/env python3
"""Focused tests for the LiteLLM administration CLI commands."""

import contextlib
import importlib.machinery
import importlib.util
import io
import pathlib
import types
import unittest


def load_cli():
    path = pathlib.Path(__file__).with_name("relayhall")
    loader = importlib.machinery.SourceFileLoader("relayhall_cli_litellm_test", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class LiteLLMAdminCommandTests(unittest.TestCase):
    def setUp(self):
        self.cli = load_cli()
        self.calls = []

    def test_models_list_uses_safe_backend_route(self):
        def fake_api(method, path, data=None):
            self.calls.append((method, path, data))
            return {
                "models": [{"model_name": "primary", "litellm_params": {"model": "provider/model"}}],
                "catalog": [{"id": "primary"}],
                "consistency": "ok",
            }

        self.cli.api = fake_api
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.cli.cmd_models_list(types.SimpleNamespace())
        self.assertEqual(self.calls, [("GET", "/litellm/models", None)])
        self.assertIn("primary -> provider/model", output.getvalue())

    def test_keys_generate_sends_scope_models_and_budget(self):
        def fake_api(method, path, data=None):
            self.calls.append((method, path, data))
            return {"key": {"key": "sk-generated-once", "keyAlias": "agent-key", "tokenId": "token-1", "maxBudget": 12.5}}

        self.cli.api = fake_api
        args = types.SimpleNamespace(
            name="agent-key", agent_id="agent-1", project_id=None,
            models="model-a, model-b", max_budget=12.5,
            budget_duration="30d", duration=None,
        )
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.cli.cmd_keys_generate(args)
        self.assertEqual(self.calls, [("POST", "/litellm/keys", {
            "name": "agent-key", "models": ["model-a", "model-b"],
            "maxBudget": 12.5, "agentId": "agent-1", "budgetDuration": "30d",
        })])
        self.assertIn("sk-generated-once", output.getvalue())

    def test_keys_generate_rejects_empty_models_before_api(self):
        self.cli.api = lambda *args, **kwargs: self.fail("API must not be called")
        args = types.SimpleNamespace(
            name="agent-key", agent_id="agent-1", project_id=None,
            models=" , ", max_budget=1.0, budget_duration=None, duration=None,
        )
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stderr(io.StringIO()):
            self.cli.cmd_keys_generate(args)
        self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
