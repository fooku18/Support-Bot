# syntax=docker/dockerfile:1
# Native application targets: native-answer and adapter.
# Existing external infrastructure targets: admin, egress, cli-runtime.
# Test target: model-stub (test:stack:up --model-mode stub only).
# All dependencies are locked; no credentials enter images.

# Node 26.13.1, Debian 12 (bookworm) slim, pinned to the linux/amd64 manifest.
FROM node:26.13.1-bookworm-slim@sha256:18a166e2d50578afe933434857ed2d9059bd1aa398a223e9c89eb4302354f079 AS base

# Marks every Support Agent image, prod and test, for deploy/docker/docker-gc.sh,
# which removes them once they are dangling (untagged). Every target must
# derive from base to carry it; an image without it is never cleaned.
LABEL org.support-agent.image=1

# --------------------------------------------------------------------------
# Shared build stage for the adapter and runner TypeScript packages.
# --------------------------------------------------------------------------
FROM base AS workspace-manifests
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/agent/package.json ./apps/agent/package.json
COPY apps/slack/package.json ./apps/slack/package.json
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/egress/package.json ./apps/egress/package.json
COPY apps/tool-runtime/package.json ./apps/tool-runtime/package.json
COPY apps/model-stub/package.json ./apps/model-stub/package.json

FROM workspace-manifests AS node-build

# --------------------------------------------------------------------------
# adapter: authenticated native Socket Mode transport.
# --------------------------------------------------------------------------
FROM node-build AS adapter-build
RUN --mount=type=cache,target=/root/.npm npm ci --workspace @support-agent/slack --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY apps/slack/tsconfig.json ./apps/slack/
COPY apps/slack/src ./apps/slack/src
COPY apps/slack/scripts ./apps/slack/scripts
RUN npm run build --workspace @support-agent/slack

FROM workspace-manifests AS adapter-deps
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace @support-agent/slack --include-workspace-root=false --ignore-scripts --no-audit --no-fund

FROM base AS adapter
ENV NODE_ENV=production
WORKDIR /app
COPY --from=adapter-deps /build/node_modules ./node_modules
COPY --from=adapter-deps /build/apps/slack ./apps/slack
COPY --from=adapter-build /build/apps/slack/dist/index.js ./apps/slack/dist/index.js
USER node
ENTRYPOINT ["node", "apps/slack/dist/index.js"]

# --------------------------------------------------------------------------
# egress: per-instance CONNECT proxy, the only container with a route out.
# No runtime dependencies, no credentials.
# --------------------------------------------------------------------------
FROM node-build AS egress-build
RUN --mount=type=cache,target=/root/.npm npm ci --workspace @support-agent/egress --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY apps/egress/tsconfig.json ./apps/egress/
COPY apps/egress/src ./apps/egress/src
RUN npm run build --workspace @support-agent/egress

FROM base AS egress
ENV NODE_ENV=production
WORKDIR /app
COPY apps/egress/package.json ./apps/egress/package.json
COPY --from=egress-build /build/apps/egress/dist ./apps/egress/dist
USER node
ENTRYPOINT ["node", "apps/egress/dist/index.js"]

# --------------------------------------------------------------------------
# model-stub: scripted Messages API for the stub model mode. Test only; no
# runtime dependencies, no credentials, no route out.
# --------------------------------------------------------------------------
FROM node-build AS model-stub-build
RUN --mount=type=cache,target=/root/.npm npm ci --workspace @support-agent/model-stub --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY apps/model-stub/tsconfig.json apps/model-stub/tsconfig.build.json ./apps/model-stub/
COPY apps/model-stub/src ./apps/model-stub/src
RUN npm run build --workspace @support-agent/model-stub

FROM base AS model-stub
ENV NODE_ENV=production
WORKDIR /app
COPY apps/model-stub/package.json ./apps/model-stub/package.json
COPY --from=model-stub-build /build/apps/model-stub/dist ./apps/model-stub/dist
USER node
ENTRYPOINT ["node", "apps/model-stub/dist/index.js"]

# --------------------------------------------------------------------------
# admin: admin UI, Slack workspace pairing and the compiled configuration.
# Runtime dependencies:
# undici (outbound Slack calls through the egress proxy) and ws (the
# authenticated /live WebSocket of the realtime admin views);
# pg connects to production PostgreSQL; local SQLite uses node:sqlite.
# --------------------------------------------------------------------------
FROM node-build AS admin-build
RUN --mount=type=cache,target=/root/.npm npm ci --workspace @support-agent/admin --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY apps/admin/tsconfig.json ./apps/admin/
COPY apps/admin/src ./apps/admin/src
RUN npm run build --workspace @support-agent/admin

FROM workspace-manifests AS admin-deps
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace @support-agent/admin --include-workspace-root=false --ignore-scripts --no-audit --no-fund

FROM base AS admin
ENV NODE_ENV=production
WORKDIR /app
COPY --from=admin-deps /build/node_modules ./node_modules
COPY --from=admin-deps /build/apps/admin ./apps/admin
COPY --from=admin-build /build/apps/admin/dist ./apps/admin/dist
# The admin-store volume takes this directory's ownership on first use.
RUN mkdir -p /var/lib/support-agent-admin && chown node:node /var/lib/support-agent-admin
USER node
ENTRYPOINT ["node", "apps/admin/dist/index.js"]

# --------------------------------------------------------------------------
# Shared domain-tool build; no execution owner entrypoint.
# --------------------------------------------------------------------------
FROM node-build AS tools-build
RUN --mount=type=cache,target=/root/.npm npm ci --workspace @support-agent/tool-runtime --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY apps/tool-runtime ./apps/tool-runtime
COPY apps/agent/src ./apps/agent/src
COPY apps/agent/tsconfig.json ./apps/agent/
RUN npm run build --workspace @support-agent/tool-runtime

FROM workspace-manifests AS tools-deps
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace @support-agent/tool-runtime --include-workspace-root=false --ignore-scripts --no-audit --no-fund

# --------------------------------------------------------------------------
# cli-runtime: the isolated, credential-scoped tool runtime. Every service is
# reached over HTTPS from Node. Controller/Slack/Gateway credentials never enter this image.
# --------------------------------------------------------------------------
FROM base AS cli-runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=tools-deps /build/node_modules ./node_modules
COPY --from=tools-deps /build/apps/tool-runtime ./apps/tool-runtime
COPY --from=tools-build /build/apps/tool-runtime/dist ./apps/tool-runtime/dist
USER node
ENTRYPOINT ["node", "apps/tool-runtime/dist/cli-runtime-service.js", "--serve"]

# Native application build inputs. Framework state is owned by Mastra.
FROM node-build AS agent-source
RUN --mount=type=cache,target=/root/.npm npm ci --workspace @support-agent/agent --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY apps/agent ./apps/agent
# Production dependencies are projected from the same root workspace lock.
FROM workspace-manifests AS agent-deps
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace @support-agent/agent --include-workspace-root=false --ignore-scripts --no-audit --no-fund
# Code Mode runs in isolated-vm, a native addon. Its package ships prebuilt
# binaries per Node ABI and platform, so install scripts stay off and no
# compiler enters any stage. Keep only the binary for this image's Node and
# architecture; the build fails if there is none or it cannot run a script.
RUN set -eux; \
    ivm=node_modules/isolated-vm; \
    addon="$(node -p "require('node-gyp-build').resolve('$ivm')")"; \
    mv "$addon" /tmp/isolated-vm.node; \
    rm -rf "$ivm/prebuilds" "$ivm/src" "$ivm/vendor" "$ivm/native-example" "$ivm"/*.tgz; \
    mkdir -p "$(dirname "$addon")"; \
    mv /tmp/isolated-vm.node "$addon"; \
    NODE_OPTIONS=--no-node-snapshot node -e " \
      const ivm = require('isolated-vm'); \
      const context = new ivm.Isolate({ memoryLimit: 8 }).createContextSync(); \
      if (context.evalSync('6 * 7') !== 42) process.exit(1); \
    "

# build the shared agent. The lean image is for isolated fixtures.
FROM agent-source AS native-answer-build
RUN npm run build:native --workspace @support-agent/agent

FROM base AS native-answer
ENV NODE_ENV=production
# isolated-vm (Code Mode) crashes on Node 20+ without this flag.
ENV NODE_OPTIONS=--no-node-snapshot
WORKDIR /app
COPY --from=agent-deps /build/node_modules ./node_modules
COPY --from=agent-deps /build/apps/agent ./apps/agent
COPY --from=native-answer-build /build/apps/agent/dist/native ./apps/agent/dist/native
COPY --chmod=755 deploy/docker/native-answer-entrypoint.sh /usr/local/bin/
USER node
ENTRYPOINT ["/usr/local/bin/native-answer-entrypoint.sh"]

# Install the four runtime workspaces together so npm resolves hoisting and
# workspace-local dependency versions consistently.
FROM workspace-manifests AS runtime-deps
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --include-workspace-root=false --ignore-scripts --no-audit --no-fund \
    --workspace @support-agent/agent --workspace @support-agent/admin \
    --workspace @support-agent/slack --workspace @support-agent/tool-runtime \
    && rm -rf node_modules/isolated-vm

FROM base AS runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS=--no-node-snapshot
WORKDIR /app
COPY --from=runtime-deps /build/node_modules ./node_modules
COPY --from=agent-deps /build/node_modules/isolated-vm ./node_modules/isolated-vm
COPY --from=runtime-deps /build/apps/agent ./apps/agent
COPY --from=runtime-deps /build/apps/admin ./apps/admin
COPY --from=runtime-deps /build/apps/slack ./apps/slack
COPY --from=runtime-deps /build/apps/tool-runtime ./apps/tool-runtime
COPY --from=native-answer-build /build/apps/agent/dist/native ./apps/agent/dist/native
COPY --from=admin-build /build/apps/admin/dist ./apps/admin/dist
COPY --from=adapter-build /build/apps/slack/dist ./apps/slack/dist
COPY --from=tools-build /build/apps/tool-runtime/dist ./apps/tool-runtime/dist
COPY --chmod=755 deploy/docker/support-agent /usr/local/bin/support-agent
RUN install -d -o node -g node /var/lib/support-agent-admin
USER node
ENTRYPOINT ["/usr/local/bin/support-agent"]

# Deployed image with the isolated Workspace and trusted Git publication adapter.
FROM base AS native-coding-os
RUN apt-get update && apt-get install -y --no-install-recommends git bubblewrap ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/native-coding

FROM native-coding-os AS native-coding
ENV NODE_ENV=production
# isolated-vm (Code Mode) crashes on Node 20+ without this flag.
ENV NODE_OPTIONS=--no-node-snapshot
WORKDIR /app
COPY --from=agent-deps /build/node_modules ./node_modules
COPY --from=agent-deps /build/apps/agent ./apps/agent
COPY --from=native-answer-build /build/apps/agent/dist/native ./apps/agent/dist/native
COPY --chmod=755 deploy/docker/native-answer-entrypoint.sh /usr/local/bin/
COPY --chmod=755 deploy/docker/native-bwrap.sh /usr/local/bin/bwrap
ENTRYPOINT ["/usr/local/bin/native-answer-entrypoint.sh"]
