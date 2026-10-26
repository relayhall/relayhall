#!/usr/bin/env python3
"""Fresh-install contract: setup.sh provisions the backend's key sets, names the
public address, and points an operator who keeps .env at the real next step.

The backend reads four key sets from its environment (credential envelope,
telemetry pepper, knowledge handle, knowledge assertion). A fresh install that
lacks them answers its first credential issue with an error, refuses telemetry
and fails knowledge search. This suite runs setup.sh non-interactively in a
temporary directory, exactly as an operator would, and proves:

  * a fresh run generates all four sets in the formats the parsers accept
    (backend/src/utils/credentialCrypto.ts, utils/telemetryPepper.ts,
    services/KnowledgeHandleSealer.ts, services/KnowledgeAssertionSigner.ts),
    into relayhall.keys.env, mode 600, and prints no value;
  * a re-run, with or without reconfiguring, leaves every key byte-identical;
  * an install from before the key sets gets them by re-running setup.sh;
  * a value supplied another way (an override's environment entry, an
    override's env_file, the shell, or a complete pair set in .env) is kept,
    and an incomplete pair or a value an override blanks is refused;
  * relayhall.config.json is readable by the backend's runtime user;
  * the real `docker compose config` passes every key to the backend, and a
    deployment without relayhall.keys.env renders exactly the environment it
    rendered before the forward existed;
  * keeping .env (the upgrade path) ends with the real next step, a rebuild
    and `up -d --wait`, never a bare `docker compose up -d`, which would
    restart the old images without migrating;
  * the public address: setup.sh asks the scheme and port people's browsers
    use (default http and the frontend port), writes CORS_ORIGIN from them,
    and for https also RELAYHALL_PUBLIC_API_URL, which Compose passes to the
    backend; the default port of a scheme is left out of the origin, as a
    browser leaves it out of its Origin header;
  * Compose forwards RELAYHALL_PUBLIC_API_URL (empty) and TRUST_PROXY_HOPS (1,
    the backend's own default) when they are unset, and an operator's values
    when they are set;

Needs the docker CLI with the compose plugin (no daemon: `compose config` is
client-side) and OpenSSL. Only `docker run`, which setup.sh uses to hash the
dashboard password, is answered by a stand-in, with output of the real
bcryptjs shape (`$2b$10$` and 53 characters, 60 in all).

`--self-proof` applies one mutant at a time to a copy of the tree and requires
the checks that guard it to go red: regenerate on re-run, a missing forward,
the forward written as `environment:` names (which erases an operator's
env_file), a wrong key format, an unreadable config file, a printed value,
ignoring a value supplied elsewhere, discarding a value set in .env, a bare
`up -d` on the keep branch, an https answer that writes no public URL, a CORS
origin that ignores the scheme, a missing public-URL forward, an empty
TRUST_PROXY_HOPS default and a private default build.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FILES = ('setup.sh', '.env.example', 'relayhall.config.example.json',
         'docker-compose.yml', 'relayhall.plugins.json')
SETS = (
    ('RELAYHALL_CREDENTIAL_KEYS', 'RELAYHALL_CREDENTIAL_ACTIVE_KEY', 'random32'),
    ('RELAYHALL_TELEMETRY_PEPPERS', 'RELAYHALL_TELEMETRY_ACTIVE_PEPPER', 'random32'),
    ('RELAYHALL_KNOWLEDGE_HANDLE_KEYS', 'RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY', 'random32'),
    ('RELAYHALL_KNOWLEDGE_ASSERTION_KEYS', 'RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY', 'ed25519'),
)
NAMES = tuple(name for pair in SETS for name in pair[:2])
KEYS_FILE = 'relayhall.keys.env'
# The fixed PKCS#8 prefix of an Ed25519 private key (RFC 8410): 16 bytes, then
# the 32-byte seed.
ED25519_PKCS8_PREFIX = bytes.fromhex('302e020100300506032b657004220420')
# Shape of the real hasher's output (bcryptjs, cost 10), recorded from a real
# setup.sh run; the characters are invented.
STAND_IN_HASH = '$2b$10$' + ('InventedStandInBcryptOutput' * 2)[:53]
assert len(STAND_IN_HASH) == 60
# Host name, generate the database password, dashboard password, frontend
# port, public scheme, public port.
FRESH_ANSWERS = '\n\ninvented-dashboard-password\n58084\n\n\n'
KEEP_ANSWERS = 'no\n'
RECONFIGURE_ANSWERS = 'yes\n' + FRESH_ANSWERS
INVENTED_HOST = 'board.example.test'
HTTPS_ANSWERS = f'{INVENTED_HOST}\n\ninvented-dashboard-password\n58084\nhttps\n8443\n'
HTTPS_DEFAULT_PORT_ANSWERS = f'{INVENTED_HOST}\n\ninvented-dashboard-password\n58084\nhttps\n\n'
HTTP_HOST_ANSWERS = f'{INVENTED_HOST}\n\ninvented-dashboard-password\n58084\n\n\n'
ANSI = re.compile(r'\x1b\[[0-9;]*m')


class Red(Exception):
    pass


def real_docker():
    docker = shutil.which('docker')
    if not docker:
        raise SystemExit('test-first-install: the docker CLI (with compose) is required')
    return docker


class Project:
    """One install directory, set up from a source tree, with a docker shim."""

    def __init__(self, source, base):
        self.dir = Path(tempfile.mkdtemp(prefix='install-', dir=base))
        for name in FILES:
            shutil.copy2(source / name, self.dir / name)
        (self.dir / 'setup.sh').chmod(0o755)
        self.bin = self.dir.parent / (self.dir.name + '-bin')
        self.bin.mkdir()
        shim = self.bin / 'docker'
        shim.write_text(
            '#!/bin/sh\n'
            'if [ "${1:-}" = run ]; then printf \'%s\\n\' "$STAND_IN_HASH"; exit 0; fi\n'
            'exec "$REAL_DOCKER" "$@"\n')
        shim.chmod(0o755)

    def env(self, extra=None):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(('RELAYHALL_', 'COMPOSE_', 'DB_', 'POSTGRES_'))}
        env.update(PATH=f'{self.bin}{os.pathsep}{env.get("PATH", "")}',
                   REAL_DOCKER=real_docker(), STAND_IN_HASH=STAND_IN_HASH)
        env.update(extra or {})
        return env

    def setup(self, answers, extra_env=None):
        run = subprocess.run(['bash', './setup.sh'], cwd=self.dir, input=answers,
                             capture_output=True, text=True, env=self.env(extra_env), timeout=300)
        return run.returncode, run.stdout + run.stderr

    def service(self, name, extra_env=None):
        run = subprocess.run([real_docker(), 'compose', 'config', '--format', 'json', name],
                             cwd=self.dir, capture_output=True, text=True, env=self.env(extra_env), timeout=120)
        if run.returncode != 0:
            raise Red('docker compose config failed: ' + run.stderr.strip()[:400])
        return json.loads(run.stdout)['services'][name]

    def render(self, extra_env=None):
        return self.service('relayhall-backend', extra_env).get('environment') or {}

    def path(self, name):
        return self.dir / name

    def digest(self, name):
        return hashlib.sha256(self.path(name).read_bytes()).hexdigest()


def dotenv(path):
    """Parse the subset of dotenv syntax setup.sh writes (last assignment wins)."""
    values = {}
    for line in Path(path).read_text().splitlines():
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.removeprefix('export ')
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    return values


def b64(text):
    try:
        return base64.b64decode(text, validate=True)
    except Exception as error:
        raise Red(f'not strict base64: {error}')


def check_set_format(values, keys_name, active_name, kind):
    if keys_name not in values or active_name not in values:
        raise Red(f'{keys_name} / {active_name} missing')
    try:
        keyset = json.loads(values[keys_name])
    except ValueError:
        raise Red(f'{keys_name} is not JSON')
    if not isinstance(keyset, dict) or len(keyset) != 1:
        raise Red(f'{keys_name} must be a JSON object with one key')
    active = values[active_name]
    if active not in keyset:
        raise Red(f'{active_name} names no entry of {keys_name}')
    if not re.fullmatch(r'[a-z]+-[0-9]{8}', active):
        raise Red(f'{active_name} is not a plain key id')
    raw = b64(keyset[active])
    if kind == 'random32':
        if len(raw) != 32:
            raise Red(f'{keys_name} entry decodes to {len(raw)} bytes, not 32')
        return
    if len(raw) != 48 or not raw.startswith(ED25519_PKCS8_PREFIX):
        raise Red(f'{keys_name} entry is not an Ed25519 PKCS#8 DER key')
    with tempfile.NamedTemporaryFile(suffix='.der') as der:
        der.write(raw)
        der.flush()
        probe = subprocess.run(['openssl', 'pkey', '-inform', 'DER', '-in', der.name, '-noout', '-text'],
                               capture_output=True, text=True)
    if probe.returncode != 0 or 'ED25519' not in (probe.stdout + probe.stderr).upper():
        raise Red(f'{keys_name} entry is not accepted by OpenSSL as an Ed25519 private key')


def key_values(project):
    return dotenv(project.path(KEYS_FILE))


def need(condition, message):
    if not condition:
        raise Red(message)


def fresh(source, base):
    project = Project(source, base)
    rc, out = project.setup(FRESH_ANSWERS)
    need(rc == 0, f'fresh setup.sh exited {rc}: {out[-600:]}')
    need(project.path(KEYS_FILE).exists(), 'fresh setup.sh wrote no relayhall.keys.env')
    return project, out


def materials(values):
    found = []
    for keys_name, _, _ in SETS:
        try:
            found.extend(json.loads(values.get(keys_name, '{}')).values())
        except ValueError:
            pass
    return [value for value in found if value]


# ---- checks -----------------------------------------------------------------

def check_fresh_formats(source, base):
    project, _ = fresh(source, base)
    mode = stat.S_IMODE(project.path(KEYS_FILE).stat().st_mode)
    need(mode == 0o600, f'relayhall.keys.env is mode {mode:o}, not 600')
    values = key_values(project)
    for keys_name, active_name, kind in SETS:
        check_set_format(values, keys_name, active_name, kind)
    need(len(set(materials(values))) == len(SETS), 'two key sets share one key')


def check_no_value_printed(source, base):
    project, out = fresh(source, base)
    rc, again = project.setup(KEEP_ANSWERS)
    need(rc == 0, f'keep re-run exited {rc}')
    secrets = materials(key_values(project))
    need(len(secrets) == len(SETS), 'expected one key per set')
    for value in secrets:
        need(value not in out + again and value[:16] not in out + again,
             'setup.sh printed a key value')


def check_config_readable(source, base):
    project, _ = fresh(source, base)
    mode = stat.S_IMODE(project.path('relayhall.config.json').stat().st_mode)
    need(mode == 0o644, f'relayhall.config.json is mode {mode:o}, not 644')
    # An install made by the earlier setup.sh (mode 600) is repaired by a re-run.
    project.path('relayhall.config.json').chmod(0o600)
    rc, _ = project.setup(KEEP_ANSWERS)
    need(rc == 0, f'keep re-run exited {rc}')
    mode = stat.S_IMODE(project.path('relayhall.config.json').stat().st_mode)
    need(mode & stat.S_IROTH, f'a re-run left relayhall.config.json at mode {mode:o}')


def check_compose_forwards(source, base):
    # Through the real Compose, independent of setup.sh's own read-back: a
    # keys file of invented values must reach the backend exactly as written.
    project = Project(source, base)
    shutil.copy2(source / '.env.example', project.path('.env'))
    shutil.copy2(source / 'relayhall.config.example.json', project.path('relayhall.config.json'))
    lines = []
    for index, (keys_name, active_name, _) in enumerate(SETS):
        key = base64.b64encode(bytes([index]) * 32).decode()
        lines += [f"{keys_name}='{{\"invented-2026010{index}\":\"{key}\"}}'",
                  f'{active_name}=invented-2026010{index}']
    project.path(KEYS_FILE).write_text(''.join(line + '\n' for line in lines))
    values = key_values(project)
    rendered = project.render()
    for name in NAMES:
        need(rendered.get(name) == values.get(name),
             f'docker compose config does not pass {name} to the backend as written')
    # And a fresh install's own file, end to end.
    project, _ = fresh(source, base)
    values = key_values(project)
    rendered = project.render()
    for name in NAMES:
        need(rendered.get(name) == values.get(name), f'a fresh install does not pass {name} to the backend')


def check_unset_environment_unchanged(source, base):
    project = Project(source, base)
    shutil.copy2(source / '.env.example', project.path('.env'))
    shutil.copy2(source / 'relayhall.config.example.json', project.path('relayhall.config.json'))
    rendered = project.render()
    for name in NAMES:
        need(name not in rendered, f'without relayhall.keys.env the backend still receives {name}')
    # The same tree with the forward taken out is the environment before it.
    compose = project.path('docker-compose.yml').read_text()
    block = re.search(r'\n    env_file:\n      - path: \./relayhall\.keys\.env\n        required: false\n', compose)
    need(block is not None, 'the optional relayhall.keys.env env_file entry is not in docker-compose.yml')
    project.path('docker-compose.yml').write_text(compose[:block.start()] + '\n' + compose[block.end():])
    need(project.render() == rendered, 'the forward changed the environment of a deployment without the file')


def check_rerun_keeps_keys(source, base):
    project, _ = fresh(source, base)
    before = (project.digest(KEYS_FILE), project.digest('.env'))
    rc, out = project.setup(KEEP_ANSWERS)
    need(rc == 0, f'keep re-run exited {rc}: {out[-400:]}')
    need((project.digest(KEYS_FILE), project.digest('.env')) == before,
         're-running setup.sh changed relayhall.keys.env or .env')
    keys = project.digest(KEYS_FILE)
    rc, out = project.setup(RECONFIGURE_ANSWERS)
    need(rc == 0, f'reconfigure re-run exited {rc}: {out[-400:]}')
    need(project.digest(KEYS_FILE) == keys, 'reconfiguring changed relayhall.keys.env')


def check_upgrade_generates(source, base):
    project, _ = fresh(source, base)
    project.path(KEYS_FILE).unlink()          # an install from before the key sets
    env_before = project.digest('.env')
    rc, out = project.setup(KEEP_ANSWERS)
    need(rc == 0, f'upgrade re-run exited {rc}: {out[-400:]}')
    values = key_values(project)
    for keys_name, active_name, kind in SETS:
        check_set_format(values, keys_name, active_name, kind)
    need(project.digest('.env') == env_before, 'the upgrade re-run changed .env')


def write_override(project, text):
    project.path('docker-compose.override.yml').write_text(text)


INVENTED_CREDENTIAL = '{"operator-20260101":"' + base64.b64encode(bytes(range(32))).decode() + '"}'


def legacy_install(source, base):
    """A finished install with no relayhall.keys.env (made before the key sets)."""
    project, _ = fresh(source, base)
    project.path(KEYS_FILE).unlink()
    return project


def check_env_file_supply_kept(source, base):
    project = legacy_install(source, base)
    project.path('operator-keys.env').write_text(
        f"RELAYHALL_CREDENTIAL_KEYS='{INVENTED_CREDENTIAL}'\nRELAYHALL_CREDENTIAL_ACTIVE_KEY=operator-20260101\n")
    write_override(project, 'services:\n  relayhall-backend:\n    env_file: operator-keys.env\n')
    rc, out = project.setup(KEEP_ANSWERS)
    need(rc == 0, f're-run with an operator env_file exited {rc}: {out[-400:]}')
    values = key_values(project)
    need('RELAYHALL_CREDENTIAL_KEYS' not in values, 'setup.sh generated a set the operator env_file supplies')
    rendered = project.render()
    need(rendered.get('RELAYHALL_CREDENTIAL_KEYS') == INVENTED_CREDENTIAL
         and rendered.get('RELAYHALL_CREDENTIAL_ACTIVE_KEY') == 'operator-20260101',
         "the operator env_file's credential keys no longer reach the backend")
    for keys_name, active_name, kind in SETS[1:]:
        check_set_format(values, keys_name, active_name, kind)
        need(rendered.get(keys_name) == values[keys_name], f'{keys_name} does not reach the backend')


def check_override_environment_kept(source, base):
    # The shape a manual install used before setup.sh made the keys: values in
    # .env, passed on by an override file's environment entries.
    project = legacy_install(source, base)
    with project.path('.env').open('a') as env:
        env.write(f"RELAYHALL_CREDENTIAL_KEYS='{INVENTED_CREDENTIAL}'\nRELAYHALL_CREDENTIAL_ACTIVE_KEY=operator-20260101\n")
    write_override(project, 'services:\n  relayhall-backend:\n    environment:\n'
                            '      RELAYHALL_CREDENTIAL_KEYS: ${RELAYHALL_CREDENTIAL_KEYS:-}\n'
                            '      RELAYHALL_CREDENTIAL_ACTIVE_KEY: ${RELAYHALL_CREDENTIAL_ACTIVE_KEY:-}\n')
    env_before = project.digest('.env')
    rc, out = project.setup(KEEP_ANSWERS)
    need(rc == 0, f're-run with an override environment exited {rc}: {out[-400:]}')
    need('RELAYHALL_CREDENTIAL_KEYS' not in key_values(project),
         'setup.sh generated a set the override already supplies')
    need(project.render().get('RELAYHALL_CREDENTIAL_KEYS') == INVENTED_CREDENTIAL,
         "the override's credential keys no longer reach the backend")
    need(project.digest('.env') == env_before, 'the re-run changed .env')


def check_shell_supply_kept(source, base):
    project = legacy_install(source, base)
    write_override(project, 'services:\n  relayhall-backend:\n    environment:\n'
                            '      RELAYHALL_TELEMETRY_PEPPERS: ${RELAYHALL_TELEMETRY_PEPPERS:-}\n'
                            '      RELAYHALL_TELEMETRY_ACTIVE_PEPPER: ${RELAYHALL_TELEMETRY_ACTIVE_PEPPER:-}\n')
    shell = {'RELAYHALL_TELEMETRY_PEPPERS': INVENTED_CREDENTIAL,
             'RELAYHALL_TELEMETRY_ACTIVE_PEPPER': 'operator-20260101'}
    rc, out = project.setup(KEEP_ANSWERS, shell)
    need(rc == 0, f're-run with shell-supplied peppers exited {rc}: {out[-400:]}')
    need('RELAYHALL_TELEMETRY_PEPPERS' not in key_values(project),
         'setup.sh generated a set the shell supplies')


def check_env_values_reused(source, base):
    project = legacy_install(source, base)
    raw = f"'{INVENTED_CREDENTIAL}'"
    with project.path('.env').open('a') as env:
        env.write(f'RELAYHALL_KNOWLEDGE_HANDLE_KEYS={raw}\nRELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY=operator-20260101\n')
    rc, out = project.setup(KEEP_ANSWERS)
    need(rc == 0, f're-run with keys in .env exited {rc}: {out[-400:]}')
    text = project.path(KEYS_FILE).read_text()
    need(f'RELAYHALL_KNOWLEDGE_HANDLE_KEYS={raw}\n' in text
         and 'RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY=operator-20260101\n' in text,
         'a complete pair set in .env was not kept byte for byte')
    need(project.render().get('RELAYHALL_KNOWLEDGE_HANDLE_KEYS') == INVENTED_CREDENTIAL,
         'the kept handle keys do not reach the backend')


def check_partial_and_shadowed_refused(source, base):
    project = legacy_install(source, base)
    with project.path('.env').open('a') as env:
        env.write(f"RELAYHALL_CREDENTIAL_KEYS='{INVENTED_CREDENTIAL}'\n")
    rc, out = project.setup(KEEP_ANSWERS)
    need(rc != 0, 'setup.sh accepted half a credential key pair')
    need('RELAYHALL_CREDENTIAL_KEYS' not in key_values(project), 'setup.sh completed a half pair on its own')
    # An override that blanks a key the file provides must fail, not pass.
    project = legacy_install(source, base)
    write_override(project, 'services:\n  relayhall-backend:\n    environment:\n'
                            '      RELAYHALL_KNOWLEDGE_ASSERTION_KEYS: ${RELAYHALL_KNOWLEDGE_ASSERTION_KEYS:-}\n')
    rc, out = project.setup(KEEP_ANSWERS)
    need(rc != 0, 'setup.sh reported success while an override blanks a key it wrote')
    need('RELAYHALL_KNOWLEDGE_ASSERTION_KEYS' in out, 'the refusal does not name the blanked key')
    for value in materials(key_values(project)):
        need(value not in out, 'the refusal printed a key value')


def plain(text):
    return ANSI.sub('', text)


def check_keep_branch_next_step(source, base):
    project, _ = fresh(source, base)
    rc, out = project.setup(KEEP_ANSWERS)
    need(rc == 0, f'keep re-run exited {rc}: {out[-400:]}')
    out = plain(out)
    need('docker compose build --pull' in out,
         'keeping .env does not tell the operator to rebuild the images (docker compose build --pull)')
    need('docker compose up -d --wait' in out, 'keeping .env does not name docker compose up -d --wait')
    need(out.index('docker compose build --pull') < out.index('docker compose up -d --wait'),
         'the keep branch names the start before the rebuild')
    need(not re.search(r'^\s*docker compose up -d\s*$', out, re.M),
         'keeping .env still offers a bare `docker compose up -d`, which restarts the old images unmigrated')
    need('DEPLOYMENT.md' in out, 'keeping .env does not point to the upgrade steps in DEPLOYMENT.md')


def check_public_address(source, base):
    # Defaults: this machine, http, the frontend port.
    project, out = fresh(source, base)
    values = dotenv(project.path('.env'))
    need(values.get('CORS_ORIGIN') == 'http://localhost:58084',
         f"the default CORS_ORIGIN is {values.get('CORS_ORIGIN')!r}, not http://localhost:58084")
    need(values.get('RELAYHALL_PUBLIC_API_URL', '') == '', 'an http install declares a public API URL')
    need('DOMAIN' not in values, 'setup.sh still writes DOMAIN, which nothing reads')
    need(project.render().get('RELAYHALL_PUBLIC_API_URL', '') == '', 'an http install passes a public API URL')
    need('needs HTTPS or localhost' not in plain(out), 'a localhost install is warned about HTTPS')
    # Behind a TLS proxy on its own port.
    project = Project(source, base)
    rc, out = project.setup(HTTPS_ANSWERS)
    need(rc == 0, f'an https setup exited {rc}: {out[-400:]}')
    values = dotenv(project.path('.env'))
    origin = f'https://{INVENTED_HOST}:8443'
    need(values.get('CORS_ORIGIN') == origin, f"CORS_ORIGIN is {values.get('CORS_ORIGIN')!r}, not {origin}")
    need(values.get('RELAYHALL_PUBLIC_API_URL') == origin + '/api',
         f"RELAYHALL_PUBLIC_API_URL is {values.get('RELAYHALL_PUBLIC_API_URL')!r}, not {origin}/api")
    rendered = project.render()
    need(rendered.get('RELAYHALL_PUBLIC_API_URL') == origin + '/api',
         'Compose does not pass the public API URL to the backend')
    need(rendered.get('CORS_ORIGIN') == origin, 'Compose does not pass the https CORS origin to the backend')
    need(values.get('FRONTEND_PORT') == '58084', 'the public port replaced the frontend port')
    # The scheme's default port is left out, as the browser leaves it out of Origin.
    project = Project(source, base)
    rc, out = project.setup(HTTPS_DEFAULT_PORT_ANSWERS)
    need(rc == 0, f'an https setup on the default port exited {rc}: {out[-400:]}')
    values = dotenv(project.path('.env'))
    need(values.get('CORS_ORIGIN') == f'https://{INVENTED_HOST}',
         f"on port 443 CORS_ORIGIN is {values.get('CORS_ORIGIN')!r}")
    need(values.get('RELAYHALL_PUBLIC_API_URL') == f'https://{INVENTED_HOST}/api',
         f"on port 443 RELAYHALL_PUBLIC_API_URL is {values.get('RELAYHALL_PUBLIC_API_URL')!r}")
    # Plain http at a host name works for health checks only: the operator is told before the first run.
    project = Project(source, base)
    rc, out = project.setup(HTTP_HOST_ANSWERS)
    need(rc == 0, f'an http host-name setup exited {rc}: {out[-400:]}')
    need(dotenv(project.path('.env')).get('CORS_ORIGIN') == f'http://{INVENTED_HOST}:58084',
         'an http host-name install has the wrong CORS_ORIGIN')
    need('needs HTTPS or localhost' in plain(out), 'an http host-name install is not warned that sign-in needs HTTPS')
    # A scheme that is neither is refused, not written.
    project = Project(source, base)
    rc, out = project.setup(f'{INVENTED_HOST}\n\ninvented-dashboard-password\n58084\nftp\n\n')
    need(rc != 0, 'setup.sh accepted the scheme ftp')
    need('ftp://' not in project.path('.env').read_text() if project.path('.env').exists() else True,
         'setup.sh wrote an ftp origin')


def check_proxy_settings_forwarded(source, base):
    project = Project(source, base)
    shutil.copy2(source / '.env.example', project.path('.env'))
    shutil.copy2(source / 'relayhall.config.example.json', project.path('relayhall.config.json'))
    rendered = project.render()
    # Unset is today's behaviour: an empty public URL is no declaration (every
    # reader treats '' as unset), and 1 is the backend's own trust-proxy default.
    need(rendered.get('RELAYHALL_PUBLIC_API_URL') == '',
         f"unset, RELAYHALL_PUBLIC_API_URL renders {rendered.get('RELAYHALL_PUBLIC_API_URL')!r}, not ''")
    need(rendered.get('TRUST_PROXY_HOPS') == '1',
         f"unset, TRUST_PROXY_HOPS renders {rendered.get('TRUST_PROXY_HOPS')!r}, not '1'")
    with project.path('.env').open('a') as env:
        env.write(f'RELAYHALL_PUBLIC_API_URL=https://{INVENTED_HOST}/api\nTRUST_PROXY_HOPS=2\n')
    rendered = project.render()
    need(rendered.get('RELAYHALL_PUBLIC_API_URL') == f'https://{INVENTED_HOST}/api',
         "an operator's RELAYHALL_PUBLIC_API_URL does not reach the backend")
    need(rendered.get('TRUST_PROXY_HOPS') == '2', "an operator's TRUST_PROXY_HOPS does not reach the backend")


CHECKS = {
    'fresh-formats': check_fresh_formats,
    'no-value-printed': check_no_value_printed,
    'config-readable': check_config_readable,
    'compose-forwards': check_compose_forwards,
    'unset-environment-unchanged': check_unset_environment_unchanged,
    'rerun-keeps-keys': check_rerun_keeps_keys,
    'upgrade-generates': check_upgrade_generates,
    'env-file-supply-kept': check_env_file_supply_kept,
    'override-environment-kept': check_override_environment_kept,
    'shell-supply-kept': check_shell_supply_kept,
    'env-values-reused': check_env_values_reused,
    'partial-and-shadowed-refused': check_partial_and_shadowed_refused,
    'keep-branch-next-step': check_keep_branch_next_step,
    'public-address': check_public_address,
    'proxy-settings-forwarded': check_proxy_settings_forwarded,
}


def run_checks(source, names):
    failures = {}
    with tempfile.TemporaryDirectory(prefix='first-install-') as base:
        for name in names:
            try:
                CHECKS[name](source, Path(base))
            except Red as error:
                failures[name] = str(error)
            except subprocess.TimeoutExpired:
                failures[name] = 'timed out'
    return failures


# ---- mutants -----------------------------------------------------------------

ENV_FILE_BLOCK = '    env_file:\n      - path: ./relayhall.keys.env\n        required: false\n'
BARE_FORWARD = ''.join(f'      {name}:\n' for name in NAMES)
MUTANTS = [
    ('regenerate on re-run', 'setup.sh', [
        ('if rendered_has "$render" "$kset" && rendered_has "$render" "$active"; then', 'if false; then'),
        ('if env_file_value "$KEYS_FILE" "$kset" >/dev/null || env_file_value "$KEYS_FILE" "$active" >/dev/null; then',
         'if false; then'),
        ('if rendered_has "$render" "$kset" || rendered_has "$render" "$active"; then', 'if false; then')],
     {'rerun-keeps-keys'}),
    ('missing forward', 'docker-compose.yml', [(ENV_FILE_BLOCK, '')],
     {'compose-forwards'}),
    ('forward as environment names', 'docker-compose.yml', [
        (ENV_FILE_BLOCK, ''),
        ('      NODE_OPTIONS: "--max-old-space-size=512"\n',
         '      NODE_OPTIONS: "--max-old-space-size=512"\n' + BARE_FORWARD)],
     {'env-file-supply-kept', 'unset-environment-unchanged'}),
    ('wrong key format: X25519 for Ed25519', 'setup.sh', [
        ('openssl genpkey -algorithm ed25519 -outform DER', 'openssl genpkey -algorithm x25519 -outform DER'),
        ("grep -Eq '^MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/]{43}$'", "grep -Eq '^MC4CAQAwBQYDK2VuBCIEI[A-Za-z0-9+/]{43}$'")],
     {'fresh-formats'}),
    ('wrong key format: active id names no key', 'setup.sh', [
        ('"$kset" "$id" "$material" "$active" "$id"', '"$kset" "$id" "$material" "$active" "x$id"')],
     {'fresh-formats'}),
    ('config unreadable', 'setup.sh', [
        ('if chmod a+r relayhall.config.json; then', 'if chmod u+r relayhall.config.json; then')],
     {'config-readable'}),
    ('value printed', 'setup.sh', [
        ('echo -e "${GREEN}   ✅ $kset: generated${NC}"', 'echo -e "${GREEN}   ✅ $kset: generated ($material)${NC}"'),
        ('        material=\n        echo -e', '        echo -e')],
     {'no-value-printed'}),
    ('ignores a value supplied elsewhere', 'setup.sh', [
        ('if rendered_has "$render" "$kset" && rendered_has "$render" "$active"; then', 'if false; then'),
        ('if rendered_has "$render" "$kset" || rendered_has "$render" "$active"; then', 'if false; then')],
     {'env-file-supply-kept', 'override-environment-kept', 'shell-supply-kept'}),
    ('discards a value set in .env', 'setup.sh', [
        ('if env_set=$(env_file_value .env "$kset") && env_active=$(env_file_value .env "$active"); then',
         'if false; then'),
        ('if env_file_value .env "$kset" >/dev/null || env_file_value .env "$active" >/dev/null; then',
         'if false; then')],
     {'env-values-reused'}),
    ('keep branch offers a bare up -d', 'setup.sh', [
        ('''        echo -e "${GREEN}Key sets are in place; .env was kept unchanged.${NC}"
        echo "Continue with the upgrade steps in DEPLOYMENT.md, or build and start:"
        echo -e "  ${PURPLE}docker compose build --pull${NC}"
        echo -e "  ${PURPLE}docker compose up -d --wait${NC}"
''', '''        echo -e "${GREEN}Setup complete! Run:${NC}"
        echo -e "  ${PURPLE}docker compose up -d${NC}"
''')],
     {'keep-branch-next-step'}),
    ('https writes no public API URL', 'setup.sh', [
        ('''    sed -i.bak "s|^RELAYHALL_PUBLIC_API_URL=.*|RELAYHALL_PUBLIC_API_URL=$PUBLIC_ORIGIN/api|" .env
''', '''    :
''')],
     {'public-address'}),
    ('CORS origin ignores the scheme', 'setup.sh', [
        ('''sed -i.bak "s|^CORS_ORIGIN=.*|CORS_ORIGIN=$PUBLIC_ORIGIN|" .env''',
         '''sed -i.bak "s|^CORS_ORIGIN=.*|CORS_ORIGIN=http://$DOMAIN:$FRONTEND_PORT|" .env''')],
     {'public-address'}),
    ('the public API URL is not forwarded', 'docker-compose.yml', [
        ('''      RELAYHALL_PUBLIC_API_URL: ${RELAYHALL_PUBLIC_API_URL:-}
''', '')],
     {'public-address', 'proxy-settings-forwarded'}),
    ('TRUST_PROXY_HOPS forwarded empty when unset', 'docker-compose.yml', [
        ('TRUST_PROXY_HOPS: ${TRUST_PROXY_HOPS:-1}', 'TRUST_PROXY_HOPS: ${TRUST_PROXY_HOPS:-}')],
     {'proxy-settings-forwarded'}),
]


def self_proof():
    problems = []
    for label, target, edits, guards in MUTANTS:
        with tempfile.TemporaryDirectory(prefix='first-install-mutant-') as tree:
            tree = Path(tree)
            for name in FILES:
                shutil.copy2(REPO / name, tree / name)
            text = (tree / target).read_text()
            for old, new in edits:
                if text.count(old) != 1:
                    problems.append(f'{label}: anchor found {text.count(old)} times in {target}: {old[:60]!r}')
                    break
                text = text.replace(old, new)
            else:
                (tree / target).write_text(text)
                failures = run_checks(tree, sorted(guards))
                red = sorted(set(failures) & guards)
                if not red:
                    problems.append(f'{label}: survived {sorted(guards)}')
                else:
                    print(f'mutant red: {label} -> ' + '; '.join(f'{name}: {failures[name][:160]}' for name in red))
    if problems:
        print('first-install self-proof FAILED:\n  ' + '\n  '.join(problems), file=sys.stderr)
        return 1
    print(f'first-install self-proof passed ({len(MUTANTS)} mutants, each red)')
    return 0


def main(argv):
    if argv[1:] == ['--self-proof']:
        return self_proof()
    if argv[1:]:
        names = argv[1:]
        unknown = [name for name in names if name not in CHECKS]
        if unknown:
            raise SystemExit(f'unknown check(s): {unknown}; known: {sorted(CHECKS)}')
    else:
        names = list(CHECKS)
    failures = run_checks(REPO, names)
    for name in names:
        print(f'{name}={"FAIL: " + failures[name] if name in failures else "pass"}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
