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

EXPOSE 3001

# Run as a non-root user for security
USER node

CMD ["node", "dist/index.js"]
