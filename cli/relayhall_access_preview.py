"""Self-only live authority preview; the server owns all decisions and paging."""
import json
from urllib.parse import urlencode

def register(sub):
    command = sub.add_parser('access', help='Inspect your current authority')
    verbs = command.add_subparsers(dest='access_command')
    preview = verbs.add_parser('preview', help='Show bounded live object permissions and their sources')
    preview.add_argument('--resource-type', choices=['task','phase','project','report','skill','personality','service'], default='task')
    preview.add_argument('--limit', type=int, choices=range(1, 51), default=20)
    preview.add_argument('--after', help='Exact UUID nextCursor returned by the previous page')

def run(args, request):
    if args.access_command != 'preview':
        raise SystemExit('Use relayhall access preview')
    query = {'resourceType': args.resource_type, 'limit': args.limit}
    if args.after:
        query['after'] = args.after
    result = request('GET', '/principals/me/effective-access?' + urlencode(query))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result
