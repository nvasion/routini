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

# Nginx config: nginx.conf (Compose) serves the app and reverse-proxies /api,
# /mcp and /health to the "server" service; nginx.platform.conf serves the app
# only, for platforms whose router sends those paths to the API itself.
ARG NGINX_CONF=nginx.conf
COPY ${NGINX_CONF} /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
