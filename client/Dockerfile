# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy all source files and build
COPY . .
RUN npm run build

# ── Stage 2: serve with nginx ─────────────────────────────────────────────────
FROM nginx:stable-alpine AS runtime

# Copy compiled assets
COPY --from=build /app/dist /usr/share/nginx/html

# Nginx config handles SPA routing and reverse-proxies /api and /health
# to the "server" Docker Compose service
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
