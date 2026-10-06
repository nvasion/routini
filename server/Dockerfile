# Routini API and worker (same image; the worker runs `node dist/worker.js`).

# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# Embedded Postgres data lives here when DATABASE_URL is not set.
RUN mkdir -p /app/data && chown node:node /app/data
ENV ROUTINI_DATA_DIR=/app/data/pg
EXPOSE 3001
USER node
# No image HEALTHCHECK: this image runs as the API (:3001), the worker (no
# port) and the credential broker (:3129), so each deployment checks its own
# role (docker-compose.yml, App Platform's health_check, the agents host).
CMD ["node", "dist/index.js"]
