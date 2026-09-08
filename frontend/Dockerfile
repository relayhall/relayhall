FROM node:20-alpine AS builder

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
ARG VITE_PUBLIC_BUILD=false
ENV VITE_PUBLIC_BUILD=$VITE_PUBLIC_BUILD

# Build app
RUN npm run build

# Production image with nginx
FROM nginx:alpine

# Copy built files from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Immutable release provenance: baked into the image at build time so runtime
# verification never depends on mounted git metadata. Args are supplied by the
# exact-main deploy wrapper; defaults make ad-hoc builds self-identify as such.
ARG RELEASE_SHA=unknown
ARG RELEASE_DIRTY=unknown
ARG RELEASE_BUILD_CONTEXT=unknown
ARG RELEASE_BUILT_AT=unknown
LABEL org.opencontainers.image.revision=$RELEASE_SHA
LABEL org.opencontainers.image.source="https://github.com/relayhall/relayhall"
LABEL org.relayhall.dirty=$RELEASE_DIRTY
LABEL org.relayhall.build-context=$RELEASE_BUILD_CONTEXT
RUN printf '{"service":"relayhall-frontend","sha":"%s","dirty":"%s","buildContext":"%s","builtAt":"%s"}\n' \
    "$RELEASE_SHA" "$RELEASE_DIRTY" "$RELEASE_BUILD_CONTEXT" "$RELEASE_BUILT_AT" \
    | tee /release-manifest.json > /usr/share/nginx/html/release-manifest.json

# Expose port
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
