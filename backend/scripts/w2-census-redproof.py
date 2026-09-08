#!/usr/bin/env python3
"""Red proof for the T-SS13 census ratchet: introduce the exact read it exists
to forbid, require it to fail by name, restore byte-verified, require green."""
import hashlib
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
TARGET = BACKEND / "src/services/identity/SsoAuthenticationService.ts"
TEST = "src/__tests__/ssoHeaderCensus.test.ts"

ANCHOR = "    const redirectUri = ssoRedirectUri();"
MUTANT = (
    "    const redirectUri = ssoRedirectUri();\n"
    "    // MUTATION: the read T-SS13 forbids.\n"
    "    const _steer = (globalThis as unknown as { req: { headers: Record<string, string> } })"
    ".req.headers['x-forwarded-host'];"
)


def run_census():
    proc = subprocess.run(
        ["npx", "jest", "--runInBand", TEST],
        cwd=str(BACKEND), capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


original = TARGET.read_bytes()
digest = hashlib.sha256(original).hexdigest()
text = original.decode()
if text.count(ANCHOR) != 1:
    sys.exit(f"anchor occurs {text.count(ANCHOR)} times, expected 1")

code, out = run_census()
if code != 0:
    sys.exit(f"census not green before the mutation:\n{out[-1500:]}")
print("  pre-mutation: census GREEN")

try:
    TARGET.write_text(text.replace(ANCHOR, MUTANT))
    code, out = run_census()
finally:
    TARGET.write_bytes(original)

if hashlib.sha256(TARGET.read_bytes()).hexdigest() != digest:
    sys.exit("restore not byte-identical")
print("  restore: byte-verified")

if code == 0:
    sys.exit("FAIL: the census stayed GREEN with an x-forwarded-host read present")
if "x-forwarded-host" not in out:
    sys.exit(f"FAIL: census failed but did not name the header:\n{out[-1500:]}")
print("  mutation: census RED, naming x-forwarded-host")

code, out = run_census()
if code != 0:
    sys.exit(f"census not green after restore:\n{out[-1500:]}")
print("  post-restore: census GREEN")
print("RED PROOF PROVEN: the T-SS13 census catches a new host-header read")
