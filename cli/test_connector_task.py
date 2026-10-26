"""The connector's per-user scheduled task (E462 slice S2; design v1.5 section 3.4).

Unit tests pin the exact schtasks argv and the task XML: a logon trigger for
the signed-in user only, the user's own interactive token at least privilege
(no administrator), restarted on failure, repeated every five minutes with a fifteen-minute limit per run (slice S3), and an action that runs
`relayhall connector run --name <name>` with no token anywhere in it.

One guarded test registers a REAL task under a throwaway test name and deletes
it again. It runs only on Windows and only when RELAYHALL_CONNECTOR_TASK_TEST=1,
so no test run registers anything on a machine that did not ask for it.
"""
import os
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET

import pytest

import relayhall_connector as connector
from connector_testkit import TOKEN, make_runtime

NS = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}


def parsed(xml):
    return ET.fromstring(xml.split("?>", 1)[1])


def test_task_name_is_prefixed_and_validated():
    assert connector.task_name("laptop-codex") == "RelayHall Connector laptop-codex"
    with pytest.raises(Exception):
        connector.task_name("../x")


def test_schtasks_argv_is_exact():
    assert connector.task_create_argv("RelayHall Connector a", r"C:\x\task.xml") == [
        "schtasks", "/Create", "/TN", "RelayHall Connector a", "/XML", r"C:\x\task.xml", "/F"]
    assert connector.task_delete_argv("RelayHall Connector a") == [
        "schtasks", "/Delete", "/TN", "RelayHall Connector a", "/F"]
    assert connector.task_query_xml_argv("RelayHall Connector a") == [
        "schtasks", "/Query", "/TN", "RelayHall Connector a", "/XML"]
    assert connector.task_query_state_argv("RelayHall Connector a") == [
        "schtasks", "/Query", "/TN", "RelayHall Connector a", "/FO", "CSV", "/NH", "/V"]


def test_task_xml_is_per_user_least_privilege_and_restarts(tmp_path):
    rt = make_runtime(tmp_path)
    rt.script = r"C:\Users\person\relay hall\cli\relayhall"
    xml = connector.render_task_xml("laptop", "WORKGROUP\\person", r"C:\Python\pythonw.exe",
                                    connector.task_arguments(rt, "laptop"))
    assert xml.startswith('<?xml version="1.0" encoding="UTF-16"?>')
    root = parsed(xml)
    assert root.find("t:Triggers/t:LogonTrigger/t:UserId", NS).text == "WORKGROUP\\person"
    principal = root.find("t:Principals/t:Principal", NS)
    assert principal.find("t:UserId", NS).text == "WORKGROUP\\person"
    assert principal.find("t:LogonType", NS).text == "InteractiveToken"
    assert principal.find("t:RunLevel", NS).text == "LeastPrivilege"
    settings = root.find("t:Settings", NS)
    assert settings.find("t:RestartOnFailure/t:Interval", NS).text == "PT1M"
    assert settings.find("t:RestartOnFailure/t:Count", NS).text == "3"
    # Slice S5 (repairs the S3 line by name): the ring daemon and its harness runs live inside the task, so Task
    # Scheduler no longer stops it; the one-cycle run keeps its 15-minute outer net in-process
    # (test_connector_ring.py::test_a_one_cycle_run_still_ends_itself_after_fifteen_minutes).
    assert settings.find("t:ExecutionTimeLimit", NS).text == "PT0S"
    assert settings.find("t:MultipleInstancesPolicy", NS).text == "IgnoreNew"
    repeat = root.find("t:Triggers/t:TimeTrigger", NS)
    assert repeat.find("t:Enabled", NS).text == "true"
    assert repeat.find("t:Repetition/t:Interval", NS).text == "PT5M"
    assert repeat.find("t:Repetition/t:StopAtDurationEnd", NS).text == "false"
    assert repeat.find("t:Repetition/t:Duration", NS) is None  # indefinitely
    assert repeat.find("t:UserId", NS) is None  # the principal, the signed-in user, is the only identity
    assert settings.find("t:MultipleInstancesPolicy", NS).text == "IgnoreNew"
    action = root.find("t:Actions/t:Exec", NS)
    assert action.find("t:Command", NS).text == r"C:\Python\pythonw.exe"
    assert action.find("t:Arguments", NS).text == \
        '"C:\\Users\\person\\relay hall\\cli\\relayhall" connector run --name laptop'
    assert "HighestAvailable" not in xml and "S-1-5-18" not in xml and "SYSTEM" not in xml
    assert TOKEN not in xml


def test_task_xml_escapes_markup_in_paths():
    xml = connector.render_task_xml("a", "D\\u<&>", "C:\\p&q\\pythonw.exe", '"x" <y>')
    root = parsed(xml)
    assert root.find("t:Principals/t:Principal/t:UserId", NS).text == "D\\u<&>"
    assert root.find("t:Actions/t:Exec/t:Command", NS).text == "C:\\p&q\\pythonw.exe"


def test_register_writes_utf16_xml_and_deletes_it(tmp_path):
    rt = make_runtime(tmp_path)
    (tmp_path / "home" / "AppData" / "Local" / "RelayHall" / "connector" / "laptop").mkdir(parents=True)
    assert connector.register_task(rt, "laptop") == {"name": "RelayHall Connector laptop"}
    call = rt.scheduler.calls[0]
    assert call["argv"][:5] == ["schtasks", "/Create", "/TN", "RelayHall Connector laptop", "/XML"]
    assert not os.path.exists(call["argv"][5])  # the temporary XML is gone
    assert "connector run --name laptop" in rt.scheduler.tasks["RelayHall Connector laptop"]
    assert all(TOKEN not in part for part in call["argv"]) and "RELAYHALL_TOKEN" not in call["env"]


def test_task_state_reads_status_and_last_result(tmp_path):
    rt = make_runtime(tmp_path)
    rt.scheduler.tasks["RelayHall Connector laptop"] = "<Task/>"
    assert connector.task_state(rt, {"name": "RelayHall Connector laptop"}) == "Ready, last result 267011"
    assert connector.task_state(rt, {"name": "RelayHall Connector other"}) == "not registered"


@pytest.mark.skipif(sys.platform != "win32" or os.environ.get("RELAYHALL_CONNECTOR_TASK_TEST") != "1",
                    reason="registers a real task: Windows with RELAYHALL_CONNECTOR_TASK_TEST=1 only")
def test_real_registration_under_a_test_name_cleans_up(tmp_path):
    rt = connector.Runtime()
    rt.state_root = str(tmp_path)
    name = f"pytest-{uuid.uuid4().hex[:10]}"
    task = connector.task_name(name)
    try:
        assert connector.register_task(rt, name) == {"name": task}
        assert connector.task_is_ours(rt, {"name": task}, name) is True
        assert connector.task_state(rt, {"name": task}) != "not registered"
    finally:
        subprocess.run(connector.task_delete_argv(task), capture_output=True)
    assert connector.task_is_ours(rt, {"name": task}, name) is None
