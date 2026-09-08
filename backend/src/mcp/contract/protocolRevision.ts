/**
 * contract/protocolRevision — the EXPECTED released MCP wire revision, the SDK
 * release it is expected to arrive with, and a digest of that release's
 * installed files (Amendment S-A6, MCP design `de73f9f8` §1.2 as amended;
 * owner Rulings 1 and 2 of 2026-08-27; KS-6/KS-7 of 2026-08-29, sitting
 * `d92e756c`).
 *
 * ── Why this file exists at all ──
 *
 * The first draft of S-A6 said the advertised revision should be "supplied by
 * the pinned SDK and asserted, never authored". The red-team (`2b64e315`)
 * showed that premise is structurally false: an SDK bump leaves `mcp/server.ts`
 * untouched, and a test that compares the server to the SDK constant agrees
 * with itself no matter what the constant became. It cannot object. Ruling 1
 * REVERSED that position. §1.2 now requires three INDEPENDENT facts, and an
 * independent fact needs a value that does not move when the SDK moves.
 *
 * Those values live here, and only here. This is a CONTRACT FIXTURE, not a set
 * of knobs: "changing either the SDK major/minor or the expected advertised
 * revision is a reviewed contract change" (§1.2). Editing anything below is
 * the whole of that change's visible surface — which is the point. The gate is
 * `__tests__/c4McpRevisionGate.test.ts`.
 *
 * ── The SDK is TWO packages since v2 (KS-6, card `bec87735`) ──
 *
 * SDK v2 split the monolithic `@modelcontextprotocol/sdk` into a server
 * package and a protocol core. The board depends directly on
 * `@modelcontextprotocol/server`, which pins `@modelcontextprotocol/core` at
 * an EXACT version of its own; the core package is where the protocol code
 * (JSON-RPC framing, the type schemas, the negotiated revision list) actually
 * lives. A digest over the server package alone would leave the protocol
 * implementation unreviewed, so leg (a) of the gate measures BOTH trees, and
 * both digests are recorded here. KS-6 ratified this two-package shape as
 * "the SDK" for the §1.2 dependency budget; `@modelcontextprotocol/client`
 * would need a fresh owner ruling and is deliberately absent.
 *
 * The unreleased `2026-07-28` revision is non-binding direction only (§1.2);
 * no published `@modelcontextprotocol` package negotiates it as its latest, so
 * it may not appear here.
 */

/** The released, implementable wire revision this surface speaks. */
export const EXPECTED_MCP_PROTOCOL_REVISION = '2025-11-25';

/** The exact SDK release expected to carry it (owner Ruling 2: exactly pinned). */
export const EXPECTED_MCP_SDK_VERSION = '2.0.0';

/**
 * A digest of the SDK's INSTALLED FILES — sorted relative paths, each folded
 * in with its own sha256 — for each of the two packages.
 *
 * npm's lock `integrity` hashes the registry TARBALL, and an extracted tree
 * cannot be hashed back into it; comparing the two lockfiles only compares two
 * metadata records to each other. Round-2 verdict `7c2d4dbb` B4 proved that
 * gap by editing the installed SDK's `initialize` implementation, leaving
 * every metadata field untouched, and watching the gate stay green.
 *
 * These values are what the files on disk actually are. Two independent
 * `npm ci` runs of the same tarballs produce them identically (recorded in the
 * migration evidence); any changed byte in any file of either package changes
 * its digest. A different SDK release therefore cannot carry these values
 * forward — which is exactly the reviewed contract change §1.2 asks for.
 *
 * The digest REFUSES a tree that contains anything other than directories and
 * regular files (card `dd6be92c`): a symlink under the package can point the
 * hash at bytes that are not the package's own, so it is a violation in its
 * own right rather than an entry to skip.
 */
export const EXPECTED_MCP_SDK_CONTENT_DIGEST =
  'sha256-b4f5ab94370f42427ecc0af62cd6a4bd3e2cfd9620427e542a4c49fd14c454ab';

export const EXPECTED_MCP_CORE_CONTENT_DIGEST =
  'sha256-f52c2deeb30c85ad355f0c37c47e5c8cd9502768ad6c05bf1e7b323e56b4769a';

/** The direct dependency the gate resolves in both lockfiles. */
export const MCP_SDK_PACKAGE = '@modelcontextprotocol/server';

/**
 * The protocol package the direct dependency pins exactly. Not declared by
 * the board itself — the gate asserts that the INSTALLED server package
 * declares it at exactly `EXPECTED_MCP_SDK_VERSION`, so a server patch that
 * loosened its own pin could not float the protocol code past this fixture.
 */
export const MCP_CORE_PACKAGE = '@modelcontextprotocol/core';

/** Their keys in `package-lock.json` and in npm's installed-tree lockfile. */
export const MCP_SDK_LOCK_KEY = `node_modules/${MCP_SDK_PACKAGE}`;
export const MCP_CORE_LOCK_KEY = `node_modules/${MCP_CORE_PACKAGE}`;
