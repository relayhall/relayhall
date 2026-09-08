#!/usr/bin/env python3
"""w3-naming-audit.py — the A23.3 / A23.7 added-line sweep, as a command.

Vocabulary `b94dd86e` A23.3 says bare "provider" names no object and the compound
"Identity provider" is required on every surface and at the FIRST reference in
any passage; A23.7 and §3 System words say "session" is never used bare and this
concept is a LOGIN session. A23.3 also names the enforceable form: a
**case-insensitive added-line sweep**.

    python3 backend/scripts/w3-naming-audit.py [--base <sha>]

Exit 0 = no unexplained bare use on any added line. Exit 1 = the offending
file:line list, which is the repair list.

── FOUR ROUNDS OF REVIEW BUILT THIS, AND EACH FAILURE IS THE REASON FOR A RULE ──

  * round 2 — the repair was hand-picked from a reviewer's citations and left the
    same shape in files the reviewer had not read. Rejected as an INCOMPLETE
    CLASS REPAIR: sampling a naming rule finds the lines you were shown.
  * round 3 — the first mechanical form matched whole LINES and needed a long
    list of identifier exclusions to avoid flagging `provider.id`.
  * round 4 — those exclusions swallowed real prose: the pattern written for the
    identifier also skipped "…admitting login at this provider.", and the hyphen
    exclusion hid "per-provider". So the sweep stopped guessing and now extracts
    PROSE — comment bodies, human-readable strings, rendered copy.
  * round 5 — the prose was then judged as a WHOLE LINE: a case-insensitive
    `Sessions\\b` exempted every plural, and one qualified occurrence excused a
    separate bare noun earlier on the same line. So each OCCURRENCE is now
    classified on its own left context, which is the only form that cannot
    launder one word with another.

EXCEPTIONS are enumerated below with a reason each, never as a blanket skip:
scoping an exemption by VALUE rather than by file is the RFC1918 lesson this
programme paid for at §4.5(b).
"""
import argparse
import re
import subprocess
import sys

# Each entry: (path fragment, matching text fragment, why it is not a violation).
EXCEPTIONS = [
    ("test-w3-group-sync-live.js", "a snapshot applied under one provider",
     "verbatim quotation of acceptance annex e6dcadb9 §11a; editing a quotation of a "
     "ratified document is the worse error (accepted by round-3 review R1)"),
    ("test-w3-group-sync-live.js", "and yields a session",
     "verbatim quotation of the annex §11 SS-W3 definition of done"),
    ("test-w3-group-sync-live.js", 'its bare "session"',
     "the note recording the quotation exception above — a mention of the word, not a use"),
    ("LoginSessionService.ts", '"session" for this concept',
     "the naming note itself — a mention of the retired bare form, not a use"),
    ("SsoAuthenticationService.ts", "authMethod: 'session'",
     "a ratified audit ENUM VALUE (audit_events.auth_method), not prose; renaming it "
     "would break the column's CHECK constraint"),
]

EXCEPTIONS += [
    ("w3-red-proofs.js", "sessions for that Account",
     "the M-a23.1 mutation text. The driver re-introduces this exact retired line to "
     "watch the sweep redden on it, so the line is a MENTION of the retired form; "
     "qualifying it here would disarm the drill that guards the rule"),
    ("w3-red-proofs.js", "Login at this provider.",
     "the M-a23.3 fixture text: the hostile line the drill INJECTS to watch the sweep "
     "redden on a trailing comment. It is the specimen, not a claim about anything"),
    ("w3-red-proofs.js", "revokes the session, exactly as",
     "the M-a23.2 mutation text, same reason: it carries the laundering shape "
     "(a bare noun followed by `LoginSessionService`) that round 5 found"),
]

COMMENT_MARKERS = ("/**", "//", "--", "*", "#")

STRING_LITERAL = re.compile(r"'([^'\n]{4,})'|\"([^\"\n]{4,})\"|`([^`\n]{4,})`")

# A string literal is only PROSE if it reads as human text. Round-4 R1's finding
# was that whole-line exclusions swallow prose; the mirror-image error is to treat
# every quoted string as prose, which flags SQL fragments, red-proof mutation
# anchors and object literals. Both are avoided by asking what the text IS.
CODE_SHAPED = re.compile(
    r"[={}]|=>|\(\)|::|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bWHERE\b|"
    r"\bawait\b|\breturn\b|\bconst\b|\.\w+\(|\\n")

INTERPOLATION = re.compile(r"\$\{[^}]*\}")

# This file is the SWEEP; its own text states the rule and encodes the patterns,
# so every mention here is a use-mention distinction rather than a naming
# violation. Excluding it is the one FILE-scoped exemption in this script, and it
# is named rather than implied.
SELF = "w3-naming-audit.py"


# A comment marker belongs to a LANGUAGE, not to every line. Round-6 review R3
# found both halves of getting this wrong: `#` applied to TypeScript turned the
# string "/directory#session" into a naming violation (`4a8ceddf`), while no
# rule at all covered `/* ... */`, so block-comment prose walked past the sweep
# (`623b7fdb`). The markers are taken from the path.
LINE_COMMENT = [
    ((".py", ".sh", ".bash", ".yml", ".yaml", ".toml"), r"#\s?(.*)$"),
    ((".sql",), r"--\s?(.*)$"),
]
C_FAMILY = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss")

# A one-line block comment, and the opening of a multi-line one. The closing
# `*/` and the continuation `*` are handled by the leading-marker pass below.
BLOCK_COMMENT = re.compile(r"/\*+\s?(.*?)(?:\*/|$)")


def prose_of(line, path=""):
    """The human-readable parts of a line: comment bodies, prose strings, copy.

    Round-5 follow-up `b75a25fa`: a comment TRAILING code is prose too, and a
    template literal carrying `${...}` is prose with a hole in it — the
    interpolation is removed and the surrounding words are judged.

    Round-6 R3 `623b7fdb`/`4a8ceddf`: which markers apply is decided by the
    file's language, and `/* ... */` is one of them.
    """
    pieces = []
    stripped = line.strip()

    # A URL carries its own "//", so scheme text is removed BEFORE any marker is
    # looked for — guarding afterwards cannot work, because the match starts at
    # the slashes and never at the scheme.
    scrubbed = re.sub(r"\bhttps?://\S*", " ", line)

    patterns = []
    for suffixes, pattern in LINE_COMMENT:
        if path.endswith(suffixes):
            patterns.append(pattern)
    if not patterns or path.endswith(C_FAMILY):
        patterns.append(r"//\s?(.*)$")

    for pattern in patterns:
        comment = re.search(pattern, scrubbed)
        if comment:
            pieces.append(comment.group(1))

    if not path.endswith((".py", ".sh", ".bash", ".yml", ".yaml", ".toml")):
        for block in BLOCK_COMMENT.finditer(scrubbed):
            pieces.append(block.group(1))

    for marker in ("/**", "*"):
        if stripped.startswith(marker):
            pieces.append(stripped[len(marker):])
            break

    for match in STRING_LITERAL.finditer(line):
        for group in match.groups():
            if not group:
                continue
            text = INTERPOLATION.sub(" ", group)
            if text.count(" ") >= 3 and not CODE_SHAPED.search(text):
                pieces.append(text)

    RE_COPY = r"^[A-Za-z][A-Za-z ,.;:&'—’-]{15,}$"
    if (not pieces and stripped.count(' ') >= 3 and re.match(RE_COPY, stripped)):
        pieces.append(stripped)
    return " ".join(pieces)


def bare_uses(prose, word, qualifiers):
    """Every occurrence of `word` that no ratified qualifier immediately precedes.

    Round-5 R3 B2: judging the whole line let `LoginSessionService` later in a
    sentence excuse a bare noun earlier in it, and a case-insensitive plural
    exemption excused every "sessions". Each occurrence is judged on its own
    left context instead, so one word can never launder another.
    """
    hits = []
    for match in re.finditer(r"(?<![\w-])(%ss?)\b(?!-)" % word, prose, re.I):
        left = prose[max(0, match.start() - 24):match.start()]
        if re.search(r"(?:%s)[ -]$" % "|".join(qualifiers), left, re.I):
            continue
        if re.search(r"[\w.]$", left):      # part of an identifier
            continue
        hits.append(match.group(0))
    return hits


def added_lines(base):
    diff = subprocess.run(
        ["git", "diff", "-U0", base, "--", "backend/", "frontend/", "cli/"],
        capture_output=True, text=True, check=True).stdout
    path, line = None, 0
    for raw in diff.splitlines():
        if raw.startswith("+++ b/"):
            path = raw[6:]
        elif raw.startswith("@@"):
            match = re.search(r"\+(\d+)", raw)
            line = int(match.group(1)) if match else 0
        elif raw.startswith("+") and not raw.startswith("+++"):
            yield path, line, raw[1:]
            line += 1


def excepted(path, text):
    return any(fragment in path and needle in text for fragment, needle, _ in EXCEPTIONS)


def sweep(base):
    findings = []
    for path, line, text in added_lines(base):
        if path.endswith(SELF) or excepted(path, text):
            continue
        prose = prose_of(text, path)
        if not prose:
            continue
        for hit in bare_uses(prose, "provider", ["identity"]):
            findings.append((path, line, "bare '%s' (A23.3)" % hit, prose.strip()))
        for hit in bare_uses(prose, "session", ["login", "agent", "mcp"]):
            findings.append((path, line, "bare '%s' (A23.7)" % hit, prose.strip()))

    if not findings:
        print("A23 added-line naming sweep PASSED against %s (%d enumerated exceptions)."
              % (base, len(EXCEPTIONS)))
        return 0
    print("A23 added-line naming sweep FAILED against %s:" % base, file=sys.stderr)
    for path, line, rule, text in findings:
        print("  %s:%d  %s\n      %s" % (path, line, rule, text[:120]), file=sys.stderr)
    return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="5352a1a", help="the SHA this wave branched from")
    sys.exit(sweep(parser.parse_args().base))
