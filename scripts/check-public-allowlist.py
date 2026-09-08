#!/usr/bin/env python3
"""Check .relayhall-public-allowlist against the committed tree.

scripts/publish-to-github.sh requires the allowlist to equal
`git ls-tree -r --name-only <sha>` exactly: it is a whole-tree publication
manifest, not a filter. Adding, renaming or deleting any file breaks it.

The publication gate already enforces this, but it costs ~71s in CI and ~95s
locally because it builds throwaway clones and runs gitleaks over them. This
check performs the identical comparison in well under a second, so the most
common publication failure is caught before anything expensive runs.

It deliberately does not write the allowlist. Approving a path for publication
is a review decision; a tool that silently added whatever appeared in the tree
would defeat the gate it is meant to support.
"""
import argparse
import subprocess
import sys


def git(*args):
    result = subprocess.run(
        ['git', *args], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit(2)
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--rev', default='HEAD',
        help='revision to check (default: HEAD, matching what the gate publishes)')
    parser.add_argument(
        '--policy-path', default='.relayhall-public-allowlist',
        help='allowlist path within the revision')
    args = parser.parse_args()

    try:
        policy = git('show', f'{args.rev}:{args.policy_path}').splitlines()
    except SystemExit:
        print(f'Publish allowlist missing from {args.rev}: {args.policy_path}',
              file=sys.stderr)
        return 2
    tree = git('ls-tree', '-r', '--name-only', args.rev).splitlines()

    if policy == tree:
        if git('status', '--porcelain').strip():
            print(f'Publication allowlist matches {args.rev} '
                  f'({len(tree)} paths). Working tree is dirty — uncommitted '
                  f'file additions are not covered by this check.')
        else:
            print(f'Publication allowlist matches {args.rev} ({len(tree)} paths).')
        return 0

    missing = [p for p in tree if p not in set(policy)]
    stale = [p for p in policy if p not in set(tree)]

    print(f'Publication allowlist does not match {args.rev}.', file=sys.stderr)
    print(f'  {args.policy_path}: {len(policy)} entries', file=sys.stderr)
    print(f'  committed tree:     {len(tree)} paths', file=sys.stderr)

    if missing:
        print(f'\nIn the tree but NOT allowlisted ({len(missing)}). Publishing '
              f'these is a review decision — add each one to '
              f'{args.policy_path} in git ls-tree order:', file=sys.stderr)
        for path in missing:
            print(f'  + {path}', file=sys.stderr)
    if stale:
        print(f'\nAllowlisted but NOT in the tree ({len(stale)}). Renamed or '
              f'deleted — remove each one from {args.policy_path}:',
              file=sys.stderr)
        for path in stale:
            print(f'  - {path}', file=sys.stderr)

    print(f'\nThe ordering the gate expects is exactly '
          f'`git ls-tree -r --name-only {args.rev}`.', file=sys.stderr)
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
