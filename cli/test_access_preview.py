import argparse
import contextlib
import io
import unittest
from relayhall_access_preview import register, run

class AccessPreviewTest(unittest.TestCase):
    def test_self_bounded_query_and_exact_payload(self):
        parser = argparse.ArgumentParser()
        register(parser.add_subparsers(dest='command'))
        args = parser.parse_args(['access','preview','--resource-type','phase','--limit','1','--after','11111111-1111-4111-8111-111111111111'])
        calls = []
        def request(method, path):
            calls.append((method,path)); return {'access': {'resources': [], 'hasMore': False}}
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = run(args, request)
        self.assertEqual(calls, [('GET','/principals/me/effective-access?resourceType=phase&limit=1&after=11111111-1111-4111-8111-111111111111')])
        self.assertIn('resources', output.getvalue())
        self.assertFalse(result['access']['hasMore'])
    def test_oversize_page_refused_by_parser(self):
        parser = argparse.ArgumentParser()
        register(parser.add_subparsers(dest='command'))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parser.parse_args(['access','preview','--limit','51'])
