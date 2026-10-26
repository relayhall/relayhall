# Build identity and the release version

The About page (`/dashboard/about`) shows what is actually deployed: for the
frontend and for the backend, the version, the commit, whether the tree was
dirty, the build context and the build time. Every one of those facts is read
from a record the image wrote about itself when it was built. None of them
comes from a constant in the bundle, a mounted checkout or the runtime
environment.

## Where each fact comes from

Each image writes `/release-manifest.json` during `docker build`, using the
committed writer `scripts/write-release-manifest.cjs` (one byte-identical copy
per service directory, because each build context sees only its own
directory). The writer serialises with `JSON.stringify`, so no argument value
can break the document.

| Image | Manifest | Served as |
|---|---|---|
| frontend | `/release-manifest.json` and the web root | `GET /release-manifest.json` (no-store) |
| backend | `/release-manifest.json` in the image root | the `build` object of `GET /api/` (no-store) |

The backend reads its file once, at start, bounded to 16 KiB, and projects
it onto the six fields below. Nothing else in the file is ever echoed.

| Field | Build argument | Shown as |
|---|---|---|
| `service` | (fixed by the Dockerfile) | which artefact the record belongs to |
| `version` | `RELAYHALL_RELEASE_VERSION` | Version (frontend) and API version (backend) |
| `sha` | `RELEASE_SHA` | Build SHA: 40 lowercase hex characters |
| `dirty` | `RELEASE_DIRTY` | Dirty: `true` or `false` |
| `buildContext` | `RELEASE_BUILD_CONTEXT` | Build context: for example the sha256 of `git archive` |
| `builtAt` | `RELEASE_BUILT_AT` | Built at: RFC 3339, shown as stamped |

## The release-version build argument

`RELAYHALL_RELEASE_VERSION` is a Docker build argument, passed with the SAME
value to both image builds. Docker Compose forwards it as
`RELAYHALL_RELEASE_VERSION: ${RELAYHALL_RELEASE_VERSION:-}` for both services.

- **Release policy.** Every release has a version of the form
  `1.0.0-beta.<N>`, where `<N>` counts the releases: release N is
  `1.0.0-beta.N`, and that is the version the release reports. The release
  build step passes it as `RELAYHALL_RELEASE_VERSION`; the version is not read
  from `package.json` at run time.
- **What the writer accepts.** A SemVer 2.0.0 version without build metadata
  (`+` is reserved, see below), at most 64 characters. A value that is set but
  does not match FAILS the image build, so a malformed version cannot ship.
  The tooling should check the stricter policy pattern
  `^1\.0\.0-beta\.[1-9][0-9]*$` before it builds.
- **Unset or empty.** The build is not a release. The writer records
  `<package.json version>+unreleased`, today `1.0.0-beta.102+unreleased`, and
  About labels it "unreleased build". A bare package version is never shown
  as a deployed version.
- **Build time only.** The value reaches the manifests and, in the frontend
  builder stage only, `VITE_RELAYHALL_RELEASE_VERSION` for the sign-in footer.
  Neither image carries it as runtime environment, and the backend never reads
  its environment for a version: an identity a process can be handed at
  runtime is not a record of what was built.
- **Image label.** Both images also carry it as
  `org.opencontainers.image.version` (empty for an unreleased build).

### Where the version surfaces

| Surface | Value |
|---|---|
| `GET /release-manifest.json` | `version` of the frontend image |
| `GET /api/` | `version`, and `build.version`, of the backend image |
| `GET /openapi.json` | `info.version`, the backend version |
| MCP `initialize` | `serverInfo.version`, the backend version |
| About | Version = frontend manifest; API version = `GET /api/` |
| Sign-in footer | `v` + the version the bundle was built as |

Example, for the release build `1.0.0-beta.19`:

```json
{"service":"relayhall-frontend","version":"1.0.0-beta.19","sha":"<40 hex>","dirty":"false","buildContext":"<sha256>","builtAt":"2026-10-11T01:23:45Z"}
```

```json
{"name":"RelayHall API","version":"1.0.0-beta.19","build":{"service":"relayhall-backend","version":"1.0.0-beta.19","sha":"<40 hex>","dirty":"false","buildContext":"<sha256>","builtAt":"2026-10-11T01:23:45Z"},"environment":"production","status":"running"}
```

`build` is `null` when the backend image recorded no identity.

## The release step that sets the version

The release tooling's build step passes the version with the other provenance
arguments, to both builds:

```bash
VERSION=1.0.0-beta.19   # release 19
docker build \
  --build-arg RELEASE_SHA="$(git rev-parse HEAD)" \
  --build-arg RELEASE_DIRTY=false \
  --build-arg RELEASE_BUILD_CONTEXT="$(git archive HEAD | sha256sum | cut -d' ' -f1)" \
  --build-arg RELEASE_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg RELAYHALL_RELEASE_VERSION="$VERSION" \
  backend/   # and the same arguments for frontend/
```

After the deploy, the read-back should confirm that `/release-manifest.json`
`version` and `GET /api/` `version` both equal the version passed, that
`GET /api/` `build.sha` equals the commit, and that `builtAt` parses.

## How About reads the facts

- **Field by field.** One field that is missing, still `unknown` (the
  Dockerfile default for an argument that was not passed), or in a shape the
  reader rejects is shown as Unavailable on its own. It never blanks the
  other fields or hides the panel.
- **builtAt** is accepted as RFC 3339 with `Z` or a numeric offset and a
  fraction of any length, so both `date -u +%Y-%m-%dT%H:%M:%SZ` and Python's
  `datetime.isoformat()` (`+00:00` with microseconds) are shown. The basic
  form `20260904T230148Z` is not RFC 3339 and reads Unavailable. Prefer the
  `Z` form at the source.
- **dirty** shows `true` or `false`; any other value is Unavailable.
- **Conflicts are shown, not merged.** When both artefacts report a version or
  a commit and they differ, About says which facts differ. This is expected
  for a moment during a rollout and after rolling back only one image.
- **Unreachable sources.** If the manifest or the API root cannot be fetched,
  an alert names it and offers Retry, which fetches every source again. When
  everything was fetched but some fields are unavailable, a notice offers the
  same Retry.

## Older images and rollbacks

An image built before this record existed has no `version` in its frontend
manifest and no `build` in its API root. About then shows those fields as
Unavailable, keeps every other fact, and shows the API version the older code
reported. A conflict note appears when the two sides then disagree.

## What this does not claim

The record says what each image was built from. It does not prove the two
images were built together, and a commit SHA is not a promise that a public
commit page exists. The public repository links on About are fixed in
the dashboard source and shown in every build; they are not part of the build
identity.
