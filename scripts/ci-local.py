#!/usr/bin/env python3
"""Run one CI job's steps locally, in the workflow's order, on a disposable database.

    python3 scripts/ci-local.py list
    python3 scripts/ci-local.py run  --job scale_load --out /tmp/ci-local-scale
    python3 scripts/ci-local.py plan --job scale_load --out /tmp/ci-local-scale --json
    python3 scripts/ci-local.py map  [--json]
    python3 scripts/ci-local.py check
    python3 scripts/ci-local.py self-test

`run` reads `.gitea/workflows/ci-full.yml` (and `ci.yml`; `--workflow fast|full`
picks one when a job id is in both), then runs the job's `run:` steps in order with
the workflow, job and step `env:` applied. `uses:` steps are recorded as skipped:
the caller's checkout and toolchain stand in for them.

Database. A job that declares a PostgreSQL service gets ONE disposable database for
the whole job, as in CI:
  --db container (default)  a `postgres:16` (the service's image) container bound to
                            127.0.0.1 on a random port, named `<prefix>-<job>`
                            (`--name-prefix`, default `ci-local-<pid>`), removed at exit;
  --db env                  the caller's RELAYHALL_TEST_DB_URL, or DB_HOST/DB_PORT/
                            DB_NAME/DB_USER/DB_PASSWORD; loopback hosts only.
Every value a step's env names for the service (its hostname, port, user, password,
database, or a postgres URL on that host) is replaced by the local one. Inherited
DB_*, PG*, DATABASE_URL and RELAYHALL_TEST_DB_URL are removed first, so a step sees
only what the workflow gives it. Credentials are never printed and are masked in logs.

Suite guards. Many live suites admit either the exact CI service or a loopback
database whose NAME looks disposable. `scripts/ci-local-map.txt` lists the guards
that need a particular name; before each step the job database is renamed (container
mode) to the name every suite the step reaches will admit. `map` prints which steps
need what; `check` proves the map against the tree.

Output, under --out: `steps.jsonl` (one JSON record per step: n, name, exit, result,
seconds, ...), `logs/NN-<slug>.log` per step and `summary.json`. A red step never
stops the run; the exit status is 1 when any step was not green.

`plan --json` prints the same job as a list of separately runnable steps,
{"steps": [{"name", "heavy", "cmd", "cwd", ...}]}, for a scheduler that runs one
step at a time; its first entry starts a job database that lives while the
scheduler process lives, and its last entry writes the summary.

Stdlib only: the workflow files are read by a small YAML subset reader, which
`check` compares with PyYAML when that is installed.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import secrets as secrets_mod
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = {"full": ".gitea/workflows/ci-full.yml", "fast": ".gitea/workflows/ci.yml"}
MAP_FILE = "scripts/ci-local-map.txt"
PLAN_SCHEMA = "ci-local-plan/1"
SCRUB_PREFIXES = ("DB_", "PG")
SCRUB_NAMES = {"DATABASE_URL", "RELAYHALL_TEST_DB_URL"}
HOST_VARS = {"DB_HOST", "PGHOST"}
PORT_VARS = {"DB_PORT", "PGPORT"}
USER_VARS = {"DB_USER", "PGUSER"}
PASS_VARS = {"DB_PASSWORD", "PGPASSWORD"}
NAME_VARS = {"DB_NAME", "PGDATABASE"}
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
RED = {"failure", "timeout", "env-unmet", "error"}
NL = "\n"


class CiLocalError(Exception):
    pass


# ---------------------------------------------------------------- YAML subset

class _Lines:
    def __init__(self, text):
        self.raw = text.replace("\r\n", "\n").split("\n")


def _strip_comment(s):
    """Remove a trailing comment from a non-block line, respecting quotes."""
    quote = None
    for i, ch in enumerate(s):
        if quote:
            if ch == quote:
                if quote == "'" and i + 1 < len(s) and s[i + 1] == "'":
                    continue
                quote = None
            elif ch == "\\" and quote == '"':
                continue
        elif ch in "'\"" and (i == 0 or s[i - 1] in " \t[{,:-"):
            quote = ch
        elif ch == "#" and (i == 0 or s[i - 1] in " \t"):
            return s[:i].rstrip()
    return s.rstrip()


def _indent(s):
    return len(s) - len(s.lstrip(" "))


def _scalar(text):
    t = text.strip()
    if t == "" or t in ("~", "null", "Null", "NULL"):
        return None
    if t.startswith("'") and t.endswith("'") and len(t) >= 2:
        return t[1:-1].replace("''", "'")
    if t.startswith('"') and t.endswith('"') and len(t) >= 2:
        body = t[1:-1]
        out, i = [], 0
        esc = {"n": "\n", "t": "\t", '"': '"', "\\": "\\", "/": "/", "r": "\r", "0": "\0"}
        while i < len(body):
            if body[i] == "\\" and i + 1 < len(body):
                out.append(esc.get(body[i + 1], body[i + 1]))
                i += 2
            else:
                out.append(body[i])
                i += 1
        return "".join(out)
    if t.startswith("[") and t.endswith("]"):
        return [_scalar(p) for p in _split_flow(t[1:-1])]
    if t.startswith("{") and t.endswith("}"):
        result = {}
        for part in _split_flow(t[1:-1]):
            k, _, v = part.partition(":")
            result[_scalar(k)] = _scalar(v)
        return result
    return t


def _split_flow(body):
    parts, cur, quote, depth = [], [], None, 0
    for ch in body:
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in "'\"":
            quote = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
            continue
        cur.append(ch)
    if "".join(cur).strip():
        parts.append("".join(cur))
    return [p.strip() for p in parts]


_KEY = re.compile(r"""^(?P<key>"[^"]*"|'[^']*'|[^\s'"#][^:#]*?)\s*:(?:\s+(?P<rest>.*)|$)""")


class YamlSubset:
    """Block mappings and sequences, plain/quoted/flow scalars, `|` and `>` block
    scalars, comments. Enough for this repository's workflow files; `check`
    compares the result with PyYAML when it is available."""

    def __init__(self, text):
        self.lines = _Lines(text).raw

    def parse(self):
        i = self._skip(0)
        if i >= len(self.lines):
            return None
        value, i = self._node(i, _indent(self.lines[i]))
        i = self._skip(i)
        if i < len(self.lines):
            raise CiLocalError("yaml: unexpected content at line %d: %r" % (i + 1, self.lines[i]))
        return value

    def _content(self, i):
        return _strip_comment(self.lines[i]) if i < len(self.lines) else ""

    def _skip(self, i):
        while i < len(self.lines) and not self._content(i).strip():
            i += 1
        return i

    def _node(self, i, ind):
        line = self._content(i)
        body = line[ind:]
        if body == "-" or body.startswith("- "):
            return self._seq(i, ind)
        return self._map(i, ind)

    def _seq(self, i, ind):
        items = []
        while True:
            i = self._skip(i)
            if i >= len(self.lines):
                break
            line = self._content(i)
            if _indent(line) != ind or not (line[ind:] == "-" or line[ind:].startswith("- ")):
                break
            rest = line[ind + 1:]
            stripped = rest.lstrip(" ")
            if not stripped:
                j = self._skip(i + 1)
                if j < len(self.lines) and _indent(self._content(j)) > ind:
                    value, i = self._node(j, _indent(self._content(j)))
                else:
                    value, i = None, i + 1
                items.append(value)
                continue
            col = ind + 1 + (len(rest) - len(stripped))
            if _KEY.match(stripped):
                self.lines[i] = " " * col + self.lines[i][col:]
                value, i = self._map(i, col)
            elif stripped in ("|", "|-", "|+", ">", ">-", ">+"):
                value, i = self._block(i, ind, stripped)
            else:
                value, i = _scalar(stripped), i + 1
            items.append(value)
        return items, i

    def _map(self, i, ind):
        result = {}
        while True:
            i = self._skip(i)
            if i >= len(self.lines):
                break
            line = self._content(i)
            if _indent(line) != ind:
                if _indent(line) > ind:
                    raise CiLocalError("yaml: bad indentation at line %d" % (i + 1))
                break
            body = line[ind:]
            if body.startswith("- ") or body == "-":
                break
            m = _KEY.match(body)
            if not m:
                raise CiLocalError("yaml: expected a key at line %d: %r" % (i + 1, line))
            key = _scalar(m.group("key"))
            rest = (m.group("rest") or "").strip()
            if key in result:
                raise CiLocalError("yaml: duplicate key %r at line %d" % (key, i + 1))
            if rest in ("|", "|-", "|+", ">", ">-", ">+"):
                value, i = self._block(i, ind, rest)
            elif rest:
                value, i = _scalar(rest), i + 1
                # plain multi-line continuation
                if isinstance(value, str) and rest[:1] not in "'\"[{":
                    j = self._skip(i)
                    extra = []
                    while j < len(self.lines) and _indent(self._content(j)) > ind \
                            and not _KEY.match(self._content(j).strip()) \
                            and not self._content(j).strip().startswith("- "):
                        extra.append(self._content(j).strip())
                        j = self._skip(j + 1)
                    if extra:
                        value = " ".join([value] + extra)
                        i = j
            else:
                j = self._skip(i + 1)
                if j < len(self.lines):
                    nxt = self._content(j)
                    nind = _indent(nxt)
                    if nind > ind or (nind == ind and (nxt[ind:].startswith("- ") or nxt[ind:] == "-")):
                        value, i = self._node(j, nind)
                    else:
                        value, i = None, i + 1
                else:
                    value, i = None, i + 1
            result[key] = value
        return result, i

    def _block(self, i, ind, header):
        style, chomp = header[0], header[1:]
        lines = []
        j = i + 1
        block_ind = None
        while j < len(self.lines):
            raw = self.lines[j]
            if raw.strip() == "":
                lines.append("")
                j += 1
                continue
            cur = _indent(raw)
            if cur <= ind:
                break
            if block_ind is None:
                block_ind = cur
            if cur < block_ind:
                break
            lines.append(raw[block_ind:])
            j += 1
        while lines and lines[-1] == "":
            lines.pop()
        if style == "|":
            text = NL.join(lines)
        else:
            parts = []
            for ln in lines:
                if ln == "":
                    parts.append(NL)
                    continue
                if parts and parts[-1] != NL:
                    parts.append(" ")
                parts.append(ln)
            text = "".join(parts)
        if chomp == "-":
            return text, j
        return (text + NL) if text else "", j


def load_yaml(path):
    return YamlSubset(Path(path).read_text(encoding="utf-8")).parse()


# ---------------------------------------------------------------- workflows

def slug(text, limit=48):
    s = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return (s[:limit].rstrip("-")) or "step"


def step_title(step):
    if step.get("name"):
        return str(step["name"])
    if step.get("uses"):
        return "Run " + str(step["uses"])
    first = (step.get("run") or "").strip().splitlines()
    return "Run " + (first[0] if first else "")


def classify(step):
    """uses | install | db-wait | db-schema | run"""
    if step.get("uses"):
        return "uses"
    text = (step.get("run") or "").strip()
    if "load-base-schema" in text or re.search(r"\bnpm run migrate\b|src/db/migrate\.ts", text):
        return "db-schema"
    if "wait-for-postgres" in text:
        return "db-wait"
    if re.fullmatch(r"npm ci(\s+--[a-z-]+)*", text):
        return "install"
    return "run"


SETUP_KINDS = {"install", "db-wait", "db-schema"}


def is_light(step, kind):
    """Heavy = starts or loads PostgreSQL, installs, or may run more than one test file."""
    if kind in ("uses", "db-wait"):
        return True
    text = (step.get("run") or "").strip()
    if re.fullmatch(r"node --test \S+", text) or re.fullmatch(r"cat \S+", text):
        return True
    if re.fullmatch(r"cmp \S+ \S+", text):
        return True
    return False


class Workflow:
    def __init__(self, root, key):
        self.root = Path(root)
        self.key = key
        self.path = self.root / WORKFLOWS[key]
        self.data = load_yaml(self.path) if self.path.exists() else {}
        self.jobs = (self.data or {}).get("jobs") or {}


def load_workflows(root):
    return {k: Workflow(root, k) for k in WORKFLOWS}


def find_job(root, job, which=None):
    wfs = load_workflows(root)
    hits = [w for k, w in wfs.items() if (which is None or k == which) and job in w.jobs]
    if not hits:
        known = sorted({j for w in wfs.values() for j in w.jobs})
        raise CiLocalError("no job %r (known: %s)" % (job, ", ".join(known)))
    if len(hits) > 1:
        raise CiLocalError("job %r is in both workflows; pass --workflow fast|full" % job)
    return hits[0]


class Job:
    def __init__(self, workflow, job_id):
        self.workflow = workflow
        self.id = job_id
        self.spec = workflow.jobs[job_id] or {}
        self.name = str(self.spec.get("name") or job_id)
        defaults = ((self.spec.get("defaults") or {}).get("run") or {})
        wf_defaults = (((workflow.data or {}).get("defaults") or {}).get("run") or {})
        self.default_wd = defaults.get("working-directory") or wf_defaults.get("working-directory") or "."
        self.default_shell = defaults.get("shell") or wf_defaults.get("shell")
        self.env = {}
        self.env.update({str(k): _env_str(v) for k, v in ((workflow.data or {}).get("env") or {}).items()})
        self.env.update({str(k): _env_str(v) for k, v in (self.spec.get("env") or {}).items()})
        self.services = {}
        for name, svc in (self.spec.get("services") or {}).items():
            svc = svc or {}
            env = {str(k): _env_str(v) for k, v in (svc.get("env") or {}).items()}
            self.services[str(name)] = {
                "image": str(svc.get("image") or ""),
                "env": env,
                "user": env.get("POSTGRES_USER", "postgres"),
                "password": env.get("POSTGRES_PASSWORD", ""),
                "db": env.get("POSTGRES_DB", env.get("POSTGRES_USER", "postgres")),
                "port": "5432",
            }
        self.container = self.spec.get("container")
        self.timeout = _minutes(self.spec.get("timeout-minutes"))
        self.steps = []
        for n, raw in enumerate(self.spec.get("steps") or [], 1):
            raw = raw or {}
            kind = classify(raw)
            self.steps.append({
                "n": n,
                "title": step_title(raw),
                "id": "%s-%02d-%s" % (job_id, n, slug(step_title(raw), 40)),
                "kind": kind,
                "heavy": not is_light(raw, kind),
                "run": raw.get("run"),
                "uses": raw.get("uses"),
                "env": {str(k): _env_str(v) for k, v in (raw.get("env") or {}).items()},
                "wd": raw.get("working-directory") or self.default_wd,
                "shell": raw.get("shell") or self.default_shell,
                "timeout": _minutes(raw.get("timeout-minutes")),
            })

    @property
    def postgres(self):
        for name, svc in self.services.items():
            if "postgres" in svc["image"]:
                return name, svc
        return None, None


def _env_str(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _minutes(v):
    try:
        return float(v) * 60 if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- the map

class GuardMap:
    """scripts/ci-local-map.txt. Lines:
         default <name>
         generic <regex>
         require <id> name=<local-name> db=<regex> sig=<regex>
         cionly  <id> sig=<regex> note=<free text>
         known   <literal> <free text>
    """

    def __init__(self, root):
        self.path = Path(root) / MAP_FILE
        self.default = None
        self.generic = None
        self.requires = []
        self.cionly = []
        self.known = {}
        self.errors = []
        if not self.path.exists():
            self.errors.append("%s is missing" % MAP_FILE)
            return
        for number, raw in enumerate(self.path.read_text(encoding="utf-8").splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            word, _, rest = line.partition(" ")
            rest = rest.strip()
            try:
                if word == "default":
                    self.default = rest
                elif word == "generic":
                    self.generic = re.compile(rest)
                elif word == "require":
                    rid, fields = self._fields(rest, ("name", "db", "sig"))
                    self.requires.append({"id": rid, "name": fields["name"], "db": re.compile(fields["db"]),
                                          "sig": re.compile(fields["sig"]), "line": number})
                elif word == "cionly":
                    rid, fields = self._fields(rest, ("sig", "note"))
                    self.cionly.append({"id": rid, "sig": re.compile(fields["sig"]), "note": fields["note"],
                                        "line": number})
                elif word == "known":
                    lit, _, why = rest.partition(" ")
                    self.known[lit] = why.strip()
                else:
                    self.errors.append("%s:%d: unknown line kind %r" % (MAP_FILE, number, word))
            except (re.error, KeyError, ValueError) as exc:
                self.errors.append("%s:%d: %s" % (MAP_FILE, number, exc))
        if not self.default:
            self.errors.append("%s: no `default` line" % MAP_FILE)
        if not self.generic:
            self.errors.append("%s: no `generic` line" % MAP_FILE)

    @staticmethod
    def _fields(rest, names):
        rid, _, tail = rest.partition(" ")
        fields = {}
        for name in names:
            m = re.search(r"(?:^|\s)%s=" % name, tail)
            if not m:
                raise KeyError("missing %s=" % name)
            start = m.end()
            if name == "note":
                fields[name] = tail[start:].strip()
            else:
                end = tail.find(" ", start)
                fields[name] = tail[start:] if end < 0 else tail[start:end]
        return rid, fields


def _read(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _package_scripts(directory):
    pkg = Path(directory) / "package.json"
    if not pkg.exists():
        return {}
    try:
        return json.loads(pkg.read_text(encoding="utf-8")).get("scripts") or {}
    except ValueError:
        return {}


_FILE_REF = re.compile(r"(?<![\w./-])((?:\.\.?/)*[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:py|js|cjs|mjs|ts|tsx))(?![\w/-])")
_NPM_RUN = re.compile(r"\bnpm run ([A-Za-z0-9:_.-]+)")


def reached_files(root, cwd, text, depth=0, seen=None):
    """Files a command text reaches: npm scripts (recursively), script and test
    files it names, and (two levels down) the files those scripts name."""
    root = Path(root)
    seen = set() if seen is None else seen
    found = set()
    packages = [Path(cwd), root / "backend", root / "frontend"]
    for m in _NPM_RUN.finditer(text):
        for pkg_dir in packages:
            script = _package_scripts(pkg_dir).get(m.group(1))
            if script is None:
                continue
            key = ("npm", str(pkg_dir), m.group(1))
            if key not in seen:
                seen.add(key)
                found |= reached_files(root, pkg_dir, script, depth, seen)
            break
    for m in _FILE_REF.finditer(text):
        ref = m.group(1)
        if "node_modules" in ref:
            continue
        for base in (Path(cwd), root, root / "backend", root / "frontend"):
            candidate = (base / ref).resolve()
            try:
                candidate.relative_to(root)
            except ValueError:
                continue
            if candidate.is_file():
                if candidate not in found:
                    found.add(candidate)
                    key = ("file", str(candidate))
                    # a test file is a leaf; a runner config names every suite it IGNORES, so it is a leaf too
                    leaf = candidate.name.endswith((".test.ts", ".test.tsx")) or ".config." in candidate.name
                    if depth < 2 and key not in seen and not leaf:
                        seen.add(key)
                        found |= reached_files(root, candidate.parent.parent if candidate.parent.name == "scripts"
                                               else candidate.parent, _read(candidate), depth + 1, seen)
                break
    return found


def step_requirements(root, job, step, gmap):
    """(require entries, cionly entries, reached files) for one step."""
    if not step.get("run"):
        return [], [], set()
    cwd = Path(root) / step["wd"]
    files = reached_files(root, cwd, step["run"])
    req, cio = [], []
    for f in sorted(files):
        text = _read(f)
        for r in gmap.requires:
            if r["sig"].search(text) and r not in req:
                req.append(r)
        for c in gmap.cionly:
            if c["sig"].search(text) and c not in cio:
                cio.append(c)
    return req, cio, files


def choose_database(gmap, base_name, reqs):
    """The one database name every reached guard admits, or (None, reason)."""
    if not reqs:
        return base_name, None
    for r in reqs:
        if all(o["db"].fullmatch(r["name"]) for o in reqs) and gmap.generic.search(r["name"]):
            return r["name"], None
    return None, "conflicting database-name guards: " + ", ".join(r["id"] for r in reqs)


# ---------------------------------------------------------------- database

def _docker(*args, check=True, capture=True, timeout=600):
    proc = subprocess.run(["docker", *args], capture_output=capture, text=True, timeout=timeout)
    if check and proc.returncode != 0:
        raise CiLocalError("docker %s failed (%d): %s" % (args[0], proc.returncode, (proc.stderr or "").strip()[:400]))
    return proc


class Database:
    """host, port, user, password, name; plus how to rename the database."""

    def __init__(self, mode, host, port, user, password, name, container=None, service=None):
        self.mode, self.host, self.port = mode, host, str(port)
        self.user, self.password, self.name = user, password, name
        self.container, self.service = container, service

    def to_state(self):
        return {"mode": self.mode, "host": self.host, "port": self.port, "user": self.user,
                "password": self.password, "name": self.name, "container": self.container,
                "service": self.service}

    @classmethod
    def from_state(cls, data):
        return cls(data["mode"], data["host"], data["port"], data["user"], data["password"], data["name"],
                   data.get("container"), data.get("service"))

    def url(self, scheme="postgres", name=None):
        return "%s://%s:%s@%s:%s/%s" % (scheme, urllib.parse.quote(self.user, safe=""),
                                         urllib.parse.quote(self.password, safe=""), self.host, self.port,
                                         urllib.parse.quote(name or self.name, safe=""))

    def describe(self):
        return "%s %s:%s/%s" % (self.mode, self.host, self.port, self.name)

    def psql(self, sql):
        if self.mode != "container":
            raise CiLocalError("renaming needs --db container")
        _docker("exec", self.container, "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", self.user, "-d", "postgres",
                "-c", sql)

    def rename(self, new):
        if new == self.name:
            return
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", new):
            raise CiLocalError("refusing database name %r" % new)
        self.psql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '%s' AND pid <> "
                  "pg_backend_pid()" % self.name)
        self.psql('ALTER DATABASE "%s" RENAME TO "%s"' % (self.name, new))
        self.name = new


def env_database(environ):
    url = environ.get("RELAYHALL_TEST_DB_URL")
    if url:
        p = urllib.parse.urlsplit(url)
        db = Database("env", p.hostname or "", p.port or 5432, urllib.parse.unquote(p.username or ""),
                      urllib.parse.unquote(p.password or ""), urllib.parse.unquote(p.path.lstrip("/")))
    else:
        missing = [k for k in ("DB_HOST", "DB_NAME", "DB_USER") if not environ.get(k)]
        if missing:
            raise CiLocalError("--db env needs RELAYHALL_TEST_DB_URL or DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD "
                               "(missing %s)" % ", ".join(missing))
        db = Database("env", environ["DB_HOST"], environ.get("DB_PORT", "5432"), environ["DB_USER"],
                      environ.get("DB_PASSWORD", ""), environ["DB_NAME"])
    if db.host not in LOOPBACK:
        raise CiLocalError("--db env admits only a loopback database host (127.0.0.1, localhost, ::1)")
    if not db.name:
        raise CiLocalError("--db env: the database target names no database")
    return db


def start_container(job, gmap, prefix):
    svc_name, svc = job.postgres
    name = "%s-%s" % (prefix, slug(job.id, 30))
    base = svc["db"] if gmap.generic.search(svc["db"] or "") else gmap.default
    password = secrets_mod.token_hex(16)
    args = ["run", "-d", "--name", name, "--label", "ci-local.job=%s" % job.id, "-p", "127.0.0.1::5432"]
    for k, v in svc["env"].items():
        if k in ("POSTGRES_PASSWORD", "POSTGRES_DB"):
            continue
        args += ["-e", "%s=%s" % (k, v)]
    args += ["-e", "POSTGRES_PASSWORD=" + password, "-e", "POSTGRES_DB=" + base, svc["image"] or "postgres:16"]
    _docker("rm", "-f", "-v", name, check=False)
    _docker(*args)
    db = Database("container", "127.0.0.1", "", svc["user"], password, base, container=name, service=svc_name)
    deadline = time.monotonic() + 240
    while True:
        out = _docker("port", name, "5432/tcp", check=False).stdout.strip().splitlines()
        if out:
            db.port = out[0].rsplit(":", 1)[1]
        ready = _docker("exec", name, "pg_isready", "-h", "127.0.0.1", "-U", db.user, "-d", base, check=False)
        if db.port and ready.returncode == 0:
            # the image's init server listens on the socket only; TCP readiness means the real server
            break
        if time.monotonic() > deadline:
            stop_container(name)
            raise CiLocalError("the job database did not become ready within 240 s")
        time.sleep(2)
    return db


def stop_container(name):
    if name:
        _docker("rm", "-f", "-v", name, check=False)


# ---------------------------------------------------------------- env

_EXPR = re.compile(r"\$\{\{\s*(.*?)\s*\}\}")


def expand_expressions(value, context, used):
    def repl(m):
        expr = m.group(1)
        used.append(expr)
        sm = re.fullmatch(r"secrets\.([A-Za-z_][A-Za-z0-9_]*)", expr)
        if sm:
            return os.environ.get(sm.group(1), "")
        return context.get(expr, "")
    return _EXPR.sub(repl, value)


def rewrite_value(name, value, svc_hosts, svc, db, db_name, mapped):
    if not svc:
        return value
    if re.match(r"postgres(?:ql)?://", value):
        p = urllib.parse.urlsplit(value)
        if p.hostname in svc_hosts:
            path_db = urllib.parse.unquote(p.path.lstrip("/"))
            target = db_name if path_db in ("", svc["db"]) else path_db
            mapped.append(name)
            return db.url(p.scheme, target) + (("?" + p.query) if p.query else "")
        return value
    if name in HOST_VARS and value in svc_hosts:
        mapped.append(name)
        return db.host
    if name in PORT_VARS and value == svc["port"]:
        mapped.append(name)
        return db.port
    if name in USER_VARS and value == svc["user"]:
        mapped.append(name)
        return db.user
    if name in PASS_VARS and value == svc["password"]:
        mapped.append(name)
        return db.password
    if name in NAME_VARS and value == svc["db"]:
        mapped.append(name)
        return db_name
    if value in svc_hosts:
        mapped.append(name)
        return db.host
    return value


def base_environment(out_dir, root):
    env = {k: v for k, v in os.environ.items()
           if not (k.startswith(SCRUB_PREFIXES) or k in SCRUB_NAMES)}
    tmp = Path(out_dir) / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    env.update({"CI": "true", "GITHUB_WORKSPACE": str(root), "RUNNER_TEMP": str(tmp), "TMPDIR": str(tmp)})
    return env


# ---------------------------------------------------------------- running

class Runner:
    def __init__(self, root, job, out_dir, gmap, db, quiet=False, exit_zero=False):
        self.root = Path(root)
        self.job = job
        self.out = Path(out_dir)
        self.gmap = gmap
        self.db = db
        self.quiet = quiet
        (self.out / "logs").mkdir(parents=True, exist_ok=True)
        self.records = self.out / "steps.jsonl"
        self.github_output = self.out / "github-output.txt"
        self.github_output.touch()
        self.base_db_name = db.name if db else None

    def record(self, rec):
        with self.records.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, sort_keys=True) + "\n")
        if not self.quiet:
            sec = rec.get("seconds")
            print("ci-local: step %2d %-10s exit=%-4s %7ss  %s" % (
                rec["n"], rec["result"], "-" if rec["exit"] is None else rec["exit"],
                "-" if sec is None else "%.1f" % sec, rec["name"]), flush=True)

    def skip(self, step, reason, result="skipped"):
        self.record(self._base(step, result, None, None, note=reason))

    def _base(self, step, result, exit_code, seconds, **extra):
        rec = {"n": step["n"], "name": step["title"], "exit": exit_code, "result": result,
               "seconds": None if seconds is None else round(seconds, 2), "id": step["id"],
               "kind": step["kind"], "job": self.job.id, "workflow": WORKFLOWS[self.job.workflow.key]}
        rec.update({k: v for k, v in extra.items() if v not in (None, [], "")})
        return rec

    def run_step(self, step):
        svc_name, svc = self.job.postgres
        reqs, cio, _files = step_requirements(self.root, self.job, step, self.gmap)
        log_rel = "logs/%02d-%s.log" % (step["n"], slug(step["title"], 40))
        db_name = self.db.name if self.db else None
        if cio:
            note = "; ".join("%s: %s" % (c["id"], c["note"]) for c in cio)
            self.record(self._base(step, "env-unmet", None, None, requires=[c["id"] for c in cio], note=note))
            return
        if reqs and self.db:
            wanted, why = choose_database(self.gmap, self.db.name, reqs)
            if wanted is None:
                self.record(self._base(step, "env-unmet", None, None, requires=[r["id"] for r in reqs], note=why))
                return
            if self.db.mode == "container":
                self.db.rename(wanted)
            elif not all(r["db"].fullmatch(self.db.name) for r in reqs):
                self.record(self._base(
                    step, "env-unmet", None, None, requires=[r["id"] for r in reqs],
                    note="the suite guard admits only a database named like %s; use --db container or point "
                         "the caller's database at that name" % wanted))
                return
            db_name = self.db.name
        elif self.db and self.db.mode == "container" and self.db.name != self.base_db_name:
            self.db.rename(self.base_db_name)
            db_name = self.db.name
        used, mapped = [], []
        context = {"github.workspace": str(self.root), "runner.temp": str(self.out / "tmp"),
                   "runner.os": "Linux"}
        env = base_environment(self.out, self.root)
        env["GITHUB_OUTPUT"] = str(self.github_output)
        hosts = set(self.job.services)
        merged = dict(self.job.env)
        merged.update(step["env"])
        for k, v in merged.items():
            v = expand_expressions(v, context, used)
            env[k] = rewrite_value(k, v, hosts, svc, self.db, db_name, mapped) if self.db else v
        script = expand_expressions(step["run"], context, used)
        if self.db and svc:
            for h in hosts:
                script = re.sub(r"(?<=[@/])%s:%s\b" % (re.escape(h), svc["port"]),
                                "%s:%s" % (self.db.host, self.db.port), script)
        cwd = self.root / step["wd"]
        shell = step.get("shell")
        script_file = self.out / "tmp" / ("step-%02d.sh" % step["n"])
        script_file.write_text(script, encoding="utf-8")
        if shell in (None, ""):
            argv = ["bash", "-e", str(script_file)]
        elif shell == "bash":
            argv = ["bash", "--noprofile", "--norc", "-eo", "pipefail", str(script_file)]
        elif shell == "sh":
            argv = ["sh", "-e", str(script_file)]
        elif shell == "python":
            argv = ["python3", str(script_file)]
        else:
            argv = shlex.split(shell.replace("{0}", str(script_file)))
        timeout = step["timeout"] or self.job.timeout
        secret_values = [s for s in ([self.db.password] if self.db else []) if s]
        secret_values += [v for v in (os.environ.get(e[8:], "") for e in used if e.startswith("secrets.")) if v]
        before = untracked_paths(self.root)
        started = time.monotonic()
        exit_code, result = self._spawn(argv, cwd, env, self.out / log_rel, timeout, secret_values)
        seconds = time.monotonic() - started
        self.record(self._base(step, result, exit_code, seconds, cwd=step["wd"], log=log_rel,
                               requires=[r["id"] for r in reqs], database=db_name if svc else None,
                               mapped=sorted(set(mapped)), expressions=sorted(set(used)),
                               wrote=sorted(untracked_paths(self.root) - before)))

    def _spawn(self, argv, cwd, env, log_path, timeout, secret_values):
        if not cwd.is_dir():
            log_path.write_text("ci-local: working directory %s does not exist\n" % cwd, encoding="utf-8")
            return None, "error"
        with log_path.open("w", encoding="utf-8") as log:
            proc = subprocess.Popen(argv, cwd=str(cwd), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, start_new_session=True)
            deadline = None if timeout is None else time.monotonic() + timeout
            timed_out = False
            try:
                import selectors
                sel = selectors.DefaultSelector()
                sel.register(proc.stdout, selectors.EVENT_READ)
                buf = b""
                while True:
                    if deadline is not None and time.monotonic() > deadline:
                        timed_out = True
                        os.killpg(proc.pid, signal.SIGKILL)
                        break
                    events = sel.select(timeout=1.0)
                    if not events:
                        if proc.poll() is not None:
                            rest = proc.stdout.read()
                            if rest:
                                buf += rest
                            break
                        continue
                    chunk = os.read(proc.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        self._emit(log, line.decode("utf-8", "replace") + "\n", secret_values)
                if buf:
                    self._emit(log, buf.decode("utf-8", "replace"), secret_values)
                proc.wait()
            except BaseException:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    pass
                raise
            finally:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)  # stragglers of the step's process group
                except OSError:
                    pass
        if timed_out:
            return None, "timeout"
        return proc.returncode, ("success" if proc.returncode == 0 else "failure")

    def _emit(self, log, text, secret_values):
        for s in secret_values:
            text = text.replace(s, "***")
        log.write(text)
        if not self.quiet:
            sys.stdout.write("    | " + text if text.strip() else text)
            sys.stdout.flush()


def git_status(root):
    """(XY, path) per `git status` entry; untracked files are listed one by one."""
    toks = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "-z", "--untracked-files=all"],
                          capture_output=True, text=True, check=True).stdout.split("\0")
    entries, i = [], 0
    while i < len(toks):
        tok, i = toks[i], i + 1
        if tok:
            entries.append((tok[:2], tok[3:]))
            if tok[0] in "RC":
                i += 1  # a rename or copy carries its source path as the next entry
    return entries


def untracked_paths(root):
    try:
        return {path for xy, path in git_status(root) if xy == "??"}
    except (subprocess.CalledProcessError, OSError):
        return set()


def job_outputs(out_dir):
    """Untracked files the steps of this --out created (their `wrote` field): a job's own receipts are not dirt."""
    paths, path = set(), Path(out_dir) / "steps.jsonl"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                paths.update(json.loads(line).get("wrote", []))
    return paths


def git_head(root, own=()):
    try:
        head = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True,
                              check=True).stdout.strip()
        own = set(own)
        dirty = any(xy != "??" or path not in own for xy, path in git_status(root))
        return head, dirty
    except (subprocess.CalledProcessError, OSError):
        return None, None


def select_steps(job, from_step, only_steps, skip_setup):
    """Yield (step, action, reason): action run|skip."""
    for step in job.steps:
        if step["kind"] == "uses":
            yield step, "skip", "uses: the local checkout and toolchain stand in"
            continue
        if only_steps:
            if step["n"] in only_steps:
                yield step, "run", None
            continue
        if step["kind"] in SETUP_KINDS:
            if skip_setup:
                yield step, "skip", "--skip-setup"
            else:
                yield step, "run", None
            continue
        if from_step and step["n"] < from_step:
            yield step, "skip", "before --from-step %d" % from_step
            continue
        yield step, "run", None


def write_summary(root, job, out_dir, extra=None):
    out = Path(out_dir)
    recs = {}
    path = out / "steps.jsonl"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rec = json.loads(line)
                if rec.get("job") == job.id:
                    recs[rec["n"]] = rec
    steps = []
    for step in job.steps:
        rec = recs.get(step["n"])
        if rec is None:
            rec = {"n": step["n"], "name": step["title"], "exit": None, "seconds": None, "id": step["id"],
                   "kind": step["kind"], "job": job.id,
                   "result": "skipped" if step["kind"] == "uses" else "not-run"}
        steps.append(rec)
    head, dirty = git_head(root, job_outputs(out))
    counts = {}
    for rec in steps:
        counts[rec["result"]] = counts.get(rec["result"], 0) + 1
    summary = {"job": job.id, "jobName": job.name, "workflow": WORKFLOWS[job.workflow.key], "head": head,
               "dirty": dirty, "counts": counts, "steps": steps,
               "finished": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    if extra:
        summary.update(extra)
    (out / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return summary


def summary_status(summary, ran_only=None):
    bad = [s for s in summary["steps"] if s["result"] in RED
           or (s["result"] == "not-run" and (ran_only is None or s["n"] in ran_only))]
    return 1 if bad else 0


class _Terminate(Exception):
    pass


def _raise_terminate(signum, frame):
    raise _Terminate()


def cmd_run(args):
    root = Path(args.root).resolve()
    wf = find_job(root, args.job, args.workflow)
    job = Job(wf, args.job)
    gmap = GuardMap(root)
    if gmap.errors:
        raise CiLocalError("; ".join(gmap.errors))
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if args.fresh_out and (out / "steps.jsonl").exists():
        (out / "steps.jsonl").unlink()
    only = set(args.only_step or [])
    svc_name, svc = job.postgres
    db = None
    owned = None
    state_path = Path(args.db_state).resolve() if args.db_state else None
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, _raise_terminate)
    try:
        if svc:
            if state_path:
                if not state_path.exists():
                    raise CiLocalError("--db-state %s does not exist (run db-up first)" % state_path)
                db = Database.from_state(json.loads(state_path.read_text(encoding="utf-8")))
            elif args.db == "env":
                db = env_database(os.environ)
            else:
                prefix = args.name_prefix or "ci-local-%d" % os.getpid()
                db = start_container(job, gmap, prefix)
                owned = db.container
        if not args.quiet:
            print("ci-local: %s / %s (%s) -> %s; database: %s" % (
                WORKFLOWS[wf.key], job.id, job.name, out, db.describe() if db else "none"), flush=True)
            if job.container:
                print("ci-local: note: the job runs in container %r in CI; here it runs on the host toolchain"
                      % (job.container if isinstance(job.container, str) else job.container.get("image")),
                      flush=True)
        runner = Runner(root, job, out, gmap, db, quiet=args.quiet)
        if db and state_path:
            runner.base_db_name = json.loads(state_path.read_text(encoding="utf-8")).get("base") or db.name
        for step, action, reason in select_steps(job, args.from_step, only, args.skip_setup):
            if action == "skip":
                if not only or step["n"] in only:
                    runner.skip(step, reason)
                continue
            runner.run_step(step)
            if state_path and db:
                data = json.loads(state_path.read_text(encoding="utf-8"))
                data["name"] = db.name
                _write_private(state_path, data)
    except _Terminate:
        print("ci-local: terminated", file=sys.stderr)
        return 143
    finally:
        if owned:
            stop_container(owned)
    if only:
        return 0 if args.exit_zero else _only_status(out, job, only)
    summary = write_summary(root, job, out, {"database": db.describe() if db else None,
                                              "fromStep": args.from_step, "skipSetup": args.skip_setup})
    if not args.quiet:
        print("ci-local: %s" % json.dumps(summary["counts"], sort_keys=True))
    return 0 if args.exit_zero else summary_status(summary)


def _only_status(out, job, only):
    bad = False
    for line in (out / "steps.jsonl").read_text(encoding="utf-8").splitlines():
        rec = json.loads(line)
        if rec.get("job") == job.id and rec["n"] in only and rec["result"] in RED:
            bad = True
    return 1 if bad else 0


def _write_private(path, data):
    tmp = Path(str(path) + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(str(tmp), str(path))


# ---------------------------------------------------------------- db-up / db-down / hold

def cmd_db_up(args):
    root = Path(args.root).resolve()
    job = Job(find_job(root, args.job, args.workflow), args.job)
    if not job.postgres[1]:
        print("ci-local: job %s declares no PostgreSQL service" % job.id)
        return 0
    state = Path(args.db_state).resolve()
    state.parent.mkdir(parents=True, exist_ok=True)
    if state.exists():
        state.unlink()
    watch = args.watch_pid or os.getppid()
    log = open(str(state) + ".holder.log", "a", encoding="utf-8")
    cmd = [sys.executable, str(Path(__file__).resolve()), "--root", str(root), "_hold", "--job", job.id,
           "--db-state", str(state), "--watch-pid", str(watch), "--ttl", str(args.ttl)]
    if args.workflow:
        cmd += ["--workflow", args.workflow]
    if args.db == "env":
        cmd += ["--db", "env"]
    if args.name_prefix:
        cmd += ["--name-prefix", args.name_prefix]
    holder = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                              close_fds=True)
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        if state.exists():
            data = json.loads(state.read_text(encoding="utf-8"))
            print("ci-local: job database up: %s (holder pid %d, lives while pid %d lives)" % (
                Database.from_state(data).describe(), holder.pid, watch))
            return 0
        if holder.poll() is not None:
            raise CiLocalError("the database holder exited (%s); see %s.holder.log" % (holder.returncode, state))
        time.sleep(1)
    raise CiLocalError("the job database was not ready within 300 s")


def cmd_hold(args):
    root = Path(args.root).resolve()
    job = Job(find_job(root, args.job, args.workflow), args.job)
    gmap = GuardMap(root)
    state = Path(args.db_state)
    stop = {"now": False}

    def on_term(signum, frame):
        stop["now"] = True
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, on_term)
    if args.db == "env":
        db = env_database(os.environ)
        container = None
    else:
        db = start_container(job, gmap, args.name_prefix or "ci-local-%d" % os.getpid())
        container = db.container
    data = db.to_state()
    data.update({"holder": os.getpid(), "base": db.name, "job": job.id})
    _write_private(state, data)
    print("holder %d: %s, watching pid %d" % (os.getpid(), db.describe(), args.watch_pid), flush=True)
    deadline = time.monotonic() + args.ttl * 60
    try:
        while not stop["now"] and time.monotonic() < deadline:
            try:
                os.kill(args.watch_pid, 0)
            except ProcessLookupError:
                print("holder: watched pid %d is gone" % args.watch_pid, flush=True)
                break
            except PermissionError:
                pass
            time.sleep(2)
    finally:
        stop_container(container)
        try:
            state.unlink()
        except OSError:
            pass
        print("holder %d: database removed" % os.getpid(), flush=True)
    return 0


def cmd_db_down(args):
    state = Path(args.db_state).resolve()
    if not state.exists():
        print("ci-local: no job database state at %s" % state)
        return 0
    data = json.loads(state.read_text(encoding="utf-8"))
    pid = data.get("holder")
    try:
        if pid:
            os.kill(int(pid), signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 60
    while state.exists() and time.monotonic() < deadline:
        time.sleep(0.5)
    if state.exists():
        stop_container(data.get("container"))
        state.unlink()
    print("ci-local: job database removed")
    return 0


def cmd_summary(args):
    root = Path(args.root).resolve()
    job = Job(find_job(root, args.job, args.workflow), args.job)
    summary = write_summary(root, job, args.out)
    for s in summary["steps"]:
        print("%2d %-10s exit=%-4s %s" % (s["n"], s["result"], "-" if s["exit"] is None else s["exit"], s["name"]))
    print("ci-local: %s" % json.dumps(summary["counts"], sort_keys=True))
    planned = set(args.planned or [])
    return summary_status(summary, planned or None)


# ---------------------------------------------------------------- plan

def build_plan(root, job, out, from_step=None, skip_setup=False, workflow_key=None, name_prefix=None,
               python="python3"):
    me = str(Path(__file__).resolve())
    out = str(Path(out).resolve())
    state = os.path.join(out, "db.json")
    common = [python, me, "--root", str(root)]
    wf = ["--workflow", workflow_key] if workflow_key else []
    steps = []
    has_db = bool(job.postgres[1])
    if has_db:
        up = common + ["db-up", "--job", job.id, "--db-state", state] + wf
        if name_prefix:
            up += ["--name-prefix", name_prefix]
        steps.append({"name": "%s-00-db-up" % job.id, "title": "Start the job database", "heavy": False,
                      "cmd": up, "cwd": str(root), "kind": "db-up"})
    planned = []
    for step, action, reason in select_steps(job, from_step, None, skip_setup):
        if action != "run":
            continue
        planned.append(step["n"])
        cmd = common + ["run", "--job", job.id, "--only-step", str(step["n"]), "--out", out, "--exit-zero",
                        "--quiet"] + wf
        if has_db:
            cmd += ["--db-state", state]
        steps.append({"name": step["id"], "title": step["title"], "n": step["n"], "heavy": step["heavy"],
                      "cmd": cmd, "cwd": str(root), "kind": step["kind"]})
    if has_db:
        steps.append({"name": "%s-98-db-down" % job.id, "title": "Remove the job database", "heavy": False,
                      "cmd": common + ["db-down", "--db-state", state], "cwd": str(root), "kind": "db-down"})
    summary_cmd = common + ["summary", "--job", job.id, "--out", out] + wf
    for n in planned:
        summary_cmd += ["--planned", str(n)]
    steps.append({"name": "%s-99-summary" % job.id, "title": "Write the summary", "heavy": False,
                  "cmd": summary_cmd, "cwd": str(root), "kind": "summary"})
    return steps


def cmd_plan(args):
    root = Path(args.root).resolve()
    head, dirty = git_head(root, job_outputs(args.out))
    if head is None:
        raise CiLocalError("plan needs a git checkout")
    if dirty:
        raise CiLocalError("plan refuses a dirty tree: commit first, so the plan names the exact commit "
                           "(only files the steps of this --out wrote are allowed)")
    wf = find_job(root, args.job, args.workflow)
    job = Job(wf, args.job)
    gmap = GuardMap(root)
    if gmap.errors:
        raise CiLocalError("; ".join(gmap.errors))
    steps = build_plan(root, job, args.out, args.from_step, args.skip_setup, args.workflow, args.name_prefix)
    for entry in steps:
        if entry["kind"] in ("db-up", "db-down", "summary"):
            continue
        step = job.steps[entry["n"] - 1]
        reqs, cio, _ = step_requirements(root, job, step, gmap)
        if reqs or cio:
            entry["requires"] = [r["id"] for r in reqs] + [c["id"] for c in cio]
    plan = {"schema": PLAN_SCHEMA, "workflow": WORKFLOWS[wf.key], "job": job.id, "jobName": job.name,
            "head": head, "out": str(Path(args.out).resolve()), "fromStep": args.from_step,
            "skipSetup": args.skip_setup, "steps": steps}
    if args.json:
        print(json.dumps(plan, indent=2))
    else:
        print("plan %s %s @ %s -> %s" % (plan["workflow"], job.id, head[:12], plan["out"]))
        for e in steps:
            print("  %-5s %-44s %s" % ("heavy" if e["heavy"] else "light", e["name"], e.get("title", "")))
    return 0


# ---------------------------------------------------------------- list / map / check

def cmd_list(args):
    root = Path(args.root).resolve()
    for key, wf in load_workflows(root).items():
        print("%s (%s)" % (WORKFLOWS[key], key))
        for job_id in wf.jobs:
            job = Job(wf, job_id)
            runnable = sum(1 for s in job.steps if s["kind"] != "uses")
            print("  %-34s %3d steps (%d run)  %s%s" % (job_id, len(job.steps), runnable, job.name,
                                                        "  [postgres]" if job.postgres[1] else ""))
    return 0


def compute_map(root, gmap):
    rows = []
    for key, wf in load_workflows(root).items():
        for job_id in wf.jobs:
            job = Job(wf, job_id)
            svc = job.postgres[1]
            for step in job.steps:
                reqs, cio, _ = step_requirements(root, job, step, gmap)
                if not reqs and not cio:
                    continue
                if cio:
                    status, database = "ci-only", None
                else:
                    database, why = choose_database(gmap, "<job database>", reqs)
                    status = "conflict" if database is None else "renamed"
                rows.append({"workflow": WORKFLOWS[key], "job": job_id, "n": step["n"], "step": step["title"],
                             "requires": [r["id"] for r in reqs] + [c["id"] for c in cio],
                             "database": database, "status": status, "service": bool(svc),
                             "note": "; ".join(c["note"] for c in cio) or None})
    return rows


def cmd_map(args):
    root = Path(args.root).resolve()
    gmap = GuardMap(root)
    if gmap.errors:
        raise CiLocalError("; ".join(gmap.errors))
    rows = compute_map(root, gmap)
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    for r in rows:
        print("%-28s %2d %-8s %-24s %s" % (r["job"], r["n"], r["status"], ",".join(r["requires"]),
                                            r["database"] or r["note"] or ""))
        print("%34s %s" % ("", r["step"]))
    return 0


_DB_LITERAL = re.compile(r"""['"]([a-z][a-z0-9]*(?:_[a-z0-9]+)+)['"]""")
_DB_REGEX = re.compile(r"/\^([a-z][a-z0-9_]*)")
_DB_CONTEXT = re.compile(r"hostname|database|dbName|DB_NAME|TEST_DB_NAME|pathname|datname")


def guard_tokens(text):
    """Database-name literals and anchored regex prefixes on lines that look at a database target."""
    found = set()
    for line in text.splitlines():
        if not _DB_CONTEXT.search(line):
            continue
        for m in _DB_LITERAL.finditer(line):
            tok = m.group(1)
            if re.search(r"_test|test_|_contract|contract_|_fixture|fixture_|^relayhall_", tok):
                found.add(tok)
        for m in _DB_REGEX.finditer(line):
            if "_" in m.group(1):
                found.add(m.group(1))
    return found


def check_tree(root, out=print):
    """Drift controls for the map against the real tree. Returns a list of failures."""
    root = Path(root)
    failures = []
    gmap = GuardMap(root)
    failures += gmap.errors
    if gmap.errors:
        return failures
    if not gmap.generic.search(gmap.default):
        failures.append("default database %r does not satisfy the generic guard" % gmap.default)
    for r in gmap.requires:
        if not r["db"].fullmatch(r["name"]):
            failures.append("require %s: its name %r does not satisfy its own db regex" % (r["id"], r["name"]))
        if not gmap.generic.search(r["name"]):
            failures.append("require %s: its name %r does not satisfy the generic guard" % (r["id"], r["name"]))
    sig_hits = {r["id"]: 0 for r in gmap.requires}
    sig_hits.update({c["id"]: 0 for c in gmap.cionly})
    unmapped = {}
    wfs = load_workflows(root)
    total_steps = 0
    for key, wf in wfs.items():
        if not wf.jobs:
            failures.append("%s has no jobs" % WORKFLOWS[key])
        for job_id in wf.jobs:
            job = Job(wf, job_id)
            for step in job.steps:
                total_steps += 1
                if step["kind"] == "uses" or not step["run"]:
                    continue
                reqs, cio, files = step_requirements(root, job, step, gmap)
                for r in reqs:
                    sig_hits[r["id"]] += 1
                for c in cio:
                    sig_hits[c["id"]] += 1
                if reqs and not cio:
                    db, why = choose_database(gmap, gmap.default, reqs)
                    if db is None:
                        failures.append("%s step %d %r: %s" % (job_id, step["n"], step["title"], why))
                for f in files:
                    for tok in guard_tokens(_read(f)):
                        if tok in gmap.known:
                            continue
                        if any(r["db"].fullmatch(tok) or r["name"].startswith(tok) for r in gmap.requires):
                            continue
                        if any(c["sig"].search(tok) for c in gmap.cionly):
                            continue
                        if tok == gmap.default:
                            continue
                        unmapped.setdefault(tok, set()).add(str(f.relative_to(root)))
    for rid, hits in sig_hits.items():
        if hits == 0:
            failures.append("map entry %s matches no file any workflow step reaches (stale or renamed)" % rid)
    for tok, files in sorted(unmapped.items()):
        failures.append("database name %r in a guard (%s) has no map line: add `require`, `cionly` or `known`"
                        % (tok, ", ".join(sorted(files))))
    # PyYAML cross-check, when available
    try:
        import yaml  # noqa: F401
    except ImportError:
        out("check: PyYAML not installed; the YAML subset reader was not cross-checked")
    else:
        for key in WORKFLOWS:
            path = root / WORKFLOWS[key]
            if not path.exists():
                continue
            ours = load_yaml(path)
            theirs = _normalise(yaml.safe_load(path.read_text(encoding="utf-8")))
            if ours != theirs:
                failures.append("the YAML subset reader disagrees with PyYAML on %s: %s"
                                % (WORKFLOWS[key], _first_diff(ours, theirs)))
        out("check: YAML subset reader agrees with PyYAML on both workflow files")
    out("check: %d workflow steps, %d map entries, %d steps need a renamed or CI-only database" % (
        total_steps, len(gmap.requires) + len(gmap.cionly), sum(1 for _ in compute_map(root, gmap))))
    return failures


def _normalise(obj):
    if isinstance(obj, dict):
        return {("on" if k is True else _normalise_key(k)): _normalise(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_normalise(v) for v in obj]
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if isinstance(obj, (int, float)):
        return str(obj)
    return obj


def _normalise_key(k):
    return _normalise(k) if not isinstance(k, str) else k


def _first_diff(a, b, path="$"):
    if type(a) is not type(b):
        return "%s: %r vs %r" % (path, a, b)
    if isinstance(a, dict):
        for k in list(a) + [k for k in b if k not in a]:
            if k not in a or k not in b:
                return "%s.%s missing on one side" % (path, k)
            if a[k] != b[k]:
                return _first_diff(a[k], b[k], "%s.%s" % (path, k))
    if isinstance(a, list):
        if len(a) != len(b):
            return "%s: %d vs %d items" % (path, len(a), len(b))
        for i, (x, y) in enumerate(zip(a, b)):
            if x != y:
                return _first_diff(x, y, "%s[%d]" % (path, i))
    return "%s: %r vs %r" % (path, a, b)


def cmd_check(args):
    failures = check_tree(Path(args.root).resolve())
    for f in failures:
        print("FAIL " + f)
    print("check: %s" % ("FAILED (%d)" % len(failures) if failures else "passed"))
    return 1 if failures else 0


# ---------------------------------------------------------------- self-test

STUB_WORKFLOW = """\
name: Stub full tier
on:
  workflow_dispatch:
  push:
    branches: ['ci-full/**']
env:
  WORKFLOW_LEVEL: wf
jobs:
  stub_job:
    name: Stub job with a service
    timeout-minutes: 5
    defaults:
      run:
        working-directory: backend
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: stub_ci
          POSTGRES_PASSWORD: stub_ci_pw
          POSTGRES_DB: stub_ci
    env:
      JOB_LEVEL: job
      OVERRIDE: from-job
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: npm ci --no-audit --no-fund
      - name: Wait for PostgreSQL to accept connections
        env:
          PGHOST: postgres
          PGPORT: '5432'
        run: node scripts/wait-for-postgres.js
      - name: Bring up the contract database (base schema + migrations)
        run: node scripts/load-base-schema.js && npm run migrate
      - name: Env is mapped to the local database
        env:
          OVERRIDE: from-step
          DB_HOST: postgres
          DB_PORT: '5432'
          DB_NAME: stub_ci
          DB_USER: stub_ci
          DB_PASSWORD: stub_ci_pw
          RELAYHALL_TEST_DB_URL: postgresql://stub_ci:stub_ci_pw@postgres:5432/stub_ci
        run: |
          test "$WORKFLOW_LEVEL" = wf
          test "$JOB_LEVEL" = job
          test "$OVERRIDE" = from-step
          test "$DB_HOST" = 127.0.0.1
          test "$DB_PORT" = 54329
          test "$DB_NAME" = stub_local_test
          test "$DB_USER" = stub_user
          test "$CI" = true
          test -z "${PGSERVICE:-}"
          case "$RELAYHALL_TEST_DB_URL" in postgresql://stub_user:*@127.0.0.1:54329/stub_local_test) ;; *) exit 9;; esac
          echo "the password is $DB_PASSWORD"
          test "$(basename "$PWD")" = backend
      - name: A red step
        run: |
          echo about to fail
          exit 3
      - name: A step after the red one still runs
        working-directory: .
        run: test -f stub-marker && echo receipt > stub-receipt.json
      - name: Guarded suite needs a special database name
        env:
          RELAYHALL_TEST_DB_URL: postgres://stub_ci:stub_ci_pw@postgres:5432/stub_ci
        run: npm run test:special
      - name: CI-only suite
        run: python3 ../scripts/ci-only-thing.py
      - name: Prove a single oracle
        run: node --test ../scripts/oracle.test.mjs
  plain:
    name: No service
    steps:
      - run: echo "${{ secrets.STUB_SECRET }}" | tee "$RUNNER_TEMP/secret-out.txt"
"""

STUB_MAP = """\
default stub_local_test
generic (test|contract|fixture)
require special name=stub_special_test db=stub_special_test sig=stub_special_test
cionly onlyci sig=ONLY_THE_CI_SERVICE note=run it with its own local profile
known relayhall_ci the CI service database
"""


def _stub_repo(base):
    root = Path(base) / "repo"
    (root / ".gitea/workflows").mkdir(parents=True)
    (root / "scripts").mkdir()
    (root / "backend/scripts").mkdir(parents=True)
    (root / "backend/src/__tests__").mkdir(parents=True)
    (root / WORKFLOWS["full"]).write_text(STUB_WORKFLOW, encoding="utf-8")
    (root / WORKFLOWS["fast"]).write_text("name: Stub fast\non:\n  push:\njobs:\n  quick:\n    steps:\n"
                                          "      - run: echo quick\n", encoding="utf-8")
    (root / MAP_FILE).write_text(STUB_MAP, encoding="utf-8")
    (root / "stub-marker").write_text("x\n", encoding="utf-8")
    (root / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
    (root / "backend/package.json").write_text(json.dumps({"scripts": {
        "migrate": "echo migrate", "test:special": "node src/__tests__/special.test.js"}}), encoding="utf-8")
    (root / "backend/src/__tests__/special.test.js").write_text(
        "const db = new URL(process.env.RELAYHALL_TEST_DB_URL).pathname.slice(1);\n"
        "if (db !== 'stub_special_test') { console.error('wrong database ' + db); process.exit(7); }\n",
        encoding="utf-8")
    (root / "scripts/ci-only-thing.py").write_text("# ONLY_THE_CI_SERVICE\n", encoding="utf-8")
    (root / "scripts/oracle.test.mjs").write_text("// oracle\n", encoding="utf-8")
    (root / "backend/scripts/wait-for-postgres.js").write_text("// stub\n", encoding="utf-8")
    (root / "backend/scripts/load-base-schema.js").write_text("// stub\n", encoding="utf-8")
    shutil_which = _which("git")
    if shutil_which:
        g = ["git", "-C", str(root), "-c", "user.name=stub", "-c", "user.email=stub@example.invalid"]
        subprocess.run(g[:3] + ["init", "-q"], check=True)
        subprocess.run(g + ["add", "-A"], check=True)
        subprocess.run(g + ["commit", "-q", "-m", "stub"], check=True)
    return root


def _which(name):
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if os.access(os.path.join(d, name), os.X_OK):
            return True
    return False


def self_test(real_root):
    failures = []
    passed = [0]

    def expect(cond, label):
        if cond:
            passed[0] += 1
        else:
            failures.append(label)

    # 1. the YAML subset reader
    sample = (
        "a: 1\n"
        "b: 'it''s'\n"
        "c: \"x\\ty\"\n"
        "d: [one, 'two', \"three\"]\n"
        "e: plain # comment\n"
        "f: |\n  line one\n  line two\n\n"
        "g: >-\n  --opt a\n  --opt b\n"
        "h:\n  - k: v\n    m: n\n  - just\n  -\n    nested: yes\n"
        "i:\n- same-indent\n"
        "j: ${{ x }}\n"
        "k: a#b\n"
        "l:\n"
        "on:\n  push:\n")
    got = YamlSubset(sample).parse()
    expect(got == {"a": "1", "b": "it's", "c": "x\ty", "d": ["one", "two", "three"], "e": "plain",
                   "f": "line one\nline two\n", "g": "--opt a --opt b",
                   "h": [{"k": "v", "m": "n"}, "just", {"nested": "yes"}], "i": ["same-indent"],
                   "j": "${{ x }}", "k": "a#b", "l": None, "on": {"push": None}},
           "yaml subset reader: %r" % (got,))
    try:
        YamlSubset("a: 1\na: 2\n").parse()
        failures.append("yaml subset reader accepted a duplicate key")
    except CiLocalError:
        passed[0] += 1

    # 2. env rewriting and the loopback rule
    svc = {"user": "u_ci", "password": "p_ci", "db": "d_ci", "port": "5432"}
    db = Database("env", "127.0.0.1", "6000", "lu", "lp", "local_test")
    mapped = []
    expect(rewrite_value("X", "postgres://u_ci:p_ci@postgres:5432/d_ci", {"postgres"}, svc, db, "local_test",
                         mapped) == "postgres://lu:lp@127.0.0.1:6000/local_test", "URL rewrite")
    expect(rewrite_value("X", "postgres://u:p@elsewhere:5432/d", {"postgres"}, svc, db, "n", mapped)
           == "postgres://u:p@elsewhere:5432/d", "a URL on another host is left alone")
    expect(rewrite_value("DB_PORT", "5432", {"postgres"}, svc, db, "n", mapped) == "6000", "port rewrite")
    for bad in ({"RELAYHALL_TEST_DB_URL": "postgres://a:b@db.example.invalid:5432/x_test"},
                {"DB_HOST": "remote.example.invalid", "DB_NAME": "x_test", "DB_USER": "a"}):
        try:
            env_database(bad)
            failures.append("--db env accepted a non-loopback host: %r" % sorted(bad))
        except CiLocalError:
            passed[0] += 1

    # 3. a full run of the stub workflow in env mode (no database is opened)
    with tempfile.TemporaryDirectory(prefix="ci-local-selftest-") as base:
        root = _stub_repo(base)
        out = Path(base) / "out"
        env = dict(os.environ)
        env.update({"RELAYHALL_TEST_DB_URL": "postgresql://stub_user:s3cr3t-stub@127.0.0.1:54329/stub_local_test",
                    "PGSERVICE": "inherited-must-be-scrubbed", "STUB_SECRET": "from-the-caller"})
        me = [sys.executable, str(Path(__file__).resolve()), "--root", str(root)]
        proc = subprocess.run(me + ["run", "--job", "stub_job", "--db", "env", "--out", str(out), "--quiet"],
                              env=env, capture_output=True, text=True)
        expect(proc.returncode == 1, "a run with a red step exits 1 (got %d: %s)" % (proc.returncode, proc.stderr))
        recs = [json.loads(x) for x in (out / "steps.jsonl").read_text().splitlines()] if (
            out / "steps.jsonl").exists() else []
        by_n = {r["n"]: r for r in recs}
        expect(len(recs) == 10, "one record per step (got %d)" % len(recs))
        expect(all(set(("n", "name", "exit", "result", "seconds")) <= set(r) for r in recs), "record fields")
        expect(by_n.get(1, {}).get("result") == "skipped", "uses step skipped")
        expect(by_n.get(5, {}).get("result") == "success", "env mapping step green: %r" % (by_n.get(5),))
        expect(by_n.get(6, {}).get("result") == "failure" and by_n.get(6, {}).get("exit") == 3, "red step exit 3")
        expect(by_n.get(7, {}).get("result") == "success", "never stops early; per-step working-directory")
        expect(by_n.get(8, {}).get("result") == "env-unmet" and "special" in by_n.get(8, {}).get("requires", []),
               "guarded step in env mode with the wrong name is env-unmet, not red for the wrong reason: %r"
               % (by_n.get(8),))
        expect(by_n.get(9, {}).get("result") == "env-unmet", "ci-only step documented")
        expect(by_n.get(10, {}).get("exit") is not None, "the step after the env-unmet ones ran")
        log5 = (out / by_n[5]["log"]).read_text() if 5 in by_n and by_n[5].get("log") else ""
        expect("s3cr3t-stub" not in log5 and "***" in log5, "the password is masked in the log")
        expect("DB_PASSWORD" in by_n.get(5, {}).get("mapped", []), "mapped names recorded")
        summary = json.loads((out / "summary.json").read_text()) if (out / "summary.json").exists() else {}
        expect(len(summary.get("steps", [])) == 10, "summary lists every step")
        expect(by_n.get(7, {}).get("wrote") == ["stub-receipt.json"], "a step's new untracked files are recorded: %r"
               % (by_n.get(7),))
        expect(summary.get("dirty") is False, "the job's own receipts do not make the summary dirty")
        # the right database name lets the guarded step run
        env2 = dict(env, RELAYHALL_TEST_DB_URL="postgresql://stub_user:x@127.0.0.1:54329/stub_special_test")
        out2 = Path(base) / "out2"
        subprocess.run(me + ["run", "--job", "stub_job", "--db", "env", "--out", str(out2), "--quiet",
                             "--from-step", "8"], env=env2, capture_output=True, text=True)
        recs2 = {json.loads(x)["n"]: json.loads(x) for x in (out2 / "steps.jsonl").read_text().splitlines()}
        expect(recs2.get(8, {}).get("result") == "success", "guarded step runs on the admitted name: %r"
               % (recs2.get(8),))
        expect(recs2.get(2, {}).get("result") in ("success", "failure") and recs2.get(3, {}).get("kind") == "db-wait",
               "--from-step still runs the setup steps")
        expect(recs2.get(5, {}).get("result") == "skipped", "--from-step skips earlier steps")
        out3 = Path(base) / "out3"
        subprocess.run(me + ["run", "--job", "stub_job", "--db", "env", "--out", str(out3), "--quiet",
                             "--from-step", "7", "--skip-setup"], env=env, capture_output=True, text=True)
        recs3 = {json.loads(x)["n"]: json.loads(x) for x in (out3 / "steps.jsonl").read_text().splitlines()}
        expect(all(recs3.get(n, {}).get("result") == "skipped" for n in (2, 3, 4)), "--skip-setup skips setup")
        # inherited database variables are scrubbed, expressions expanded from the caller
        out4 = Path(base) / "out4"
        subprocess.run(me + ["run", "--job", "plain", "--out", str(out4), "--quiet"], env=env,
                       capture_output=True, text=True)
        secret_out = out4 / "tmp" / "secret-out.txt"
        expect(secret_out.exists() and secret_out.read_text().strip() == "from-the-caller",
               "secrets.* expressions come from the caller's environment")
        lines4 = (out4 / "steps.jsonl").read_text().splitlines() if (out4 / "steps.jsonl").exists() else []
        rec4 = json.loads(lines4[0]) if lines4 else {}
        log4 = (out4 / rec4["log"]).read_text() if rec4.get("log") else ""
        expect("from-the-caller" not in log4 and "***" in log4, "secrets.* values are masked in the log")
        # plan
        proc = subprocess.run(me + ["plan", "--job", "stub_job", "--out", str(Path(base) / "p"), "--json"],
                              env=env, capture_output=True, text=True)
        expect(proc.returncode != 0 and "dirty" in proc.stderr, "another --out's receipts still count as dirt")
        proc = subprocess.run(me + ["plan", "--job", "stub_job", "--out", str(out), "--json"],
                              env=env, capture_output=True, text=True)
        plan = json.loads(proc.stdout) if proc.returncode == 0 else {}
        steps = plan.get("steps", [])
        expect(plan.get("schema") == PLAN_SCHEMA and steps, "plan --json prints a plan (%s)" % proc.stderr.strip())
        expect(all(set(("name", "heavy", "cmd", "cwd")) <= set(s) for s in steps), "plan entries carry the "
               "scheduler fields")
        expect(all(re.fullmatch(r"[A-Za-z0-9._-]+", s["name"]) for s in steps), "plan names are slugs")
        expect(steps and steps[0]["kind"] == "db-up" and not steps[0]["heavy"], "plan starts with db-up (light)")
        expect(steps and steps[-1]["kind"] == "summary", "plan ends with the summary")
        expect(any(s.get("n") == 10 and not s["heavy"] for s in steps), "a single oracle is light")
        expect(any(s.get("n") == 5 and s["heavy"] for s in steps), "a test step is heavy")
        expect(all(isinstance(s["cmd"], list) and all(isinstance(c, str) for c in s["cmd"]) for s in steps),
               "plan commands are argv lists")
        (root / "dirty").write_text("x")
        proc = subprocess.run(me + ["plan", "--job", "stub_job", "--out", str(out), "--json"],
                              env=env, capture_output=True, text=True)
        expect(proc.returncode != 0 and "dirty" in proc.stderr, "plan refuses a dirty tree")
        # the map and drift check on the stub
        stub_failures = check_tree(root, out=lambda *_: None)
        expect(not stub_failures, "stub map check passes: %r" % stub_failures)
        (root / MAP_FILE).write_text(STUB_MAP + "require gone name=gone_test db=gone_test sig=NOWHERE_AT_ALL\n")
        expect(any("gone" in f for f in check_tree(root, out=lambda *_: None)), "a stale map line is caught")
        (root / MAP_FILE).write_text(STUB_MAP)
        (root / "backend/src/__tests__/special.test.js").write_text(
            "const database = 'stub_other_test'; // hostname guard\n")
        expect(any("stub_other_test" in f for f in check_tree(root, out=lambda *_: None)),
               "an unmapped database-name guard is caught")

    # 4. the real tree
    if (Path(real_root) / WORKFLOWS["full"]).exists() and (Path(real_root) / MAP_FILE).exists():
        real = check_tree(real_root, out=lambda *_: None)
        expect(not real, "real-tree check: %r" % real)
    for f in failures:
        print("FAIL " + f)
    print("self-test: %d passed, %d failed" % (passed[0], len(failures)))
    return 1 if failures else 0


def cmd_self_test(args):
    return self_test(Path(args.root).resolve())


# ---------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(prog="ci-local.py", description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default=str(ROOT), help=argparse.SUPPRESS)
    sub = ap.add_subparsers(dest="cmd")

    def job_args(p):
        p.add_argument("--job", required=True)
        p.add_argument("--workflow", choices=sorted(WORKFLOWS))

    p = sub.add_parser("run", help="run one job's steps")
    job_args(p)
    p.add_argument("--out", required=True)
    p.add_argument("--db", choices=("container", "env"), default="container")
    p.add_argument("--db-state", help=argparse.SUPPRESS)
    p.add_argument("--name-prefix")
    p.add_argument("--from-step", type=int)
    p.add_argument("--only-step", type=int, action="append")
    p.add_argument("--skip-setup", action="store_true")
    p.add_argument("--exit-zero", action="store_true")
    p.add_argument("--fresh-out", action="store_true", help="discard an earlier steps.jsonl in --out")
    p.add_argument("--quiet", action="store_true")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("plan", help="print the job as separately runnable steps")
    job_args(p)
    p.add_argument("--out", required=True)
    p.add_argument("--from-step", type=int)
    p.add_argument("--skip-setup", action="store_true")
    p.add_argument("--name-prefix")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser("db-up", help="start a job database that lives while the calling process lives")
    job_args(p)
    p.add_argument("--db-state", required=True)
    p.add_argument("--db", choices=("container", "env"), default="container")
    p.add_argument("--name-prefix")
    p.add_argument("--watch-pid", type=int)
    p.add_argument("--ttl", type=float, default=240, help="minutes")
    p.set_defaults(func=cmd_db_up)

    p = sub.add_parser("_hold")
    job_args(p)
    p.add_argument("--db-state", required=True)
    p.add_argument("--db", choices=("container", "env"), default="container")
    p.add_argument("--name-prefix")
    p.add_argument("--watch-pid", type=int, required=True)
    p.add_argument("--ttl", type=float, default=240)
    p.set_defaults(func=cmd_hold)

    p = sub.add_parser("db-down", help="remove the job database")
    p.add_argument("--db-state", required=True)
    p.set_defaults(func=cmd_db_down)

    p = sub.add_parser("summary", help="write summary.json from steps.jsonl")
    job_args(p)
    p.add_argument("--out", required=True)
    p.add_argument("--planned", type=int, action="append")
    p.set_defaults(func=cmd_summary)

    sub.add_parser("list", help="list the jobs of both workflows").set_defaults(func=cmd_list)
    p = sub.add_parser("map", help="print the steps whose suites need a special local database")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_map)
    sub.add_parser("check", help="prove the map and the YAML reader against the tree").set_defaults(func=cmd_check)
    sub.add_parser("self-test", help="stub-workflow self-test (no database)").set_defaults(func=cmd_self_test)

    args = ap.parse_args(argv)
    if not args.cmd:
        ap.print_help()
        return 64
    try:
        return args.func(args)
    except CiLocalError as exc:
        print("ci-local: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
