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

# Install dependencies
RUN npm install --silent --no-fund --no-audit --loglevel=error

# Copy source code
COPY . .

# The browser talks to nginx on the same origin. nginx proxies `/api` and `/ws`
# to the backend service, so no backend host port or deployment domain is baked
# into the image.
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
# The release version (docs/build-identity.md): supplied by the release
# tooling as 1.0.0-beta.<N>; empty marks an unreleased build. The bundle reads
# it for the sign-in footer; the manifest below records it for About.
ARG RELAYHALL_RELEASE_VERSION=
ENV VITE_RELAYHALL_RELEASE_VERSION=$RELAYHALL_RELEASE_VERSION

# Build app
RUN npm run build

# Immutable release provenance: baked into the image at build time so runtime
# verification never depends on mounted git metadata. Args are supplied by the
# exact-main deploy wrapper; defaults make ad-hoc builds self-identify as such.
# Declared after the bundle build so a new commit or timestamp does not
# invalidate the cached bundle layer. The writer serialises with
# JSON.stringify and fails the build on a malformed release version.
ARG RELEASE_SHA=unknown
ARG RELEASE_DIRTY=unknown
ARG RELEASE_BUILD_CONTEXT=unknown
ARG RELEASE_BUILT_AT=unknown
RUN node scripts/write-release-manifest.cjs relayhall-frontend package.json /app/release-manifest.json

# Production image with nginx
FROM nginx:alpine

# Copy built files from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# The same provenance as image labels, and the manifest the builder wrote:
# at the image root and in the web root, where /release-manifest.json is served.
ARG RELEASE_SHA=unknown
ARG RELEASE_DIRTY=unknown
ARG RELEASE_BUILD_CONTEXT=unknown
ARG RELAYHALL_RELEASE_VERSION=
LABEL org.opencontainers.image.revision=$RELEASE_SHA
LABEL org.opencontainers.image.source="https://github.com/relayhall/relayhall"
LABEL org.opencontainers.image.version=$RELAYHALL_RELEASE_VERSION
LABEL org.relayhall.dirty=$RELEASE_DIRTY
LABEL org.relayhall.build-context=$RELEASE_BUILD_CONTEXT
COPY --from=builder /app/release-manifest.json /release-manifest.json
COPY --from=builder /app/release-manifest.json /usr/share/nginx/html/release-manifest.json

# Expose port
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
