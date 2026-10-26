# Node is an exact patched release pinned by digest (CVE-2026-111497);
# scripts/check-node-base-images.py refuses a floating or older Node image.
FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS builder

WORKDIR /app

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_LOGLEVEL=error

# Copy package files
COPY package*.json ./

# Install all dependencies (needed for build)
RUN npm install --silent --no-fund --no-audit --loglevel=error

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production image
FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# Minimal runtime support. Core does not mount harness environments or run
# workspace/image tooling.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev --silent --no-fund --no-audit --loglevel=error

# Copy built files from builder
COPY --from=builder /app/dist ./dist
# Copy migrations (SQL files, not compiled)
COPY --from=builder /app/src/migrations ./dist/migrations
# Copy runtime scripts used by npm smoke/ops commands
COPY --from=builder /app/scripts ./scripts

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
COPY start.sh /start.sh
RUN chmod 0755 /entrypoint.sh /start.sh \
    && chmod -R a+rX /app/dist/migrations /app/scripts

# Default PUID/PGID — override in docker-compose to match host file owner
ENV PUID=1002
ENV PGID=1002

# Immutable release provenance: baked into the image at build time so runtime
# verification never depends on mounted git metadata. Args are supplied by the
# exact-main deploy wrapper; defaults make ad-hoc builds self-identify as such.
# The release version (docs/build-identity.md) is supplied by the release
# tooling as 1.0.0-beta.<N>; empty marks an unreleased build. It is recorded in
# the manifest only - the server reads that file, never its environment. The
# writer fails the build on a malformed version, and JSON.stringify keeps any
# argument value from breaking the document.
ARG RELEASE_SHA=unknown
ARG RELEASE_DIRTY=unknown
ARG RELEASE_BUILD_CONTEXT=unknown
ARG RELEASE_BUILT_AT=unknown
ARG RELAYHALL_RELEASE_VERSION=
LABEL org.opencontainers.image.revision=$RELEASE_SHA
LABEL org.opencontainers.image.source="https://github.com/relayhall/relayhall"
LABEL org.opencontainers.image.version=$RELAYHALL_RELEASE_VERSION
LABEL org.relayhall.dirty=$RELEASE_DIRTY
LABEL org.relayhall.build-context=$RELEASE_BUILD_CONTEXT
RUN node /app/scripts/write-release-manifest.cjs relayhall-backend /app/package.json /release-manifest.json

# Expose port
EXPOSE 3001

# Use entrypoint for PUID/PGID handling
ENTRYPOINT ["/entrypoint.sh"]
# A container boot is an upgrade boundary: apply active forward migrations and
# fail closed before opening the API listener.
CMD ["/start.sh"]
