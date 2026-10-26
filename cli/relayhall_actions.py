"""`relayhall actions`: the Action Center queue, READ ONLY (owner ruling E467).

For a person's own Connector, or an Agent under it, the board answers with the
items waiting on the owning Account (Decision, Verify, Stuck, Skill review) as
well as the caller's own; for any other credential, with the caller's own
items. The server decides what the caller may read: an item whose object the
caller cannot read arrives as its kind and id only, and this command prints it
that way. There is deliberately no verb here that decides, marks seen or
changes anything: acting on an item stays on the board.
"""
import argparse
import json

KINDS = ('decision', 'verify', 'stuck', 'skill')
ROUTE = '/notifications/actions/owner'


def register(sub):
    command = sub.add_parser('actions', help='List the Action Center items waiting on you and your person (read only)')
    verbs = command.add_subparsers(dest='actions_command')
    listing = verbs.add_parser('list', help='List the open items (the default verb)')
    command.add_argument('--json', action='store_true', help='Raw JSON envelope')
    command.add_argument('--kind', choices=KINDS, help='Only items of this kind')
    # SUPPRESS: the verb's own defaults must not overwrite what was given before it.
    listing.add_argument('--json', action='store_true', default=argparse.SUPPRESS, help='Raw JSON envelope')
    listing.add_argument('--kind', choices=KINDS, default=argparse.SUPPRESS, help='Only items of this kind')


def waited(seconds):
    """26m, 3h 05m, 2d 04h: how long an item has waited."""
    total = max(0, int(seconds or 0))
    if total < 60:
        return f'{total}s'
    minutes = total // 60
    if minutes < 60:
        return f'{minutes}m'
    hours = minutes // 60
    if hours < 24:
        return f'{hours}h {minutes % 60:02d}m'
    return f'{hours // 24}d {hours % 24:02d}h'


def line(item):
    obj = item.get('object') or {}
    title = f'"{obj.get("title") or "(untitled)"}"' if item.get('readable') else '(not readable by you: kind and id only)'
    project = (item.get('project') or {}).get('name')
    on = {'caller': 'on you', 'both': 'on the Account and you'}.get(item.get('waitingOn'), 'on the Account')
    parts = [f'{item.get("kind", "?"):<8} {obj.get("id", "?")}', title]
    if project:
        parts.append(f'proj {project}')
    parts += [f'waiting {waited(item.get("waitedSeconds"))}', 'seen' if item.get('seen') else 'unseen', on, str(item.get('href') or '')]
    return '  '.join(parts)


def run(args, request):
    if getattr(args, 'actions_command', None) not in (None, 'list'):
        raise SystemExit('Use relayhall actions [list]')
    result = request('GET', ROUTE)
    if not isinstance(result, dict) or result.get('success') is False:
        raise SystemExit('The Action Center queue could not be read.')
    kind = getattr(args, 'kind', None)
    items = [item for item in result.get('items', []) if kind is None or item.get('kind') == kind]
    if getattr(args, 'json', False):
        shown = dict(result)
        shown['items'] = items
        print(json.dumps(shown, ensure_ascii=False, indent=2))
        return result
    counts = result.get('counts') or {}
    whose = "your person's Account and you" if result.get('scope') == 'owning-account' else 'you'
    if not items:
        print(f'Nothing is waiting on {whose}.')
        return result
    print(f'Waiting on {whose}: {len(items)} item(s), {counts.get("unseen", 0)} unseen.')
    for item in items:
        print(line(item))
    capped = [name for name, flag in (result.get('capped') or {}).items() if flag]
    if capped:
        print('More than the cap of 200 are waiting for: ' + ', '.join(capped) + '. Only the oldest are shown.')
    return result
