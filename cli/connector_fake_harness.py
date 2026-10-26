"""A stand-in harness for the connector ring's end-to-end tests (E462 slice S5).

It answers exactly as the real harnesses were recorded to (Claude Code 2.1.197
`-p --output-format stream-json --verbose --strict-mcp-config --mcp-config F`;
codex-cli 0.164.0 `exec --json --ignore-user-config -c mcp_servers.relayhall=...`,
its session-start log line on stderr under RUST_LOG=codex_otel.log_only=info,
and `exec --help`), and does what a real run does first: it starts the per-run
MCP server named in ITS configuration (the real `relayhall connector mcp --run`
process), initializes it and calls `relayhall_principal_whoami` through it,
against the test's stub board. It refuses a configuration that is not
isolated, exactly as the ring's isolation rule requires.

The test reads what happened from a JSON file the stand-in writes into the
directory named by FAKE_HARNESS_REPORT (argv, env, the whoami answer); a real
harness writes nothing like it. FAKE_HARNESS_EXIT sets the exit code and
FAKE_HARNESS_HANG=1 makes it hang until it is killed.
"""
import json
import os
import subprocess
import sys
import time

try:
    import tomllib
except ImportError:  # Python 3.10: the codex form is then unsupported here
    tomllib = None


def codex_session_line(servers):
    """Codex's session-start log line, as codex-cli 0.164.0 writes it to stderr when RUST_LOG enables the
    `codex_otel.log_only` target at info (recorded from a real run; identifiers and the model replaced). It names
    every MCP server the session started, comma-separated, in `mcp_servers`."""
    return ("2026-10-25T01:48:58.266718Z  INFO codex_otel.log_only: event.name=\"codex.conversation_starts\" "
            "provider_name=openai auth.env_openai_api_key_present=false auth.env_codex_api_key_present=false "
            "auth.env_codex_api_key_enabled=true auth.env_refresh_token_url_override_present=false "
            "reasoning_summary=auto approval_policy=never sandbox_policy=workspace-write "
            f"mcp_servers=\"{', '.join(servers)}\" event.timestamp=2026-10-25T01:48:58.266Z "
            "conversation.id=01a170bf-0000-7000-8000-00000000c0de app.version=0.164.0 originator=codex_exec "
            "terminal.type=xterm-256color model=gpt-model slug=gpt-model")


CODEX_STARTUP_TAIL = (
    "2026-10-25T01:48:58.277660Z  INFO codex_otel.log_only: event.name=\"codex.startup_phase\" "
    "startup.phase=\"thread_start_total\" startup.status=\"ready\" duration_ms=17 "
    "event.timestamp=2026-10-25T01:48:58.277Z conversation.id=01a170bf-0000-7000-8000-00000000c0de "
    "app.version=0.164.0 originator=codex_exec terminal.type=xterm-256color model=gpt-model slug=gpt-model")


def proxy_round_trip(command, args):
    process = subprocess.Popen([command, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE)

    def send(message):
        process.stdin.write((json.dumps(message) + "\n").encode())
        process.stdin.flush()

    def read(message_id):
        while True:
            line = process.stdout.readline()
            if not line:
                return None
            reply = json.loads(line)
            if reply.get("id") == message_id:
                return reply

    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fake-harness", "version": "1"}}})
    initialized = read(1)
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    send({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
          "params": {"name": "relayhall_principal_whoami", "arguments": {}}})
    answer = read(2)
    process.stdin.close()
    process.wait(timeout=30)
    stderr = process.stderr.read().decode("utf-8", errors="replace")
    return {"initialized": initialized is not None and "result" in initialized, "whoami": answer,
            "proxyExit": process.returncode, "proxyStderr": stderr}


def main(argv):
    report = {"argv": argv, "env": dict(os.environ)}
    if len(argv) >= 2 and argv[0] == "exec" and argv[1] == "--help":
        if os.environ.get("FAKE_CODEX_NO_ISOLATION") != "1":
            print("      --ignore-user-config\n          Do not load `$CODEX_HOME/config.toml`; auth still uses "
                  "`CODEX_HOME`")
        print("      --json\n          Print events to stdout as JSONL")
        return 0
    if "-p" in argv:
        if "--strict-mcp-config" not in argv:
            print(json.dumps({"type": "result", "subtype": "error", "is_error": True, "result": "not isolated"}))
            return 2
        config = json.loads(open(argv[argv.index("--mcp-config") + 1], encoding="utf-8").read())
        servers = config["mcpServers"]
        entry = servers["relayhall"]
        report["servers"] = sorted(servers)
        report["proxy"] = proxy_round_trip(entry["command"], entry["args"])
        lines = [
            {"type": "system", "subtype": "init", "cwd": os.getcwd(), "session_id": "1e22b7a1-0000-4000-8000-0000000000e2",
             "tools": ["Bash", "Edit", "Read"], "mcp_servers": [{"name": n, "status": "connected"} for n in sorted(servers)],
             "model": "claude-model", "permissionMode": argv[argv.index("--permission-mode") + 1]},
            {"type": "result", "subtype": "success", "is_error": False, "duration_ms": 12, "num_turns": 1,
             "result": "done", "session_id": "1e22b7a1-0000-4000-8000-0000000000e2"}]
    elif argv and argv[0] == "exec":
        if "--ignore-user-config" not in argv or tomllib is None:
            print(json.dumps({"type": "turn.failed", "error": {"message": "not isolated"}}))
            return 2
        value = argv[argv.index("-c") + 1]
        key, _, toml_value = value.partition("=")
        entry = tomllib.loads("x = " + toml_value)["x"]
        report["servers"] = [key.split(".")[1]]
        if "codex_otel.log_only=info" in os.environ.get("RUST_LOG", ""):
            sys.stderr.write("Reading additional input from stdin...\n" + codex_session_line(report["servers"])
                             + "\n" + CODEX_STARTUP_TAIL + "\n")
            sys.stderr.flush()
        report["proxy"] = proxy_round_trip(entry["command"], entry["args"])
        lines = [{"type": "thread.started", "thread_id": "01a16fc0-0000-4000-8000-0000000000e2"},
                 {"type": "turn.started"},
                 {"type": "item.completed", "item": {"id": "item_0", "type": "agent_message", "text": "done"}},
                 {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}}]
    else:
        return 64
    folder = os.environ.get("FAKE_HARNESS_REPORT")
    if folder:
        with open(os.path.join(folder, f"harness-{os.getpid()}.json"), "w", encoding="utf-8") as handle:
            json.dump(report, handle)
    for line in lines:
        print(json.dumps(line), flush=True)
    if os.environ.get("FAKE_HARNESS_HANG") == "1":
        time.sleep(3600)
    return int(os.environ.get("FAKE_HARNESS_EXIT", "0"))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
