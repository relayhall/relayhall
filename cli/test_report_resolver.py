#!/usr/bin/env python3
"""Tests for resolve_report_id: full-UUID passthrough, newest-page prefix
hits, deep search for reports older than the newest 100, ambiguity, and the
A11.2 requirement that ARCHIVED reports stay resolvable (still readable and
unarchivable by their advertised 8-character IDs)."""

import contextlib
import importlib.machinery
import importlib.util
import io
import pathlib
import types
import unittest


def load_cli():
    path = pathlib.Path(__file__).with_name("relayhall")
    loader = importlib.machinery.SourceFileLoader("relayhall_cli_report_resolver_test", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


FULL_ID = "ef3ee865-6ac2-4c85-a612-c2623178b276"


def report(rid, title="A report"):
    return {"id": rid, "title": title}


def newest_page(count=100, stem="aaaa{:04x}0-0000-4000-8000-000000000000"):
    """A full first page of reports, none matching the ids under test."""
    return [report(stem.format(i)) for i in range(count)]


class ResolveReportIdTests(unittest.TestCase):
    def setUp(self):
        self.cli = load_cli()
        self.calls = []

    def install_api(self, responses):
        """Fake api() serving canned responses keyed by exact GET path."""
        def fake_api(method, path, data=None, **kwargs):
            self.calls.append((method, path))
            self.assertEqual(method, "GET")
            self.assertIn(path, responses, f"unexpected API call: {path}")
            return responses[path]
        self.cli.api = fake_api

    def test_full_uuid_passthrough_skips_api(self):
        self.cli.api = lambda *a, **k: self.fail("API must not be called for a full UUID")
        self.assertEqual(self.cli.resolve_report_id(FULL_ID), FULL_ID)

    def test_newest_page_prefix_hit_single_request(self):
        page = newest_page(99) + [report(FULL_ID)]
        self.install_api({"/reports?limit=100&include_archived=true": {"reports": page, "total": 1310, "hasMore": True}})
        self.assertEqual(self.cli.resolve_report_id("ef3ee865"), FULL_ID)
        self.assertEqual(self.calls, [("GET", "/reports?limit=100&include_archived=true")])

    def test_old_report_resolved_via_server_id_search(self):
        # Report is beyond the newest 100 → q= id-prefix search finds it.
        self.install_api({
            "/reports?limit=100&include_archived=true": {"reports": newest_page(), "total": 1310, "hasMore": True},
            "/reports?q=ef3ee865&limit=100&include_archived=true": {"reports": [report(FULL_ID)], "total": 1},
        })
        self.assertEqual(self.cli.resolve_report_id("ef3ee865"), FULL_ID)
        self.assertEqual(self.calls, [
            ("GET", "/reports?limit=100&include_archived=true"),
            ("GET", "/reports?q=ef3ee865&limit=100&include_archived=true"),
        ])

    def test_old_report_short_prefix_resolved_via_offset_paging(self):
        # A 6-char prefix is not a server id-query (needs 8+ hex chars), so
        # the resolver must page with offset instead of trusting q=.
        self.install_api({
            "/reports?limit=100&include_archived=true": {"reports": newest_page(), "total": 250, "hasMore": True},
            "/reports?limit=100&offset=100&include_archived=true": {"reports": newest_page(), "total": 250, "hasMore": True},
            "/reports?limit=100&offset=200&include_archived=true": {"reports": [report(FULL_ID)], "total": 250, "hasMore": False},
        })
        self.assertEqual(self.cli.resolve_report_id("ef3ee8"), FULL_ID)
        self.assertEqual(self.calls, [
            ("GET", "/reports?limit=100&include_archived=true"),
            ("GET", "/reports?limit=100&offset=100&include_archived=true"),
            ("GET", "/reports?limit=100&offset=200&include_archived=true"),
        ])

    def test_legacy_backend_text_search_falls_back_to_paging(self):
        # Older backends treat q= as title/content text search: it may return
        # junk (or nothing) — the resolver must still find the report by paging.
        self.install_api({
            "/reports?limit=100&include_archived=true": {"reports": newest_page(), "total": 150, "hasMore": True},
            "/reports?q=ef3ee865&limit=100&include_archived=true": {"reports": [report("12345678-0000-4000-8000-000000000000",
                                                                 "mentions ef3ee865 in content")], "total": 1},
            "/reports?limit=100&offset=100&include_archived=true": {"reports": [report(FULL_ID)], "total": 150, "hasMore": False},
        })
        self.assertEqual(self.cli.resolve_report_id("ef3ee865"), FULL_ID)

    def test_no_match_anywhere_exits_with_error(self):
        self.install_api({
            "/reports?limit=100&include_archived=true": {"reports": newest_page(), "total": 101, "hasMore": True},
            "/reports?q=deadbeef&limit=100&include_archived=true": {"reports": [], "total": 0},
            "/reports?limit=100&offset=100&include_archived=true": {"reports": [report(FULL_ID)], "total": 101, "hasMore": False},
        })
        stderr = io.StringIO()
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stderr(stderr):
            self.cli.resolve_report_id("deadbeef")
        self.assertEqual(raised.exception.code, 1)
        self.assertIn("No report found", stderr.getvalue())

    def test_ambiguous_prefix_exits_with_error(self):
        twin_a = report("ef3ee865-0000-4000-8000-000000000001", "Twin A")
        twin_b = report("ef3ee865-0000-4000-8000-000000000002", "Twin B")
        self.install_api({
            "/reports?limit=100&include_archived=true": {"reports": newest_page(98) + [twin_a, twin_b],
                                   "total": 100, "hasMore": False},
        })
        stderr = io.StringIO()
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stderr(stderr):
            self.cli.resolve_report_id("ef3ee865")
        self.assertEqual(raised.exception.code, 1)
        self.assertIn("Ambiguous", stderr.getvalue())


class ArchivedReportLifecycleTests(unittest.TestCase):
    """A11.2 regression (review 48ca4ffe F1): archive must not strand a report
    beyond the reach of its advertised 8-character ID."""

    ARCHIVED = "22222222-2222-4222-8222-222222222222"

    def setUp(self):
        self.cli = load_cli()
        self.calls = []
        archived_row = {"id": self.ARCHIVED, "title": "Filed report", "status": "archived"}

        def fake_api(method, path, data=None, **kwargs):
            self.calls.append((method, path))
            if method == "GET" and path.startswith("/reports?"):
                # The backend hides archived rows from default lists: the row
                # exists ONLY when the caller opts in via include_archived.
                if "include_archived=true" in path and "offset=" not in path:
                    return {"reports": [archived_row], "total": 1, "hasMore": False}
                return {"reports": [], "total": 0, "hasMore": False}
            if method == "GET" and path == f"/reports/{self.ARCHIVED}":
                return {"success": True, "report": archived_row}
            if method == "POST" and path == f"/reports/{self.ARCHIVED}/unarchive":
                return {"success": True, "report": dict(archived_row, status="active")}
            self.fail(f"unexpected API call: {method} {path}")
        self.cli.api = fake_api

    def test_archived_report_resolves_by_short_id(self):
        self.assertEqual(self.cli.resolve_report_id("22222222"), self.ARCHIVED)

    def test_archived_report_get_by_short_id_still_reads(self):
        args = types.SimpleNamespace(id="22222222")
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.cli.cmd_report_get(args)
        self.assertIn(("GET", f"/reports/{self.ARCHIVED}"), self.calls)

    def test_archived_report_unarchive_by_short_id_reaches_lifecycle_post(self):
        args = types.SimpleNamespace(id="22222222")
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.cli.cmd_report_unarchive(args)
        self.assertEqual(self.calls[-1], ("POST", f"/reports/{self.ARCHIVED}/unarchive"))


if __name__ == "__main__":
    unittest.main()
