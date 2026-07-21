# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install all dependencies (devDependencies are needed for tsc)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: production runtime ───────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Install only production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

# Rebuild native bindings for better-sqlite3 (its install script was skipped
# above by --ignore-scripts) and create the persistent data directory used
# for the SQLite database file, owned by the non-root "node" user the
# container runs as.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm rebuild better-sqlite3 \
    && apk del .build-deps \
    && mkdir -p /app/data \
    && chown -R node:node /app/data

EXPOSE 3001

# Run as a non-root user for security
USER node

CMD ["node", "dist/index.js"]
