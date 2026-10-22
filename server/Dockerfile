# Routini API and worker (same image; the worker runs `node dist/worker.js`),
# and the credential broker (`--target egress`, published as
# ghcr.io/nvasion/routini-egress by .github/workflows/images.yml).
#
# `runtime` stays the last stage on purpose: a plain `docker build ./server`
# (docker-compose.yml) must keep producing the API/worker image.

# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime base ──────────────────────────────────────────────────────────────
# Everything the roles share; each stage below adds only its ports and command.
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# Embedded Postgres data lives here when DATABASE_URL is not set; the egress
# proxy persists its CA here too (ROUTINI_EGRESS_CA_DIR).
RUN mkdir -p /app/data && chown node:node /app/data
ENV ROUTINI_DATA_DIR=/app/data/pg
USER node
# No image HEALTHCHECK: this image runs as the API (:3001), the worker (no
# port) and the credential broker (:3129), so each deployment checks its own
# role (docker-compose.yml, App Platform's health_check, the agents host).

# ── Credential broker (--target egress) ───────────────────────────────────────
# The proxy (3128) and its control API (3129). Fleet hosts pull this image to
# give agent containers their only way out (ROUTINI_FLEET_EGRESS_IMAGE).
FROM base AS egress
# Fleet hosts (routini-runner) mount the CA volume here (ROUTINI_EGRESS_CA_DIR).
# It must exist and belong to `node` in the image: Docker gives a new (or
# empty) named volume the ownership of the image directory it is mounted on,
# and a root-owned one makes the proxy die with EACCES writing ca-key.pem.
USER root
RUN mkdir -p /var/lib/routini-egress && chown node:node /var/lib/routini-egress
USER node
EXPOSE 3128 3129
CMD ["node", "dist/egress.js"]

# ── API and worker (default target) ───────────────────────────────────────────
FROM base AS runtime
EXPOSE 3001
CMD ["node", "dist/index.js"]
