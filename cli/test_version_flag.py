"""`relayhall --version` names the version of the checkout the CLI ships in.

The CLI is one script inside the repository (`cli/relayhall`), so its version
is the repository's: the `version` field of `backend/package.json`, which the
release process keeps equal to the frontend's and to the release number. The
flag is answered locally, before any login or network call, and exits 0.
"""
import importlib.machinery
import importlib.util
import io
import json
import os
import subprocess
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

CLI_PATH = Path(__file__).parent / "relayhall"
PACKAGE = Path(__file__).resolve().parent.parent / "backend" / "package.json"


def load_cli():
    spec = importlib.util.spec_from_loader(
        "relayhall_cli_version",
        importlib.machinery.SourceFileLoader("relayhall_cli_version", str(CLI_PATH)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = load_cli()


def expected_version():
    return json.loads(PACKAGE.read_text(encoding="utf-8"))["version"]


def test_version_flag_prints_the_checkout_version_and_exits_zero():
    env = {k: v for k, v in os.environ.items() if not k.startswith("RELAYHALL_")}
    # An address nothing listens on: the flag must not need the board.
    env["RELAYHALL_API_URL"] = "http://127.0.0.1:9"
    run = subprocess.run([sys.executable, str(CLI_PATH), "--version"],
                         capture_output=True, text=True, env=env, timeout=60)
    assert run.returncode == 0, run.stderr
    assert run.stdout == f"relayhall {expected_version()}\n"
    assert "usage:" not in run.stderr


def test_version_flag_through_main():
    out, err = io.StringIO(), io.StringIO()
    old = sys.argv
    sys.argv = ["relayhall", "--version"]
    code = None
    try:
        with redirect_stdout(out), redirect_stderr(err):
            try:
                cli.main()
            except SystemExit as exc:
                code = exc.code
    finally:
        sys.argv = old
    assert code in (0, None)
    assert out.getvalue().strip() == f"relayhall {expected_version()}"


def test_version_outside_a_checkout_says_unknown(tmp_path):
    assert cli.cli_version(tmp_path / "relayhall") == "unknown"
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / "package.json").write_text("{not json", encoding="utf-8")
    nested = tmp_path / "cli"
    nested.mkdir()
    assert cli.cli_version(nested / "relayhall") == "unknown"


def test_version_reads_the_package_beside_the_script(tmp_path):
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / "package.json").write_text(json.dumps({"version": "9.8.7-beta.6"}), encoding="utf-8")
    (tmp_path / "cli").mkdir()
    assert cli.cli_version(tmp_path / "cli" / "relayhall") == "9.8.7-beta.6"
