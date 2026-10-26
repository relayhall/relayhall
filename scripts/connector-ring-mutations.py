#!/usr/bin/env python3
"""Mutation drill for the connector's ring (owner ruling E462, slice S5; the
universal harness connector design, sections 6.1-6.7).

Each control edits ONE literal anchor in a DISPOSABLE COPY of `cli/` (plus the
one backend test file the ring suite reads), runs the ring, census and task
suites there with pytest, and requires them to go red at EXACTLY the
predeclared set of tests, each by a failed assertion (never a collection
error, an import error or a timeout). The controls withdraw, one at a time,
what the slice builds:

  - the receiver: the immediate acknowledgement, the receive-only rule until
    wake.status says enabled, the closed wake frame, the forward-only cursor;
  - the local policy: the working-folder rule, the hold, the run cap, one run
    per Task, the policy's own refusal of a `stuck` run;
  - the Agent per run: the scope cut and the :admin refusal, the pack's Task
    binding and :admin check, the empty-body Agent claim (N14), the Warrant-only
    verifier mint, no second Approval filing, the revocation and the run folder's
    removal (also after a crash);
  - isolation: --strict-mcp-config, --ignore-user-config and the Codex probe,
    the 0700 run folder and the 0600 credential file;
  - trust: the publisher check before the run and the recheck after it;
  - the local guard against verifying own work, and the Verifier check;
  - supervision: the tree kill, the timeout and exit-code names, the one-cycle
    run's in-process outer net and the task's lifted execution limit;
  - secrets: the harness environment strip and the Report's redaction;
  - the S5 review leftovers (owner ruling E462, before the S6 drill): a first
    start at the feed head (and the socket opened there), the waiting-work
    read, the pass budget, the rate gate, wakes before pulled work; the pack
    within the requested scopes; an outcome and the revoke whatever fails while
    reporting (a custody failure, any other) or before a run; the MCP servers
    a run started read back from the harness (Codex's session line on stderr,
    the stderr sink, the run's RUST_LOG, every Claude Code init), the
    UNISOLATED and UNVERIFIED verdicts, the withheld output and the person told;
    the daemon's mint body as the live N14 drill sends it;
  - the S5-leftovers review findings (before the S6 drill): the waiting-work
    read as one sweep carried across passes (its start, its wrap at the end,
    the row a pass out of share did not take, the page that failed), and a
    run's output withheld on its isolation verdict whatever its outcome code,
    with the person told the verdict either way.

The source tree is never edited: its bytes are fingerprinted before and after.

Usage (from the repository root):
  python3 scripts/connector-ring-mutations.py --output-dir /tmp/ring-drill [--jobs 4]
  python3 scripts/connector-ring-mutations.py --describe   # checks every anchor, runs nothing
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RING = 'cli/relayhall_connector_ring.py'
CONNECTOR = 'cli/relayhall_connector.py'
PROC = 'cli/relayhall_connector_proc.py'
SUITES = ['test_connector_ring.py', 'test_connector_secret_census.py', 'test_connector_task.py']
COPIED = ['cli', 'backend/src/__tests__/connectorRunClaimLive.test.ts']

R = 'test_connector_ring.py::'
C = 'test_connector_secret_census.py::'
T = 'test_connector_task.py::'
ACK = R + 'test_a_wake_is_acknowledged_before_anything_is_decided'
RECEIVE_ONLY = R + 'test_no_frame_is_sent_before_wake_status_enabled'
MALFORMED = R + 'test_a_malformed_wake_is_not_a_wake'
CURSOR = R + 'test_the_cursor_only_moves_forward'
IMPLEMENT = R + 'test_an_implement_wake_runs_claude_under_a_minted_agent'
CODEX = R + 'test_a_codex_run_uses_exec_json_and_ignores_the_user_config'
CODEX_REFUSED = R + 'test_a_codex_build_that_cannot_isolate_is_refused_before_any_mint'
PROBE = R + 'test_codex_isolation_probe_reads_the_documented_flag'
UNTRUSTED = R + 'test_an_untrusted_binary_never_runs'
CHANGED = R + 'test_a_binary_that_changes_during_the_run_is_named'
WORKDIR = R + 'test_a_task_outside_every_working_folder_is_refused_and_the_person_told'
HOLD = R + 'test_a_local_hold_starts_nothing_and_keeps_the_task_pending'
CAPACITY = R + 'test_at_most_n_runs_and_the_rest_wait_for_the_next_reconcile'
ALREADY = R + 'test_a_second_wake_for_a_task_being_run_is_answered_already_running'
APPROVAL = R + 'test_a_mint_that_needs_approval_notifies_once_and_runs_when_approved'
PACK_TASK = R + 'test_a_pack_that_is_not_bound_to_the_task_is_revoked_and_never_used'
PACK_ADMIN = R + 'test_a_pack_holding_an_admin_scope_is_refused_even_when_it_was_asked_for'
CLAIM_REFUSED = R + 'test_a_refused_agent_claim_revokes_the_agent_and_starts_nothing'
NONZERO = R + 'test_exit_codes_map_to_named_outcomes[spawn0-RUN_EXIT_NONZERO]'
TIMEOUT = R + 'test_exit_codes_map_to_named_outcomes[spawn1-RUN_TIMEOUT]'
START_FAILED = R + 'test_a_harness_that_cannot_start_is_refused_and_cleaned_up'
REVOKE_RETRY = R + 'test_a_failed_revocation_is_retried_on_reconcile'
CRASH = R + 'test_a_crashed_run_is_cleaned_up_on_the_next_start'
CATCH_UP = R + 'test_catch_up_finds_ready_work_without_a_socket_and_reports_by_telemetry'
ELSEWHERE = R + 'test_catch_up_ignores_ready_work_assigned_elsewhere'
NOTIFY_ONCE = R + 'test_catch_up_reads_verify_and_stuck_items'
VERIFY_RUN = R + 'test_a_verify_wake_runs_a_verifier_agent_under_a_warrant_and_claims_nothing'
GUARD = R + 'test_the_local_guard_never_verifies_own_work'
OWN_SERVICE = GUARD + '[task0-policy0-OWN_SUBTREE_IMPLEMENTED]'
OWN_OWNER = GUARD + '[task1-policy1-OWN_SUBTREE_IMPLEMENTED]'
UNKNOWN = GUARD + '[task2-policy2-OWN_SERVICE_UNKNOWN]'
NOT_VERIFIER = GUARD + '[task3-policy3-NOT_THE_VERIFIER]'
NOT_SERVICE = GUARD + '[task4-policy4-NOT_SERVICE_VERIFICATION]'
OWN_AGENT = R + 'test_an_agent_this_connector_minted_is_its_own_subtree'
NO_WARRANT = R + 'test_a_verify_without_a_warrant_notifies_and_never_files_an_approval'
STUCK_POLICY = R + 'test_policy_refuses_what_it_does_not_know[change3-kinds.stuck]'
SCOPES_CUT = R + 'test_run_scopes_never_ask_for_more_than_the_connector_holds'
SCOPES_ADMIN = R + 'test_run_scopes_refuse_an_admin_scope'
TREE = R + 'test_a_timeout_ends_the_whole_process_tree'
FOLDER_PRIVATE = R + 'test_the_per_run_proxy_refuses_a_folder_others_can_read'
CRED_FILE = R + 'test_the_run_credential_file_is_owner_only_and_removed'
ROUTES = R + 'test_the_board_client_calls_only_its_routes'
SECOND_DAEMON = R + 'test_a_second_daemon_for_the_same_connector_stands_down'
ONESHOT = R + 'test_a_one_cycle_run_still_ends_itself_after_fifteen_minutes'
TASK_LIMIT = R + 'test_the_task_no_longer_stops_the_daemon_after_fifteen_minutes'
CHECK_RING = R + 'test_check_reports_the_ring_policy_the_task_limit_and_wake'
TASK_XML = T + 'test_task_xml_is_per_user_least_privilege_and_restarts'
E2E_CLAUDE = R + 'test_end_to_end_the_run_reaches_the_board_only_as_its_agent[claude-code]'
E2E_CODEX = R + 'test_end_to_end_the_run_reaches_the_board_only_as_its_agent[codex]'
CENSUS_CLAUDE = C + 'test_the_ring_leaks_neither_credential_anywhere[claude-code]'
CENSUS_CODEX = C + 'test_the_ring_leaks_neither_credential_anywhere[codex]'
FINISHED_NOTE = R + 'test_a_finished_task_gets_a_stream_note_not_a_report'
HARNESS_ENV = R + 'test_the_harness_environment_carries_no_credential'
REPORTED_ONCE = R + 'test_work_re_read_every_pass_is_reported_once'
VERIFY_ONCE = R + 'test_a_verify_occurrence_is_run_once_from_the_pull'
LOOP = R + 'test_the_daemon_loop_receives_reconnects_with_back_off_and_stops'
COLLECTOR_BESIDE = R + 'test_the_collector_cycle_never_blocks_the_receiver'
MINT_BODY = R + 'test_the_implement_mint_body_is_the_live_n14_drills_daemon_body'
PACK_WIDE = R + 'test_a_pack_wider_than_the_request_is_revoked_and_never_used'
CUSTODY_REPORT = R + 'test_a_custody_failure_while_reporting_still_finishes_and_revokes'
REPORT_FAIL = R + 'test_any_failure_while_reporting_still_finishes_and_revokes'
UNEXPECTED = R + 'test_an_unexpected_failure_before_a_run_still_answers_the_wake'
CODEX_SERVERS = R + 'test_a_codex_run_records_the_mcp_servers_it_started'
CODEX_UNISOLATED = R + 'test_a_codex_run_that_started_another_mcp_server_is_unisolated'
UNVERIFIED = R + 'test_a_run_that_names_no_mcp_servers_is_unverified'
CLAUDE_ONE = R + 'test_a_claude_run_that_started_another_mcp_server_is_unisolated[one-init]'
CLAUDE_LATER = R + 'test_a_claude_run_that_started_another_mcp_server_is_unisolated[a-later-init]'
SESSION_LINE = R + 'test_the_codex_session_line_is_read_and_nothing_else_is'
STDERR_SINK = R + 'test_the_owned_child_hands_stderr_to_the_sink_and_never_blocks_on_it'
HEAD = R + 'test_a_first_start_begins_at_the_feed_head_and_replays_nothing'
HEAD_SOCKET = R + 'test_a_first_start_opens_the_wake_socket_at_the_feed_head'
WAITING = R + 'test_a_first_start_still_finds_work_already_waiting'
PACED = R + 'test_a_large_backlog_is_paced_and_bounded_per_pass'
WAKE_FIRST = R + 'test_a_wake_is_decided_before_pulled_work'
NO_STARVING = R + 'test_waiting_work_never_starves_the_replay'
STOP_REVOKE = R + 'test_a_runs_agent_is_revoked_even_while_the_ring_stops'
FOREIGN_ONCE = R + 'test_another_connectors_waiting_work_is_read_once'
BEHIND = R + 'test_an_armed_task_behind_many_newer_rows_is_reached_within_the_stated_passes'
RESUME = R + 'test_a_pass_out_of_share_resumes_at_the_row_it_did_not_take'
FAILED_PAGE = R + 'test_a_failed_page_is_read_again_by_the_next_pass'
CODEX_FAILED = R + 'test_a_failed_codex_run_that_names_no_mcp_servers_still_withholds_its_output'
CLAUDE_FAILED = R + 'test_a_failed_claude_run_that_names_no_mcp_servers_still_withholds_its_output'
CLAUDE_FAILED_EXIT = CLAUDE_FAILED + '[exit-3]'
CLAUDE_FAILED_TIMEOUT = CLAUDE_FAILED + '[timeout]'

# (name, file, anchor, replacement, the exact set of tests that must fail). Read from the drill's first
# run against this tree and then held: a control whose red set moves fails the drill.
CONTROLS = [
    ('the wake is not acknowledged', RING,
     'sock.send_text(json.dumps({"type": "wake.ack", "wakeId": frame["wakeId"]}))  # C8: the daemon has it',
     'None  # mutant: no acknowledgement',
     {ACK, LOOP}),
    ('a wake is acted on before wake.status says enabled', RING,
     'if not (self.wake_enabled and validate_wake(frame)):', 'if not validate_wake(frame):',
     {RECEIVE_ONLY}),
    ('a wake frame with extra fields is a wake', RING,
     'return (isinstance(frame, dict) and set(frame) == keys', 'return (isinstance(frame, dict) and set(frame) >= keys',
     {MALFORMED}),
    ('the cursor moves backwards', RING,
     'if isinstance(cursor, str) and cursor.isdigit() and int(cursor) > int(self.cursor):',
     'if isinstance(cursor, str) and cursor.isdigit():',
     {CURSOR}),
    ('the connector claims with the epoch (the design fallback)', RING,
     'status, answer = agent_board.call("POST", f"/tasks/{task_id}/claim", {})',
     'status, answer = board.call("POST", f"/tasks/{task_id}/claim", {"expectedAssignmentEpoch": "1"})',
     {'test_connector_ring.py::test_an_outcome_after_the_socket_closed_goes_by_telemetry', ALREADY, APPROVAL, CAPACITY, CATCH_UP, CENSUS_CLAUDE, CENSUS_CODEX, CHANGED, CLAIM_REFUSED, CODEX, E2E_CLAUDE, E2E_CODEX, FINISHED_NOTE, IMPLEMENT, LOOP, NONZERO, START_FAILED, TIMEOUT,
      CLAUDE_ONE, CLAUDE_LATER, CODEX_SERVERS, CODEX_UNISOLATED, CUSTODY_REPORT, WAITING, UNVERIFIED, REPORT_FAIL,
      STOP_REVOKE, BEHIND, CODEX_FAILED, CLAUDE_FAILED_EXIT, CLAUDE_FAILED_TIMEOUT}),
    ('Claude Code runs without --strict-mcp-config', RING,
     '"--strict-mcp-config", "--mcp-config", str(mcp_file),', '"--mcp-config", str(mcp_file),',
     {E2E_CLAUDE, IMPLEMENT}),
    ('Codex runs without --ignore-user-config', RING,
     'argv = [binary, "exec", "--json", "--ignore-user-config", "--skip-git-repo-check",',
     'argv = [binary, "exec", "--json", "--skip-git-repo-check",',
     {CODEX, E2E_CODEX}),
    ('a Codex build that cannot isolate still runs', RING,
     'if self.harness == "codex" and not self.isolation_probe(binary, env):', 'if False:',
     {CODEX_REFUSED}),
    ('the Codex probe trusts any help text', RING,
     'return code == 0 and b"--ignore-user-config" in data', 'return code == 0',
     {PROBE}),
    ('an untrusted binary runs', RING,
     '            self._record(what="trust.refused", code=refusal.code)\n'
     '            self._finish_decision(candidate, "UNTRUSTED_BINARY")\n            return\n',
     '            verified = {"runBinary": "/opt/fake/harness"}\n',
     {UNTRUSTED}),
    ('a binary changed during the run goes unnamed', RING,
     '                    result.code = "RUN_BINARY_CHANGED"', '                    pass',
     {CHANGED}),
    ('any working folder serves any Project', RING,
     'if rule["projects"] is None or (project and project in rule["projects"]):', 'if True:',
     {WORKDIR}),
    ('the local hold is ignored', RING,
     '        if self.policy["hold"]:\n            return "USAGE_HOLD"', '        if False:\n            return "USAGE_HOLD"',
     {HOLD, REPORTED_ONCE}),
    ('the run cap is ignored', RING,
     'if not self.runs_gate.acquire(blocking=False):\n            self._finish_decision(candidate, "AT_CAPACITY")',
     'if not self.runs_gate.acquire(blocking=False) and False:\n            self._finish_decision(candidate, "AT_CAPACITY")',
     {CAPACITY}),
    ('a Task being run is run again', RING,
     '            if key in self.running:\n                busy = True', '            if False:\n                busy = True',
     {ALREADY}),
    ('a pending Approval is filed again', RING,
     'approval_id = self.state.approvals.get(task_id)', 'approval_id = None',
     {APPROVAL}),
    ('a pack bound to another Task is used', RING,
     '              and pack.get("boundTaskId") == candidate.task_id\n', '',
     {PACK_TASK}),
    ('a pack holding an :admin scope is used', RING,
     '              and not any(s == "root" or str(s).endswith(":admin") for s in held))',
     '              )',
     {PACK_ADMIN}),
    ('the run asks for an :admin scope', RING,
     '        need(scope != "root" and not scope.endswith(":admin"), "AGENT_SCOPE_REFUSED")', '        pass',
     {SCOPES_ADMIN}),
    ('the run asks for scopes the connector lacks', RING,
     '    return [scope for scope in wanted if scope in held]', '    return list(wanted)',
     {SCOPES_CUT}),
    ('a verifier mint may become an Approval', RING,
     '        body["via"] = "warrant"', '        pass',
     {NO_WARRANT, VERIFY_RUN, MINT_BODY}),
    ('the run Agent is not revoked', RING,
     '        finally:\n            self._revoke(board, pack["credentialId"])',
     '        finally:\n            None',
     {CLAIM_REFUSED, E2E_CLAUDE, E2E_CODEX, IMPLEMENT, NONZERO, REVOKE_RETRY, START_FAILED, TIMEOUT,
      CODEX_UNISOLATED, CUSTODY_REPORT, REPORT_FAIL, STOP_REVOKE, CODEX_FAILED, CLAUDE_FAILED_EXIT,
      CLAUDE_FAILED_TIMEOUT}),
    ('the run folder is left behind', RING,
     'if folder is not None and not remove_run_folder(folder):', 'if folder is not None and False:',
     {CENSUS_CLAUDE, CENSUS_CODEX, E2E_CLAUDE, E2E_CODEX, IMPLEMENT, START_FAILED}),
    ('a crashed run\'s folder is left behind', RING,
     '            if isinstance(folder, str) and Path(folder).name.startswith(RUN_PREFIX):\n                remove_run_folder(folder)',
     '            if isinstance(folder, str) and Path(folder).name.startswith(RUN_PREFIX):\n                None',
     {CRASH}),
    ('a failed revocation is not retried', RING,
     '            for credential_id in list(self.state.revocations):\n                self._revoke(board, credential_id)',
     '            for credential_id in list(self.state.revocations):\n                None',
     {CRASH, REVOKE_RETRY}),
    ('ready work assigned elsewhere is taken', RING,
     'if isinstance(claim.get("expectedAssignmentEpoch"), str):', 'if True:',
     {ELSEWHERE, FOREIGN_ONCE, RESUME}),
    ('the execution connector may verify', RING,
     '        if service is not None and task.get("executionServiceId") == service:\n            return True',
     '        if False:\n            return True',
     {OWN_SERVICE}),
    ('an Assignee in the subtree is not own work', RING,
     'return owner is not None and (owner == self.principal_id or owner in self.state.agents)', 'return False',
     {OWN_AGENT, OWN_OWNER}),
    ('an unknown own service is read as not own', RING,
     '        if task.get("executionServiceId") and service is None:\n            raise RingError("OWN_SERVICE_UNKNOWN")',
     '        if False:\n            raise RingError("OWN_SERVICE_UNKNOWN")',
     {UNKNOWN}),
    ('another Verifier\'s Task is verified', RING,
     '            if task.get("verifierPrincipalId") != self.principal_id:', '            if False:',
     {NOT_VERIFIER}),
    ('a human-verified Task is verified by a run', RING,
     '            if task.get("verificationMode") not in (None, "service"):', '            if False:',
     {NOT_SERVICE}),
    ('stuck may start a run', RING,
     '"stuck": ("notify", "ignore")}', '"stuck": ("run", "notify", "ignore")}',
     {STUCK_POLICY}),
    ('a person is notified on every pass', RING,
     '        if key in self.state.notified and self.state.notified[key] == (candidate.since or "-"):\n            return',
     '        if False:\n            return',
     {NOTIFY_ONCE, VERIFY_ONCE}),
    ('the harness inherits a credential from the environment', RING,
     '           if key != "RELAYHALL_TOKEN" and not custody_module.TOKEN_SHAPE.search(str(value))}', '           }',
     {CENSUS_CLAUDE, CENSUS_CODEX, HARNESS_ENV}),
    ('the run Report is not redacted', RING,
     '            return custody_module.TOKEN_SHAPE.sub("[redacted]", scrub(scrub(text, agent_secret), connector_secret))',
     '            return text',
     # REPORT_FAIL breaks the redaction helper to make the Report writer fail; without the redaction it cannot.
     {CENSUS_CLAUDE, CENSUS_CODEX, REPORT_FAIL}),
    ('the board client calls any route', RING,
     '        need(any(m == method and p.fullmatch(path) for m, p in ROUTES), "BOARD_ROUTE")', '        pass',
     {ROUTES}),
    ('the run folder may be readable by others', RING,
     '        need(mode & 0o077 == 0, "RUN_FOLDER_NOT_PRIVATE")', '        pass',
     {FOLDER_PRIVATE}),
    ('the run credential file is world-readable', RING,
     '    descriptor = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)',
     '    descriptor = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)',
     {CRED_FILE}),
    ('a run\'s process tree is not ended', RING,
     '        try:\n            child.close()\n        except ChildError:',
     '        try:\n            None\n        except ChildError:',
     {TREE}),
    ('a timeout is not named', RING,
     '{"RUN_TIMEOUT": "RUN_TIMEOUT", "RUN_OUTPUT_LIMIT": "RUN_OUTPUT_LIMIT"}',
     '{"RUN_TIMEOUT": "RUN_FAILED", "RUN_OUTPUT_LIMIT": "RUN_OUTPUT_LIMIT"}',
     {TIMEOUT, TREE, CLAUDE_FAILED_TIMEOUT}),
    ('a non-zero exit is a clean finish', RING,
     'result.code = None if error.exit_code == 0 else "RUN_EXIT_NONZERO"', 'result.code = None',
     {NONZERO, CODEX_FAILED, CLAUDE_FAILED_EXIT}),
    ('two daemons serve one connector', CONNECTOR,
     '        with collector_module.exclusive(state_dir(rt, name) / ring_module.STATE_DIR / "ring.lock"):',
     '        with contextlib_nullcontext():',
     {SECOND_DAEMON}),
    ('the one-cycle run has no outer net', CONNECTOR,
     '    watchdog.daemon = True\n    watchdog.start()', '    watchdog.daemon = True',
     {ONESHOT}),
    ('Task Scheduler still stops the daemon after fifteen minutes', CONNECTOR,
     'TASK_EXECUTION_LIMIT = "PT0S"', 'TASK_EXECUTION_LIMIT = "PT15M"',
     {TASK_LIMIT, TASK_XML}),
    ('a closed socket reconnects at once', RING,
     '                if opened_at is not None or self.socket is not None:\n                    self._pause(backoff, stop_at)',
     '                if False:\n                    self._pause(backoff, stop_at)',
     {LOOP}),
    ('the collector cycle blocks the receiver', RING,
     '            self.collector_thread = threading.Thread(target=self._collect, daemon=True)\n'
     '            self.collector_thread.start()',
     '            self.collector_thread = threading.Thread(target=self._collect, daemon=True)\n'
     '            self._collect()',
     {COLLECTOR_BESIDE}),
    ('work re-read every pass is reported every pass', RING,
     'if candidate.source in ("pending", "actions", "assigned") and self.state.reported.get(key) == mark:',
     'if False:',
     {REPORTED_ONCE}),
    ('a verify occurrence that stays open is run again', RING,
     'if kind == "verify" and not candidate.wake_id and attempted and candidate.since and attempted >= candidate.since:',
     'if False:',
     {VERIFY_ONCE}),
    # The S5 review leftovers (owner ruling E462, before the S6 drill).
    ('a first start replays the feed from 0', RING,
     '        self.state.start_at(str(head))', '        self.state.start_at("0")',
     {HEAD, HEAD_SOCKET, WAITING}),
    ('the wake socket opens before the feed head is known', RING,
     '            if not self.state.saved and not self._learn_head():', '            if False:',
     {HEAD_SOCKET}),
    ('waiting work is not read', RING,
     '            self._waiting_here(board, pull)', '            None',
     # REPORTED_ONCE's Task became ready before the first start: only the waiting-work read finds it.
     {WAITING, CATCH_UP, REPORTED_ONCE, NO_STARVING, FOREIGN_ONCE, BEHIND, RESUME, FAILED_PAGE}),
    ('the rate gate is skipped', RING,
     '        if self.gate is not None and not self.gate():', '        if False:',
     {PACED}),
    ('one pass takes the whole backlog', RING,
     '            if budget["left"] <= 0:\n                return False', '            if False:\n                return False',
     {PACED}),
    ('the waiting-work read takes the whole pass', RING,
     '                if share <= 0 or not pull("implement", str(row["id"]), "assigned"):',
     '                if not pull("implement", str(row["id"]), "assigned"):',
     {NO_STARVING, FOREIGN_ONCE, RESUME}),
    ('another connector\'s waiting work is read every pass', RING,
     '            self.foreign_services.add(service)', '            pass',
     {FOREIGN_ONCE, RESUME}),
    ('a stopping ring refuses the run\'s revoke', RING,
     '        while True:\n            with self.lock:\n                now = self.clock()',
     '        while True:\n            if stopping.is_set():\n                return False\n            with self.lock:\n'
     '                now = self.clock()',
     {STOP_REVOKE}),
    ('a wake waits behind pulled work', RING,
     '            if candidate.wake_id:\n                return self.queue.pop(index)',
     '            if False:\n                return self.queue.pop(index)',
     {WAKE_FIRST}),
    ('a pack wider than the request is used', RING,
     '              and set(held) <= set(requested)\n', '',
     {PACK_WIDE}),
    ('a custody failure while reporting is not absorbed', RING,
     '        except custody_module.CustodyError:\n            connector_secret = None',
     '        except ValueError:\n            connector_secret = None',
     {CUSTODY_REPORT}),
    ('a failure while reporting skips the outcome', RING,
     '            except Exception:  # noqa: BLE001 - the outcome below is still sent, the revoke still runs',
     '            except ValueError:  # mutant',
     {REPORT_FAIL}),
    ('an unexpected failure before a run leaves the wake unanswered', RING,
     '            if not candidate.answered:', '            if False:',
     {UNEXPECTED}),
    ('Codex stderr is not read', RING,
     '    if harness != "codex":\n        return\n    line = _ANSI.sub(b"", line)',
     '    if True:\n        return\n    line = _ANSI.sub(b"", line)',
     {CODEX_SERVERS, CODEX_UNISOLATED, SESSION_LINE, E2E_CODEX, CENSUS_CODEX, CODEX}),
    ('the stderr sink is never fed', PROC,
     '                    sink(line[:self.max_line])', '                    pass',
     {STDERR_SINK, E2E_CODEX}),
    ('a Codex run never logs its servers', RING,
     '        env["RUST_LOG"] = CODEX_LOG_FILTER', '        pass',
     {HARNESS_ENV, CODEX_SERVERS, E2E_CODEX}),
    ('an extra MCP server is not refused', RING,
     '            if verdict == "RUN_UNISOLATED" or (verdict is not None and result.code is None):\n'
     '                result.code = verdict',
     '            if False:\n                result.code = verdict',
     {CODEX_UNISOLATED, UNVERIFIED, CLAUDE_ONE, CLAUDE_LATER}),
    ('a run that names no MCP servers passes as isolated', RING,
     '    if servers is None:\n        return "RUN_MCP_UNVERIFIED"', '    if servers is None:\n        return None',
     {UNVERIFIED, SESSION_LINE, CODEX_FAILED, CLAUDE_FAILED_EXIT, CLAUDE_FAILED_TIMEOUT}),
    ('a later init hides an earlier server', RING,
     '        summary["mcpServers"] = sorted(set(summary.get("mcpServers") or []) | named)',
     '        summary["mcpServers"] = sorted(named)',
     {CLAUDE_LATER}),
    ('an unisolated run\'s output is passed on', RING,
     '        if verdict in WITHHELD:', '        if False:',
     {CODEX_UNISOLATED, UNVERIFIED, CODEX_FAILED, CLAUDE_FAILED_EXIT, CLAUDE_FAILED_TIMEOUT}),
    ('the person is not told about an unisolated run', RING,
     '            if result.code in NOTIFY_PERSON:\n                self._notify_once(candidate, result.code)\n'
     '            elif verdict in WITHHELD:\n                self._notify_once(candidate, verdict)',
     '            if False:\n                self._notify_once(candidate, result.code)',
     {CODEX_UNISOLATED, CODEX_FAILED, CLAUDE_FAILED_EXIT, CLAUDE_FAILED_TIMEOUT}),
    ('the daemon\'s mint body drifts from the live drill', RING,
     '            "label": f"relayhall-connector-{kind}-run"}', '            "label": "relayhall-connector-run"}',
     {MINT_BODY}),
    # The S5-leftovers review findings (owner ruling E462, before the S6 drill).
    ('the waiting-work read starts at 0 every pass', RING,
     '        offset = self.waiting_offset', '        offset = 0',
     {BEHIND, RESUME, FAILED_PAGE}),
    ('the waiting-work sweep never starts again at the top', RING,
     '                self.waiting_offset = 0  # the end of the list: the next pass starts a new sweep',
     '                self.waiting_offset = offset + len(rows)',
     {BEHIND, RESUME, FAILED_PAGE}),
    ('a pass out of share skips the rest of its page', RING,
     '                    self.waiting_offset = offset + index  # this row was not taken: the next pass starts at it',
     '                    self.waiting_offset = offset + ASSIGNED_PAGE',
     {RESUME}),
    ('a failed run\'s output is evidence when its servers were not recorded', RING,
     '        if verdict in WITHHELD:', '        if result.code in WITHHELD:',
     {CODEX_FAILED, CLAUDE_FAILED_EXIT, CLAUDE_FAILED_TIMEOUT}),
    ('a failed run that withholds its output tells nobody', RING,
     '            elif verdict in WITHHELD:\n                self._notify_once(candidate, verdict)',
     '            elif False:\n                self._notify_once(candidate, verdict)',
     {CODEX_FAILED, CLAUDE_FAILED_EXIT, CLAUDE_FAILED_TIMEOUT}),
    ('a failed waiting-work page restarts the sweep', RING,
     '                self.waiting_offset = offset  # the page that failed is read again next pass',
     '                self.waiting_offset = 0',
     {FAILED_PAGE}),
]
# The two-daemon control needs a null context the copy can name.
PRELUDE = {CONNECTOR: 'import contextlib\ncontextlib_nullcontext = contextlib.nullcontext\n'}


def fingerprint():
    digest = hashlib.sha256()
    for relative in COPIED:
        base = ROOT / relative
        for path in sorted([base] if base.is_file() else base.rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts and '.pytest_cache' not in path.parts:
                digest.update(str(path.relative_to(ROOT)).encode())
                digest.update(path.read_bytes())
    return digest.hexdigest()


def check_anchors():
    problems = []
    for name, relative, anchor, _replacement, _expected in CONTROLS:
        count = (ROOT / relative).read_text(encoding='utf-8').count(anchor)
        if count != 1:
            problems.append(f'{name}: anchor found {count} times in {relative}')
    return problems


def copy_tree(target):
    for relative in COPIED:
        source = ROOT / relative
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, destination, ignore=shutil.ignore_patterns('__pycache__', '.pytest_cache'))
        else:
            shutil.copy2(source, destination)


def run_suites(tree, label, output_dir):
    junit = output_dir / f'{label}.xml'
    env = {k: v for k, v in os.environ.items() if k not in ('RELAYHALL_TOKEN', 'PYTHONPATH')}
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    completed = subprocess.run(
        [sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', f'--junitxml={junit}', *SUITES],
        cwd=tree / 'cli', env=env, capture_output=True, text=True, timeout=1800)
    (output_dir / f'{label}.log').write_text(completed.stdout[-200000:] + completed.stderr[-20000:])
    if not junit.is_file():
        return None, ['no junit report (the suites did not run)']
    failed, problems = set(), []
    for case in ET.parse(junit).getroot().iter('testcase'):
        node = f"{case.get('file') or case.get('classname', '').replace('.', '/') + '.py'}::{case.get('name')}"
        node = node.split('/')[-1]
        for kind in ('failure', 'error'):
            element = case.find(kind)
            if element is not None:
                failed.add(node)
                message = (element.get('message') or '') + (element.text or '')
                if kind == 'error' or not any(mark in message for mark in ('assert', 'DID NOT RAISE')):
                    problems.append(f'{node}: red by {kind}, not by an assertion')
    return failed, problems


def one_control(index, control, output_dir):
    name, relative, anchor, replacement, expected = control
    with tempfile.TemporaryDirectory(prefix='ring-mutant-') as scratch:
        tree = Path(scratch)
        copy_tree(tree)
        path = tree / relative
        text = path.read_text(encoding='utf-8')
        mutated = text.replace(anchor, replacement, 1)
        if relative in PRELUDE and 'contextlib_nullcontext' in replacement:
            mutated = mutated.replace('\nimport datetime\n', '\nimport datetime\n' + PRELUDE[relative], 1)
        path.write_text(mutated, encoding='utf-8')
        failed, problems = run_suites(tree, f'control-{index:02d}', output_dir)
    if failed is None:
        return {'control': name, 'ok': False, 'problems': problems}
    ok = failed == expected and not problems and bool(expected)
    return {'control': name, 'ok': ok, 'expected': sorted(expected), 'failed': sorted(failed),
            'missing': sorted(expected - failed), 'unexpected': sorted(failed - expected), 'problems': problems}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--output-dir')
    parser.add_argument('--describe', action='store_true')
    parser.add_argument('--jobs', type=int, default=4)
    parser.add_argument('--only', help='run the controls whose name contains this text')
    args = parser.parse_args()
    problems = check_anchors()
    if args.describe:
        for name, relative, *_rest in CONTROLS:
            print(f'{relative}: {name}')
        print('\n'.join(problems) or f'all {len(CONTROLS)} anchors found exactly once')
        return 1 if problems else 0
    if problems:
        print('\n'.join(problems))
        return 1
    if not args.output_dir:
        parser.error('--output-dir is required')
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    before = fingerprint()
    with tempfile.TemporaryDirectory(prefix='ring-baseline-') as scratch:
        copy_tree(Path(scratch))
        failed, base_problems = run_suites(Path(scratch), 'baseline', output_dir)
    if failed is None or failed or base_problems:
        print(f'baseline is not green: {sorted(failed or [])} {base_problems}')
        return 1
    chosen = [(i, c) for i, c in enumerate(CONTROLS) if not args.only or args.only in c[0]]
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        results = list(pool.map(lambda item: one_control(item[0], item[1], output_dir), chosen))
    after = fingerprint()
    report = {'controls': results, 'treeUnchanged': before == after, 'sourceFingerprint': before}
    (output_dir / 'ring-mutations.json').write_text(json.dumps(report, indent=1))
    for result in results:
        mark = 'ok  ' if result['ok'] else 'FAIL'
        detail = '' if result['ok'] else f" missing={result.get('missing')} unexpected={result.get('unexpected')} " \
                                         f"problems={result.get('problems')}"
        print(f'{mark} {result["control"]}{detail}')
    passed = all(r['ok'] for r in results) and before == after
    print(f'{sum(r["ok"] for r in results)}/{len(results)} controls red at exactly their tests; '
          f'tree {"unchanged" if before == after else "CHANGED"}')
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
