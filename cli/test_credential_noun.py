"""The ratified Credential CLI noun (AZ-S3, review 87fec3e2 B3).

Vocabulary b94dd86e retires `key` as a command noun with NO compatibility
alias (§1/§7): `relayhall credential <verb>` is the only owner-facing form.
These prove the parser accepts `credential` and REJECTS `key`.
"""
import importlib.machinery
import importlib.util
import subprocess
import sys
from pathlib import Path

CLI_PATH = Path(__file__).parent / "relayhall"


def run_cli(*argv):
    return subprocess.run(
        [sys.executable, str(CLI_PATH), *argv],
        capture_output=True, text=True, timeout=30,
    )


def test_credential_noun_is_accepted():
    result = run_cli("credential", "--help")
    assert result.returncode == 0
    assert "issue" in result.stdout
    assert "rotate" in result.stdout


def test_retired_key_noun_is_rejected():
    result = run_cli("key", "--help")
    assert result.returncode != 0
    combined = result.stdout + result.stderr
    assert "invalid choice" in combined
