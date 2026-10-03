# syntax=docker/dockerfile:1
# SPORE backend monorepo (Robinhood Chain, chain id 4663)
# Build context: backend/   |   File: backend/docker/Dockerfile
# Build a service:  docker build -f docker/Dockerfile --target <indexer|api|score-engine|oracle-publisher> .
# Note: keep node_modules/ and dist/ in backend/.dockerignore so COPY . . never clobbers the install.

# ---------------------------------------------------------------------------
# deps: full install (incl. devDependencies such as typescript) for compiling
# ---------------------------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY common/package.json common/tsconfig.json ./common/
COPY indexer/package.json indexer/tsconfig.json ./indexer/
COPY api/package.json api/tsconfig.json ./api/
COPY score-engine/package.json score-engine/tsconfig.json ./score-engine/
COPY oracle-publisher/package.json oracle-publisher/tsconfig.json ./oracle-publisher/

# Root package.json holds the runtime deps, so include the workspace root too.
RUN npm ci --workspaces --include-workspace-root

# ---------------------------------------------------------------------------
# builder: compile every workspace (tsc -p tsconfig.json -> dist/)
# ---------------------------------------------------------------------------
FROM deps AS builder
COPY . .
RUN npm run build --workspaces

# ---------------------------------------------------------------------------
# indexer
# ---------------------------------------------------------------------------
FROM node:20-slim AS indexer
RUN groupadd --gid 10001 spore \
 && useradd --uid 10001 --gid spore --no-create-home --shell /usr/sbin/nologin spore
WORKDIR /app

COPY package.json package-lock.json ./
COPY common/package.json ./common/
COPY indexer/package.json ./indexer/
COPY api/package.json ./api/
COPY score-engine/package.json ./score-engine/
COPY oracle-publisher/package.json ./oracle-publisher/

# Production-only node_modules (workspace symlinks, e.g. @spore/common, are preserved)
RUN npm ci --workspaces --include-workspace-root --omit=dev \
 && npm cache clean --force

# All workspace dist trees (common is imported by the services via workspace symlinks)
COPY --from=builder --chown=spore:spore /app/common/dist ./common/dist
COPY --from=builder --chown=spore:spore /app/indexer/dist ./indexer/dist
COPY --from=builder --chown=spore:spore /app/api/dist ./api/dist
COPY --from=builder --chown=spore:spore /app/score-engine/dist ./score-engine/dist
COPY --from=builder --chown=spore:spore /app/oracle-publisher/dist ./oracle-publisher/dist

WORKDIR /app/indexer
USER spore
ENV NODE_ENV=production

# No HEALTHCHECK: the indexer exposes no HTTP endpoint. Liveness is handled by
# compose `restart: unless-stopped` and the service's own crash-on-fatal-error behavior.
CMD ["node", "dist/index.js"]

# ---------------------------------------------------------------------------
# api
# ---------------------------------------------------------------------------
FROM node:20-slim AS api
RUN groupadd --gid 10001 spore \
 && useradd --uid 10001 --gid spore --no-create-home --shell /usr/sbin/nologin spore
WORKDIR /app

COPY package.json package-lock.json ./
COPY common/package.json ./common/
COPY indexer/package.json ./indexer/
COPY api/package.json ./api/
COPY score-engine/package.json ./score-engine/
COPY oracle-publisher/package.json ./oracle-publisher/

RUN npm ci --workspaces --include-workspace-root --omit=dev \
 && npm cache clean --force

COPY --from=builder --chown=spore:spore /app/common/dist ./common/dist
COPY --from=builder --chown=spore:spore /app/indexer/dist ./indexer/dist
COPY --from=builder --chown=spore:spore /app/api/dist ./api/dist
COPY --from=builder --chown=spore:spore /app/score-engine/dist ./score-engine/dist
COPY --from=builder --chown=spore:spore /app/oracle-publisher/dist ./oracle-publisher/dist

WORKDIR /app/api
USER spore
ENV NODE_ENV=production

EXPOSE 3001

# node:20-slim has no curl, so use node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

# ---------------------------------------------------------------------------
# score-engine
# ---------------------------------------------------------------------------
FROM node:20-slim AS score-engine
RUN groupadd --gid 10001 spore \
 && useradd --uid 10001 --gid spore --no-create-home --shell /usr/sbin/nologin spore
WORKDIR /app

COPY package.json package-lock.json ./
COPY common/package.json ./common/
COPY indexer/package.json ./indexer/
COPY api/package.json ./api/
COPY score-engine/package.json ./score-engine/
COPY oracle-publisher/package.json ./oracle-publisher/

RUN npm ci --workspaces --include-workspace-root --omit=dev \
 && npm cache clean --force

COPY --from=builder --chown=spore:spore /app/common/dist ./common/dist
COPY --from=builder --chown=spore:spore /app/indexer/dist ./indexer/dist
COPY --from=builder --chown=spore:spore /app/api/dist ./api/dist
COPY --from=builder --chown=spore:spore /app/score-engine/dist ./score-engine/dist
COPY --from=builder --chown=spore:spore /app/oracle-publisher/dist ./oracle-publisher/dist

WORKDIR /app/score-engine
USER spore
ENV NODE_ENV=production

# No HEALTHCHECK: the score engine exposes no HTTP endpoint. Liveness is handled by
# compose `restart: unless-stopped` and the service's own crash-on-fatal-error behavior.
CMD ["node", "dist/index.js"]

# ---------------------------------------------------------------------------
# oracle-publisher
# ---------------------------------------------------------------------------
FROM node:20-slim AS oracle-publisher
RUN groupadd --gid 10001 spore \
 && useradd --uid 10001 --gid spore --no-create-home --shell /usr/sbin/nologin spore
WORKDIR /app

COPY package.json package-lock.json ./
COPY common/package.json ./common/
COPY indexer/package.json ./indexer/
COPY api/package.json ./api/
COPY score-engine/package.json ./score-engine/
COPY oracle-publisher/package.json ./oracle-publisher/

RUN npm ci --workspaces --include-workspace-root --omit=dev \
 && npm cache clean --force

COPY --from=builder --chown=spore:spore /app/common/dist ./common/dist
COPY --from=builder --chown=spore:spore /app/indexer/dist ./indexer/dist
COPY --from=builder --chown=spore:spore /app/api/dist ./api/dist
COPY --from=builder --chown=spore:spore /app/score-engine/dist ./score-engine/dist
COPY --from=builder --chown=spore:spore /app/oracle-publisher/dist ./oracle-publisher/dist

WORKDIR /app/oracle-publisher
USER spore
ENV NODE_ENV=production

# No HEALTHCHECK: the oracle publisher exposes no HTTP endpoint. Liveness is handled by
# compose `restart: unless-stopped` and the service's own crash-on-fatal-error behavior.
CMD ["node", "dist/index.js"]
